import websocket from "@fastify/websocket";
import middie from "@fastify/middie";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(rootDir, "..");

const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number.parseInt(process.env.PORT || "9011", 10);
const CODEX_BIN = process.env.CODEX_BIN || "/Applications/Codex.app/Contents/Resources/codex";
const BRIDGE_POLICY = process.env.BRIDGE_POLICY || "filtered";
const DEFAULT_THREAD_CWD = process.env.CODEX_THREAD_CWD || repoRoot;
const BASE_PATH = normalizeBasePath(process.env.CODEX_BRIDGE_BASE_PATH || "/");
const LOCK_PATH = path.join(os.tmpdir(), "codex-web-bridge.lock");
const SHUTDOWN_INTERRUPT_WAIT_MS = Number.parseInt(process.env.SHUTDOWN_INTERRUPT_WAIT_MS || "8000", 10);
const CHILD_STDIN_CLOSE_WAIT_MS = Number.parseInt(process.env.CHILD_STDIN_CLOSE_WAIT_MS || "2500", 10);
const CHILD_SIGTERM_WAIT_MS = Number.parseInt(process.env.CHILD_SIGTERM_WAIT_MS || "3000", 10);

const CHAT_SAFE_METHODS = new Set([
  "initialize",
  "initialized",
  "thread/list",
  "thread/loaded/list",
  "thread/read",
  "thread/turns/list",
  "thread/resume",
  "thread/start",
  "thread/unsubscribe",
  "turn/start",
  "turn/interrupt",
  "bridge/pendingServerRequests",
  "model/list",
  "account/read",
  "account/rateLimits/read",
  "config/read",
  "configRequirements/read",
  "collaborationMode/list",
  "experimentalFeature/list",
]);

const SERVER_REQUEST_RESPONSE_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
  "item/permissions/requestApproval",
  "mcpServer/elicitation/request",
  "item/tool/call",
  "account/chatgptAuthTokens/refresh",
  "applyPatchApproval",
  "execCommandApproval",
]);

const DANGEROUS_METHOD_PREFIXES = [
  "fs/write",
  "fs/remove",
  "fs/copy",
  "config/value/write",
  "config/batchWrite",
  "skills/config/write",
  "plugin/install",
  "plugin/uninstall",
  "marketplace/add",
  "marketplace/remove",
  "marketplace/upgrade",
  "account/logout",
  "command/exec",
  "mcpServer/tool/call",
  "thread/inject_items",
  "memory/reset",
];

const CUSTOM_ALLOW_METHODS = new Set(
  (process.env.BRIDGE_ALLOW_METHODS || "")
    .split(",")
    .map((method) => method.trim())
    .filter(Boolean)
);

let lockFd = null;
let appServer = null;
let stdoutBuffer = "";
let requestSeq = 0;
let clientSeq = 0;
let shuttingDown = false;
let vite = null;
let initializeResult = null;
let initializedNotificationForwarded = false;
let initializeUpstreamId = null;
const queuedInitializeClients = [];

const clients = new Map();
const pendingClientRequests = new Map();
const pendingServerRequests = new Map();
const activeTurns = new Map();

async function main() {
  acquireLock();
  ensureCodexBinary();

  appServer = startAppServer();
  const app = Fastify({ logger: false });

  await app.register(websocket);
  await registerRoutes(app);

  app.listen({ host: HOST, port: PORT }, (error, address) => {
    if (error) {
      console.error(error);
      void shutdown("listen-error", 1);
      return;
    }
    console.log(`[bridge] listening ${address}`);
    console.log(`[bridge] policy=${BRIDGE_POLICY} codex=${CODEX_BIN}`);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      void shutdown(signal, 0);
    });
  }

  process.once("uncaughtException", (error) => {
    console.error("[bridge] uncaught exception", error);
    void shutdown("uncaughtException", 1);
  });
  process.once("unhandledRejection", (reason) => {
    console.error("[bridge] unhandled rejection", reason);
    void shutdown("unhandledRejection", 1);
  });
  process.once("exit", () => {
    releaseLock();
    if (appServer && appServer.exitCode == null && !appServer.killed) {
      appServer.kill("SIGTERM");
    }
  });
}

function acquireLock() {
  try {
    lockFd = fs.openSync(LOCK_PATH, "wx");
    fs.writeFileSync(lockFd, `${process.pid}\n`);
    return;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  const existingPid = readExistingLockPid();
  if (existingPid && isProcessAlive(existingPid)) {
    throw new Error(`Another codex-web-bridge appears to be running at pid ${existingPid}. Lock: ${LOCK_PATH}`);
  }

  fs.rmSync(LOCK_PATH, { force: true });
  lockFd = fs.openSync(LOCK_PATH, "wx");
  fs.writeFileSync(lockFd, `${process.pid}\n`);
}

function readExistingLockPid() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf8").trim();
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function releaseLock() {
  if (lockFd != null) {
    try {
      fs.closeSync(lockFd);
    } catch {
      // Best effort cleanup.
    }
    lockFd = null;
  }
  try {
    const existingPid = readExistingLockPid();
    if (!existingPid || existingPid === process.pid) {
      fs.rmSync(LOCK_PATH, { force: true });
    }
  } catch {
    // Best effort cleanup.
  }
}

function ensureCodexBinary() {
  let stat;
  try {
    stat = fs.statSync(CODEX_BIN);
  } catch {
    throw new Error(`Codex app-server binary not found: ${CODEX_BIN}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Codex app-server path is not a file: ${CODEX_BIN}`);
  }

  try {
    fs.accessSync(CODEX_BIN, fs.constants.X_OK);
  } catch {
    throw new Error(`Codex app-server binary is not executable: ${CODEX_BIN}`);
  }
}

function startAppServer() {
  const env = { ...process.env };
  delete env.CODEX_HOME;

  const child = spawn(CODEX_BIN, ["app-server"], {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", handleAppServerStdout);
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.split("\n")) {
      if (line.trim()) {
        console.error(`[codex] ${line}`);
      }
    }
  });
  child.on("exit", (code, signal) => {
    console.log(`[bridge] codex app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    broadcast({ method: "bridge/appServerExited", params: { code, signal } });
    if (!shuttingDown) {
      void shutdown("app-server-exit", 1);
    }
  });
  child.on("error", (error) => {
    console.error("[bridge] failed to start codex app-server", error);
    if (!shuttingDown) {
      void shutdown("app-server-error", 1);
    }
  });

  return child;
}

async function registerRoutes(app) {
  for (const url of routeVariants("/health")) {
    app.get(url, async () => ({
      ok: !shuttingDown,
      policy: BRIDGE_POLICY,
      clients: clients.size,
      activeTurns: activeTurns.size,
      pendingServerRequests: pendingServerRequests.size,
    }));
  }

  for (const url of routeVariants("/config")) {
    app.get(url, async () => ({
      policy: BRIDGE_POLICY,
      defaultThreadCwd: DEFAULT_THREAD_CWD,
    }));
  }

  for (const url of routeVariants("/rpc")) {
    app.route({
      method: "GET",
      url,
      handler: async (_request, reply) => {
        reply.code(426).send({ error: "WebSocket upgrade required." });
      },
      wsHandler: handleRpcSocket,
    });
  }

  if (process.env.NODE_ENV === "production") {
    await app.register(fastifyStatic, {
      root: path.join(rootDir, "dist"),
      prefix: "/",
    });
    for (const url of routeVariants("/chat")) {
      app.get(url, async (_request, reply) => reply.sendFile("index.html"));
    }
    for (const url of routeVariants("/playground")) {
      app.get(url, async (_request, reply) => reply.sendFile("index.html"));
    }
  } else {
    await app.register(middie);
    vite = await createViteServer({
      root: rootDir,
      server: {
        allowedHosts: true,
        middlewareMode: true,
      },
      appType: "spa",
    });
    app.use((request, response, next) => {
      const url = request.url || "";
      if (routeVariants("/rpc").some((prefix) => url.startsWith(prefix))
        || routeVariants("/health").some((prefix) => url.startsWith(prefix))
        || routeVariants("/config").some((prefix) => url.startsWith(prefix))) {
        next();
        return;
      }
      vite.middlewares(request, response, next);
    });
  }
}

function handleRpcSocket(socket) {
  const clientId = `client-${++clientSeq}`;
  clients.set(clientId, socket);
  safeSend(socket, {
    method: "bridge/connected",
    params: {
      clientId,
      policy: BRIDGE_POLICY,
      defaultThreadCwd: DEFAULT_THREAD_CWD,
    },
  });

  socket.on("message", (raw) => {
    if (shuttingDown) {
      sendError(socket, null, -32000, "Bridge is shutting down.");
      return;
    }
    handleClientMessage(clientId, socket, raw.toString("utf8"));
  });
  socket.on("close", () => {
    clients.delete(clientId);
    for (const [upstreamId, route] of Array.from(pendingClientRequests.entries())) {
      if (route.clientId === clientId) {
        pendingClientRequests.delete(upstreamId);
      }
    }
  });
}

function normalizeBasePath(value) {
  const raw = String(value || "/");
  if (!raw || raw === "/") return "/";
  return `/${raw.replace(/^\/+|\/+$/g, "")}`;
}

function routeVariants(pathname) {
  if (BASE_PATH === "/") return [pathname];
  return [pathname, `${BASE_PATH}${pathname}`];
}

function handleClientMessage(clientId, socket, rawMessage) {
  const parsed = parseJson(rawMessage);
  if (!parsed) {
    sendError(socket, null, -32700, "Invalid JSON.");
    return;
  }

  const policy = authorizeClientMessage(parsed);
  audit({ clientId, message: parsed, decision: policy.allow ? "allow" : "deny", reason: policy.reason });
  if (!policy.allow) {
    sendError(socket, parsed.id ?? null, -32001, policy.reason);
    return;
  }

  if (isResponse(parsed)) {
    if (tryForward(socket, parsed)) {
      pendingServerRequests.delete(String(parsed.id));
    }
    return;
  }

  if (isNotification(parsed)) {
    if (parsed.method === "initialized" && initializedNotificationForwarded) {
      return;
    }
    if (parsed.method === "initialized") {
      initializedNotificationForwarded = true;
    }
    tryForward(socket, parsed);
    return;
  }

  if (!isRequest(parsed)) {
    sendError(socket, parsed.id ?? null, -32600, "Expected a JSON-RPC request, response, or notification.");
    return;
  }

  if (parsed.method === "bridge/pendingServerRequests") {
    safeSend(socket, {
      id: parsed.id,
      result: {
        data: Array.from(pendingServerRequests.values()).map(({ message, createdAt }) => ({
          ...message,
          createdAt,
        })),
      },
    });
    return;
  }

  if (parsed.method === "initialize" && initializeResult) {
    safeSend(socket, {
      id: parsed.id,
      result: initializeResult,
    });
    return;
  }

  const upstreamId = `bridge:${clientId}:${++requestSeq}`;
  if (parsed.method === "initialize" && initializeUpstreamId) {
    queuedInitializeClients.push({
      clientId,
      clientRequestId: parsed.id,
    });
    return;
  }

  pendingClientRequests.set(upstreamId, {
    clientId,
    clientRequestId: parsed.id,
    method: parsed.method,
  });
  if (parsed.method === "initialize") {
    initializeUpstreamId = upstreamId;
  }
  if (!tryForward(socket, {
    ...parsed,
    id: upstreamId,
  })) {
    pendingClientRequests.delete(upstreamId);
  }
}

function authorizeClientMessage(message) {
  if (BRIDGE_POLICY === "dev") {
    return { allow: true, reason: "dev-policy" };
  }

  if (isResponse(message)) {
    if (pendingServerRequests.has(String(message.id))) {
      return { allow: true, reason: "server-request-response" };
    }
    return { allow: false, reason: "response id is not a pending server request" };
  }

  if (isNotification(message)) {
    return CHAT_SAFE_METHODS.has(message.method) || CUSTOM_ALLOW_METHODS.has(message.method)
      ? { allow: true, reason: "allowed-notification" }
      : { allow: false, reason: `notification method blocked by policy: ${message.method}` };
  }

  if (!isRequest(message)) {
    return { allow: false, reason: "invalid JSON-RPC shape" };
  }

  if (CUSTOM_ALLOW_METHODS.has(message.method)) {
    return { allow: true, reason: "custom-allowlist" };
  }

  if (CHAT_SAFE_METHODS.has(message.method)) {
    return { allow: true, reason: "chat-allowlist" };
  }

  if (DANGEROUS_METHOD_PREFIXES.some((prefix) => message.method.startsWith(prefix))) {
    return { allow: false, reason: `dangerous method blocked by policy: ${message.method}` };
  }

  return { allow: false, reason: `method blocked by filtered policy: ${message.method}` };
}

function handleAppServerStdout(chunk) {
  stdoutBuffer += chunk;
  const lines = stdoutBuffer.split("\n");
  stdoutBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const message = parseJson(trimmed);
    if (!message) {
      console.warn(`[bridge] non-json app-server output: ${trimmed}`);
      continue;
    }
    routeAppServerMessage(message);
  }
}

function routeAppServerMessage(message) {
  observeServerMessage(message);

  if (isResponse(message)) {
    const upstreamId = String(message.id);
    const route = pendingClientRequests.get(upstreamId);
    if (route) {
      pendingClientRequests.delete(upstreamId);
      if (route.method === "initialize" && !message.error) {
        initializeResult = message.result ?? {};
      }
      if (route.method === "initialize") {
        initializeUpstreamId = null;
      }
      const client = clients.get(route.clientId);
      if (client) {
        safeSend(client, {
          ...message,
          id: route.clientRequestId,
        });
      }
      if (route.method === "initialize") {
        flushQueuedInitializeClients(message);
      }
      return;
    }
  }

  if (isServerRequest(message)) {
    pendingServerRequests.set(String(message.id), {
      message,
      createdAt: Date.now(),
    });
  }

  broadcast(message);
}

function observeServerMessage(message) {
  if (!message || typeof message !== "object") {
    return;
  }

  if (message.method === "turn/started") {
    const threadId = message.params?.threadId;
    const turnId = message.params?.turnId || message.params?.turn?.id;
    if (threadId && turnId) {
      activeTurns.set(`${threadId}:${turnId}`, { threadId, turnId });
    }
  }

  if (message.method === "turn/completed") {
    const threadId = message.params?.threadId;
    const turnId = message.params?.turnId || message.params?.turn?.id;
    if (threadId && turnId) {
      activeTurns.delete(`${threadId}:${turnId}`);
    }
  }

  if (message.method === "thread/status/changed") {
    const threadId = message.params?.threadId;
    const turnId = message.params?.turnId || message.params?.turn?.id;
    const status = message.params?.status || message.params?.turn?.status;
    if (threadId && turnId && ["completed", "failed", "interrupted"].includes(status)) {
      activeTurns.delete(`${threadId}:${turnId}`);
    }
  }

  if (message.method === "serverRequest/resolved") {
    const requestId = message.params?.requestId;
    if (requestId != null) {
      pendingServerRequests.delete(String(requestId));
    }
  }
}

function isRequest(message) {
  return message
    && typeof message === "object"
    && Object.prototype.hasOwnProperty.call(message, "id")
    && typeof message.method === "string";
}

function isNotification(message) {
  return message
    && typeof message === "object"
    && !Object.prototype.hasOwnProperty.call(message, "id")
    && typeof message.method === "string";
}

function isResponse(message) {
  return message
    && typeof message === "object"
    && Object.prototype.hasOwnProperty.call(message, "id")
    && !Object.prototype.hasOwnProperty.call(message, "method")
    && (
      Object.prototype.hasOwnProperty.call(message, "result")
      || Object.prototype.hasOwnProperty.call(message, "error")
    );
}

function isServerRequest(message) {
  return isRequest(message) && SERVER_REQUEST_RESPONSE_METHODS.has(message.method);
}

function parseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function writeToAppServer(message) {
  if (!appServer || appServer.killed || !appServer.stdin.writable) {
    throw new Error("Codex app-server is not writable.");
  }
  appServer.stdin.write(`${JSON.stringify(message)}\n`);
}

function tryForward(socket, message) {
  try {
    writeToAppServer(message);
    return true;
  } catch (error) {
    sendError(socket, message?.id ?? null, -32002, error.message);
    return false;
  }
}

function broadcast(message) {
  for (const socket of clients.values()) {
    safeSend(socket, message);
  }
}

function sendError(socket, id, code, message) {
  safeSend(socket, {
    id,
    error: { code, message },
  });
}

function safeSend(socket, message) {
  if (!socket || typeof socket.send !== "function" || socket.readyState !== 1) {
    return false;
  }
  socket.send(JSON.stringify(message));
  return true;
}

function flushQueuedInitializeClients(message) {
  const queued = queuedInitializeClients.splice(0);
  for (const route of queued) {
    const client = clients.get(route.clientId);
    if (!client) {
      continue;
    }
    safeSend(client, {
      ...message,
      id: route.clientRequestId,
    });
  }
}

function audit({ clientId, message, decision, reason }) {
  const entry = {
    ts: new Date().toISOString(),
    clientId,
    id: message?.id ?? null,
    method: message?.method ?? (isResponse(message) ? "<response>" : "<unknown>"),
    decision,
    reason,
  };
  console.log(`[audit] ${JSON.stringify(entry)}`);
}

async function shutdown(reason, exitCode) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`[bridge] shutdown started reason=${reason}`);
  broadcast({ method: "bridge/shutdown", params: { reason } });

  await interruptActiveTurns();
  await waitForActiveTurns(SHUTDOWN_INTERRUPT_WAIT_MS);

  for (const socket of clients.values()) {
    try {
      socket.close();
    } catch {
      // Best effort.
    }
  }
  clients.clear();

  if (vite) {
    await vite.close();
  }

  await stopAppServer();
  releaseLock();
  console.log("[bridge] shutdown complete");
  process.exitCode = exitCode;
  if (exitCode !== undefined) {
    process.exit(exitCode);
  }
}

async function interruptActiveTurns() {
  for (const { threadId, turnId } of activeTurns.values()) {
    try {
      writeToAppServer({
        id: `bridge:shutdown:interrupt:${threadId}:${turnId}`,
        method: "turn/interrupt",
        params: { threadId, turnId },
      });
      console.log(`[bridge] requested turn interrupt thread=${threadId} turn=${turnId}`);
    } catch (error) {
      console.warn(`[bridge] failed to interrupt turn ${threadId}:${turnId}: ${error.message}`);
    }
  }
}

async function waitForActiveTurns(timeoutMs) {
  if (activeTurns.size === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (activeTurns.size === 0) {
      return;
    }
    await delay(100);
  }
  console.warn(`[bridge] ${activeTurns.size} active turn(s) still tracked after interrupt wait`);
}

async function stopAppServer() {
  if (!appServer || appServer.exitCode != null || appServer.killed) {
    return;
  }

  try {
    appServer.stdin.end();
  } catch {
    // Continue to signal fallback.
  }

  if (await waitForChildExit(appServer, CHILD_STDIN_CLOSE_WAIT_MS)) {
    return;
  }

  console.warn("[bridge] app-server did not exit after stdin close; sending SIGTERM");
  appServer.kill("SIGTERM");
  if (await waitForChildExit(appServer, CHILD_SIGTERM_WAIT_MS)) {
    return;
  }

  console.warn("[bridge] app-server did not exit after SIGTERM; sending SIGKILL");
  appServer.kill("SIGKILL");
  await waitForChildExit(appServer, 1000);
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode != null) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(child.exitCode != null);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error("[bridge] startup failed", error);
  releaseLock();
  process.exit(1);
});
