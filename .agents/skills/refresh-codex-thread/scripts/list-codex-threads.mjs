#!/usr/bin/env node
import WebSocket from "ws";

const url = process.env.CODEX_BRIDGE_RPC_URL || "ws://127.0.0.1:9011/rpc";
const socket = new WebSocket(url);
let nextId = 1;
const pending = new Map();

function request(method, params) {
  const id = `thread-list-${nextId++}`;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  const waiter = pending.get(String(message.id));
  if (!waiter) return;
  pending.delete(String(message.id));
  if (message.error) {
    waiter.reject(new Error(message.error.message || "RPC error"));
  } else {
    waiter.resolve(message.result);
  }
});

socket.once("open", async () => {
  try {
    await request("initialize", {
      clientInfo: { name: "codex-thread-selector", title: "Codex Thread Selector", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    socket.send(JSON.stringify({ method: "initialized" }));
    const result = await request("thread/list", {
      limit: 50,
      archived: false,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: [],
    });
    process.stdout.write(JSON.stringify(result?.data || []));
    socket.close();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    socket.close();
  }
});

socket.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
