import * as Collapsible from "@radix-ui/react-collapsible";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Clock,
  FileDiff,
  Folder,
  Image,
  LoaderCircle,
  Menu,
  Moon,
  Cpu,
  PanelLeft,
  Paperclip,
  Plus,
  Search,
  Send,
  SlidersHorizontal,
  ShieldCheck,
  ShieldX,
  Square,
  Sun,
  Terminal,
  User,
  XCircle,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import TextareaAutosize from "react-textarea-autosize";
import { Streamdown } from "streamdown";
import "streamdown/styles.css";
import "./styles.css";

const STORAGE_THREAD_ID = "codexBridge.activeThreadId";
const STORAGE_WORKSPACE_CWD = "codexBridge.newThreadCwd";
const STORAGE_PERMISSION_MODE = "codexBridge.permissionMode";
const STORAGE_THEME = "codexBridge.theme";
const APP_BASE_PATH = normalizeBasePath(import.meta.env.BASE_URL);
const PERMISSION_MODES = {
  default: {
    id: "default",
    label: "Default",
    sandbox: "read-only",
    approvalPolicy: "on-request",
    description: "Read-only until you approve changes or commands.",
  },
  auto: {
    id: "auto",
    label: "Auto",
    sandbox: "workspace-write",
    approvalPolicy: "on-request",
    description: "Can edit the workspace and asks before risky actions.",
  },
  fullAccess: {
    id: "fullAccess",
    label: "Full Access",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    description: "Runs without sandbox or approval prompts.",
  },
};
const DEFAULT_PERMISSION_MODE = "default";
const RECONNECT_BASE_DELAY_MS = 750;
const RECONNECT_MAX_DELAY_MS = 10_000;

function App() {
  const [theme, setTheme] = useThemePreference();

  if (appRoutePath() === "/playground") {
    return <ComponentPlayground onThemeChange={setTheme} theme={theme} />;
  }

  const rpcRef = useRef(null);
  const timelineRef = useRef(null);
  const composerInputRef = useRef(null);
  const activeThreadIdRef = useRef(localStorage.getItem(STORAGE_THREAD_ID) || "");
  const activeTurnIdRef = useRef("");
  const activeLocalTurnIdRef = useRef("");
  const assistantItemIdRef = useRef("");
  const commandItemIdRef = useRef("");
  const activeModelRef = useRef("");
  const activeEffortRef = useRef("");
  const modelOverridePendingRef = useRef(false);
  const modelsRef = useRef([]);
  const activeThreadTurnIdsRef = useRef(new Map());
  const threadSelectionTokenRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const reconnectAttemptRef = useRef(0);

  const [defaultThreadCwd, setDefaultThreadCwd] = useState("");
  const [newThreadCwd, setNewThreadCwdState] = useState(localStorage.getItem(STORAGE_WORKSPACE_CWD) || "");
  const [permissionMode, setPermissionModeState] = useState(readStoredPermissionMode);
  const [activeThreadId, setActiveThreadIdState] = useState(activeThreadIdRef.current);
  const [models, setModels] = useState([]);
  const [activeModel, setActiveModelState] = useState("");
  const [activeEffort, setActiveEffortState] = useState("");
  const [modelSource, setModelSource] = useState("loading");
  const [modelOverridePending, setModelOverridePending] = useState(false);
  const [activeTurnId, setActiveTurnIdState] = useState("");
  const [threads, setThreads] = useState([]);
  const [turns, setTurns] = useState([]);
  const [pendingInteractions, setPendingInteractions] = useState([]);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [statusText, setStatusText] = useState("Connecting");
  const [statusError, setStatusError] = useState("");
  const [prompt, setPrompt] = useState("");
  const [threadQuery, setThreadQuery] = useState("");
  const [threadSheetOpen, setThreadSheetOpen] = useState(false);
  const [composerHighlighted, setComposerHighlighted] = useState(false);
  const [isTimelineAtBottom, setIsTimelineAtBottom] = useState(true);

  useEffect(() => {
    let cancelled = false;

    function scheduleReconnect() {
      if (cancelled || reconnectTimerRef.current) return;
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(RECONNECT_BASE_DELAY_MS * 2 ** attempt, RECONNECT_MAX_DELAY_MS);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect().catch(handleConnectError);
      }, delay);
    }

    function handleConnectError(error) {
      if (cancelled) return;
      setConnected(false);
      setBusy(false);
      setStatusText("Disconnected");
      setStatusError(error.message);
      scheduleReconnect();
    }

    async function connect() {
      setStatusText(reconnectAttemptRef.current > 0 ? "Reconnecting" : "Connecting");
      const rpc = new RpcClient(wsUrl("rpc"));
      rpcRef.current = rpc;
      rpc.onNotification = handleNotification;
      rpc.onClose = () => {
        if (rpcRef.current !== rpc || cancelled) return;
        setConnected(false);
        setBusy(false);
        setStatusText("Disconnected");
        scheduleReconnect();
      };

      await rpc.open();
      if (cancelled) return;
      reconnectAttemptRef.current = 0;
      setConnected(true);
      setStatusError("");

      const config = await fetch(appUrl("config")).then((response) => response.json());
      const configuredCwd = config.defaultThreadCwd || "";
      setDefaultThreadCwd(configuredCwd);
      setNewThreadCwdState((current) => current || configuredCwd);

      await rpc.request("initialize", {
        clientInfo: {
          name: "codex-web-bridge",
          title: "Codex Web Bridge",
          version: "0.1.0",
        },
        capabilities: {
          experimentalApi: true,
        },
      });
      rpc.notify("initialized");

      setStatusText("Connected");
      await loadModelOptions(rpc, configuredCwd);
      await loadThreads(rpc);
      if (activeThreadIdRef.current) {
        await selectThread(activeThreadIdRef.current, { silentMissing: true, rpcOverride: rpc });
      }
      await loadPendingServerRequests(rpc);
    }

    connect().catch(handleConnectError);

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      rpcRef.current?.close();
    };
  }, []);

  function setActiveThreadId(threadId) {
    activeThreadIdRef.current = threadId;
    setActiveThreadIdState(threadId);
    if (threadId) {
      localStorage.setItem(STORAGE_THREAD_ID, threadId);
    } else {
      localStorage.removeItem(STORAGE_THREAD_ID);
    }
  }

  function setNewThreadCwd(value) {
    setNewThreadCwdState(value);
    const trimmed = value.trim();
    if (trimmed) {
      localStorage.setItem(STORAGE_WORKSPACE_CWD, trimmed);
    } else {
      localStorage.removeItem(STORAGE_WORKSPACE_CWD);
    }
    if (!activeThreadIdRef.current && !modelOverridePendingRef.current) {
      void loadModelOptions(undefined, trimmed || defaultThreadCwd);
    }
  }

  function setPermissionMode(mode) {
    const nextMode = PERMISSION_MODES[mode] ? mode : DEFAULT_PERMISSION_MODE;
    setPermissionModeState(nextMode);
    localStorage.setItem(STORAGE_PERMISSION_MODE, nextMode);
  }

  function setActiveTurnId(turnId) {
    activeTurnIdRef.current = turnId;
    setActiveTurnIdState(turnId);
  }

  function registerActiveThreadTurn(threadId, turnId) {
    if (!threadId || !turnId) return;
    activeThreadTurnIdsRef.current.set(threadId, turnId);
  }

  function unregisterActiveThreadTurn(threadId, turnId) {
    if (!threadId || !turnId) return;
    if (activeThreadTurnIdsRef.current.get(threadId) === turnId) {
      activeThreadTurnIdsRef.current.delete(threadId);
    }
  }

  function getActiveThreadTurnId(threadId) {
    return threadId ? activeThreadTurnIdsRef.current.get(threadId) || "" : "";
  }

  function setActiveModel(model, source = "runtime", effort) {
    activeModelRef.current = model || "";
    setActiveModelState(model || "");
    if (effort !== undefined) {
      activeEffortRef.current = effort || "";
      setActiveEffortState(effort || "");
    }
    setModelSource(source);
  }

  function setModelOverride(selection) {
    const parsed = parseModelSelection(selection);
    modelOverridePendingRef.current = true;
    setModelOverridePending(true);
    setActiveModel(parsed.model, "override", parsed.effort);
  }

  function clearModelOverridePending() {
    modelOverridePendingRef.current = false;
    setModelOverridePending(false);
  }

  async function loadModelOptions(rpcOverride, cwdOverride) {
    const rpc = rpcOverride || rpcRef.current;
    if (!rpc) return;

    try {
      const [modelResponse, configResponse] = await Promise.all([
        rpc.request("model/list", { includeHidden: false, limit: 100 }),
        rpc.request("config/read", {
          includeLayers: false,
          cwd: cwdOverride || newThreadCwd || defaultThreadCwd || null,
        }),
      ]);
      const nextModels = Array.isArray(modelResponse?.data) ? modelResponse.data : [];
      modelsRef.current = nextModels;
      setModels(nextModels);
      if (!modelOverridePendingRef.current) {
        const configuredModel = configResponse?.config?.model || "";
        const defaultModel = nextModels.find((model) => model.isDefault)?.model || nextModels[0]?.model || "";
        const selectedModel = configuredModel || defaultModel;
        const selectedModelMeta = findModel(nextModels, selectedModel);
        const configuredEffort = configResponse?.config?.model_reasoning_effort || "";
        const selectedEffort = normalizeEffortForModel(selectedModelMeta, configuredEffort);
        setActiveModel(selectedModel, configuredModel ? "configured" : "default", selectedEffort);
      }
    } catch (error) {
      setStatusError(error.message);
      setModelSource("error");
    }
  }

  async function loadThreads(rpcOverride) {
    const rpc = rpcOverride || rpcRef.current;
    if (!rpc) return;

    try {
      const response = await rpc.request("thread/list", {
        limit: 50,
        archived: false,
        sortKey: "updated_at",
        sortDirection: "desc",
        sourceKinds: [],
      });
      setThreads(Array.isArray(response?.data) ? response.data : []);
    } catch (error) {
      setStatusError(error.message);
    }
  }

  async function loadPendingServerRequests(rpcOverride) {
    const rpc = rpcOverride || rpcRef.current;
    if (!rpc) return;

    try {
      const response = await rpc.request("bridge/pendingServerRequests", {});
      reconcilePendingServerRequests(response?.data);
    } catch (error) {
      setStatusError(error.message);
    }
  }

  async function selectThread(threadId, { silentMissing = false, rpcOverride } = {}) {
    if (!threadId) return;
    const rpc = rpcOverride || rpcRef.current;
    if (!rpc) return;
    const selectionToken = ++threadSelectionTokenRef.current;
    const isCurrentSelection = () =>
      threadSelectionTokenRef.current === selectionToken && activeThreadIdRef.current === threadId;

    try {
      setActiveThreadId(threadId);
      setActiveTurnId("");
      setBusy(false);
      activeLocalTurnIdRef.current = "";
      assistantItemIdRef.current = "";
      commandItemIdRef.current = "";
      clearModelOverridePending();
      const resumed = await rpc.request("thread/resume", {
        threadId,
        excludeTurns: true,
        persistExtendedHistory: true,
      });
      if (!isCurrentSelection()) return;
      setActiveModel(resumed?.model || "", "thread", resumed?.reasoningEffort || "");
      const response = await rpc.request("thread/read", {
        threadId,
        includeTurns: true,
      });
      if (!isCurrentSelection()) return;
      setTurns(threadToTurns(response?.thread));
      await loadPendingServerRequests(rpc);
      if (!isCurrentSelection()) return;
      setStatusText("Thread loaded");
      setStatusError("");
      setThreadSheetOpen(false);
    } catch (error) {
      if (!isCurrentSelection()) return;
      if (!silentMissing) {
        setStatusError(error.message);
      }
    }
  }

  function startNewThread() {
    threadSelectionTokenRef.current += 1;
    setActiveThreadId("");
    setActiveTurnId("");
    setBusy(false);
    activeLocalTurnIdRef.current = "";
    assistantItemIdRef.current = "";
    commandItemIdRef.current = "";
    clearModelOverridePending();
    setTurns([]);
    setStatusText("New thread");
    setStatusError("");
    setThreadSheetOpen(false);
    void loadModelOptions(undefined, newThreadCwd || defaultThreadCwd);
  }

  function scrollToComposer({ behavior = "auto" } = {}) {
    const timeline = timelineRef.current;
    if (timeline) {
      timeline.scrollTo({
        top: timeline.scrollHeight,
        behavior,
      });
      window.requestAnimationFrame(() => {
        timeline.scrollTop = timeline.scrollHeight;
      });
    }
    composerInputRef.current?.focus();
    setComposerHighlighted(true);
    window.setTimeout(() => setComposerHighlighted(false), 900);
  }

  async function sendPrompt(event) {
    event.preventDefault();
    const text = prompt.trim();
    const rpc = rpcRef.current;
    if (!text || busy || !connected || !rpc) return;

    const localTurnId = createLocalId("turn");
    const assistantItemId = createLocalId("assistant");
    activeLocalTurnIdRef.current = localTurnId;
    assistantItemIdRef.current = assistantItemId;
    commandItemIdRef.current = "";

    setPrompt("");
    setBusy(true);
    setStatusError("");
    setStatusText("Running");
    setTurns((current) => [
      ...current,
      {
        id: localTurnId,
        userInput: text,
        items: [{ id: assistantItemId, type: "assistant", text: "", streaming: true }],
        status: "running",
      },
    ]);

    try {
      let threadId = activeThreadIdRef.current;
      if (!threadId) {
        const permission = PERMISSION_MODES[permissionMode] || PERMISSION_MODES[DEFAULT_PERMISSION_MODE];
        const started = await rpc.request("thread/start", {
          cwd: newThreadCwd.trim() || defaultThreadCwd,
          approvalPolicy: permission.approvalPolicy,
          experimentalRawEvents: false,
          ...(modelOverridePendingRef.current && activeModelRef.current ? { model: activeModelRef.current } : {}),
          persistExtendedHistory: true,
          sandbox: permission.sandbox,
        });
        setActiveModel(started?.model || activeModelRef.current, "thread", activeEffortRef.current || started?.reasoningEffort || "");
        threadId = started?.thread?.id || "";
        if (threadId) {
          setActiveThreadId(threadId);
        }
      } else {
        const resumed = await rpc.request("thread/resume", {
          threadId,
          excludeTurns: true,
          persistExtendedHistory: true,
        });
        if (!modelOverridePendingRef.current) {
          setActiveModel(resumed?.model || activeModelRef.current, "thread", resumed?.reasoningEffort || activeEffortRef.current);
        }
      }

      await rpc.request("turn/start", {
        threadId,
        ...(modelOverridePendingRef.current && activeModelRef.current ? { model: activeModelRef.current } : {}),
        ...(modelOverridePendingRef.current && activeEffortRef.current ? { effort: activeEffortRef.current } : {}),
        input: [
          {
            type: "text",
            text,
            text_elements: [],
          },
        ],
      });
      if (modelOverridePendingRef.current) {
        setActiveModel(activeModelRef.current, "thread", activeEffortRef.current);
        clearModelOverridePending();
      }
      await loadThreads();
    } catch (error) {
      setBusy(false);
      setStatusText("Error");
      setStatusError(error.message);
      appendItemToActive({ id: createLocalId("error"), type: "error", message: error.message });
    }
  }

  async function interruptTurn() {
    const rpc = rpcRef.current;
    if (!rpc || !activeThreadIdRef.current || !activeTurnIdRef.current) return;

    try {
      await rpc.request("turn/interrupt", {
        threadId: activeThreadIdRef.current,
        turnId: activeTurnIdRef.current,
      });
    } catch (error) {
      setStatusError(error.message);
    }
  }

  function isForActiveThread(params = {}) {
    const activeThreadId = activeThreadIdRef.current;
    const eventThreadId = notificationThreadId(params);
    return Boolean(eventThreadId && activeThreadId && eventThreadId === activeThreadId);
  }

  function isForActiveTurn(params = {}) {
    if (!isForActiveThread(params)) return false;
    const eventTurnId = notificationTurnId(params);
    const activeThreadId = activeThreadIdRef.current;
    const knownTurnId = getActiveThreadTurnId(activeThreadId);
    return Boolean(eventTurnId && knownTurnId && eventTurnId === knownTurnId);
  }

  function handleNotification(message) {
    const { method, params = {} } = message;
    if (method === "bridge/connected") {
      setStatusText("Connected");
      return;
    }

    if (method === "bridge/shutdown") {
      setStatusText("Bridge shutting down");
      setBusy(false);
      setPendingInteractions([]);
      return;
    }

    if (method === "bridge/appServerExited") {
      setStatusText("Codex app-server exited");
      setBusy(false);
      setPendingInteractions([]);
      return;
    }

    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      if (requestId != null) {
        removePendingInteraction(requestId);
      }
      return;
    }

    if (method === "thread/started") {
      const threadId = params.threadId || params.thread?.id;
      if (threadId) setActiveThreadId(threadId);
      return;
    }

    if (method === "turn/started") {
      if (!isForActiveThread(params)) return;
      const turnId = params.turnId || params.turn?.id || activeTurnIdRef.current;
      registerActiveThreadTurn(params.threadId, turnId);
      setActiveTurnId(turnId);
      setBusy(true);
      setStatusText("Running");
      updateActiveTurn((turn) => ({ ...turn, threadTurnId: turnId, status: "running" }));
      return;
    }

    if (method === "model/rerouted") {
      if (!isForActiveTurn(params)) return;
      if (params.toModel) {
        const nextModel = findModel(modelsRef.current, params.toModel);
        setActiveModel(params.toModel, "rerouted", normalizeEffortForModel(nextModel, activeEffortRef.current));
        clearModelOverridePending();
      }
      appendItemToActive({
        id: createLocalId("model-reroute"),
        type: "activity",
        activityType: "model",
        text: `Model rerouted from ${modelDisplayName(modelsRef.current, params.fromModel)} to ${modelDisplayName(modelsRef.current, params.toModel)}.`,
      });
      return;
    }

    if (method === "item/started" || method === "item/completed") {
      if (!isForActiveTurn(params)) return;
      upsertThreadItem(params.item, method === "item/started" ? "started" : "completed");
      return;
    }

    if (method === "item/agentMessage/delta") {
      if (!isForActiveTurn(params)) return;
      appendAssistantDelta(params);
      return;
    }

    if (method === "item/reasoning/summaryPartAdded") {
      if (!isForActiveTurn(params)) return;
      ensureReasoningSummaryPart(params);
      return;
    }

    if (method === "item/reasoning/summaryTextDelta") {
      if (!isForActiveTurn(params)) return;
      appendReasoningSummaryDelta(params);
      return;
    }

    if (method === "item/reasoning/textDelta") {
      if (!isForActiveTurn(params)) return;
      appendReasoningContentDelta(params);
      return;
    }

    if (method === "command/exec/outputDelta" || method === "item/commandExecution/outputDelta") {
      if (!isForActiveTurn(params)) return;
      appendCommandDelta(params);
      return;
    }

    if (method === "item/fileChange/outputDelta" || method === "item/fileChange/patchUpdated") {
      if (!isForActiveTurn(params)) return;
      ensureFileChangeItem(params);
      return;
    }

    if (isPendingInteractionMessage(message)) {
      rememberPendingInteraction(message);
    }

    if (method.includes("requestApproval")) {
      if (!isForActiveTurn(params)) return;
      appendApprovalRequest(message);
      return;
    }

    if (method.includes("commandExecution") && !method.includes("requestApproval")) {
      if (!isForActiveTurn(params)) return;
      ensureCommandItem(params);
      return;
    }

    if (method === "turn/completed") {
      if (!isForActiveTurn(params)) return;
      const completedTurnId = notificationTurnId(params);
      unregisterActiveThreadTurn(params.threadId, completedTurnId);
      setBusy(false);
      setActiveTurnId("");
      setStatusText("Idle");
      updateActiveTurn((turn) => ({
        ...turn,
        status: "completed",
        items: turn.items.map((item) =>
          item.type === "assistant" ? { ...item, streaming: false } : item,
        ),
      }));
      void loadThreads();
      return;
    }

    if (method === "error" || method === "warning" || method === "guardianWarning") {
      if (!isForActiveThread(params)) return;
      appendItemToActive({
        id: createLocalId("error"),
        type: "error",
        message: params.message || JSON.stringify(params),
      });
    }
  }

  function respondToInteraction(interaction, response) {
    const rpc = rpcRef.current;
    if (!rpc || interaction?.responseId == null) return;

    rpc.respond(interaction.responseId, response);
    removePendingInteraction(interaction.responseId);
    setTurns((current) =>
      current.map((turn) => ({
        ...turn,
        items: turn.items.map((item) =>
          item.type === "approval" && item.responseId === interaction.responseId
            ? { ...item, status: response.decision, respondedAt: Date.now() }
            : item,
        ),
      })),
    );
  }

  function reconcilePendingServerRequests(messages = []) {
    const interactions = messages
      .filter(isPendingInteractionMessage)
      .map(pendingInteractionFromMessage)
      .filter(Boolean);
    setPendingInteractions(dedupePendingInteractions(interactions));
  }

  function removePendingInteraction(responseId) {
    const key = String(responseId);
    setPendingInteractions((current) => current.filter((item) => String(item.responseId) !== key));
  }

  function updateActiveTurn(updater) {
    const localTurnId = activeLocalTurnIdRef.current;
    const turnId = activeTurnIdRef.current;
    setTurns((current) => {
      const index = current.findIndex((turn) => turn.id === localTurnId || turn.threadTurnId === turnId);
      if (index === -1) {
        const nextTurn = updater({
          id: localTurnId || createLocalId("turn"),
          threadTurnId: turnId,
          userInput: "",
          items: [],
          status: "running",
        });
        activeLocalTurnIdRef.current = nextTurn.id;
        return [...current, nextTurn];
      }
      return current.map((turn, turnIndex) => (turnIndex === index ? updater(turn) : turn));
    });
  }

  function appendItemToActive(item) {
    updateActiveTurn((turn) => ({
      ...turn,
      items: [...turn.items, item],
    }));
  }

  function upsertItemToActive(nextItem) {
    if (!nextItem?.id) return;

    updateActiveTurn((turn) => {
      if (!turn.items.some((item) => item.id === nextItem.id)) {
        return {
          ...turn,
          items: [...turn.items, nextItem],
        };
      }

      return {
        ...turn,
        items: turn.items.map((item) => {
          if (item.id !== nextItem.id) return item;
          if (item.type === "fileChange" && nextItem.type === "fileChange") {
            return mergeFileChangeItems(item, nextItem);
          }
          if (item.type === "command" && nextItem.type === "command") {
            return mergeCommandItems(item, nextItem);
          }
          if (item.type === "assistant" && nextItem.type === "assistant") {
            return {
              ...item,
              ...nextItem,
              text: nextItem.text || item.text || "",
            };
          }
          if (
            item.type === "activity"
            && nextItem.type === "activity"
            && item.activityType === "reasoning"
            && nextItem.activityType === "reasoning"
          ) {
            return mergeReasoningActivityItems(item, nextItem);
          }
          return { ...item, ...nextItem };
        }),
      };
    });
  }

  function upsertThreadItem(item, lifecycle) {
    const nextItem = threadItemToTurnItem(item, lifecycle);
    if (!nextItem) return;
    if (nextItem.type === "assistant") {
      assistantItemIdRef.current = nextItem.id;
    }
    if (nextItem.type === "command") {
      commandItemIdRef.current = nextItem.id;
    }
    upsertItemToActive(nextItem);
  }

  function appendAssistantDelta(params = {}) {
    const delta = params.delta || "";
    if (!delta) return;

    updateActiveTurn((turn) => {
      let assistantItemId = params.itemId || assistantItemIdRef.current;
      let items = turn.items;
      if (!assistantItemId || !items.some((item) => item.id === assistantItemId)) {
        assistantItemId = assistantItemId || createLocalId("assistant");
        assistantItemIdRef.current = assistantItemId;
        items = [...items, { id: assistantItemId, type: "assistant", text: "", streaming: true }];
      }

      return {
        ...turn,
        items: items.map((item) =>
          item.id === assistantItemId ? { ...item, text: `${item.text || ""}${delta}` } : item,
        ),
      };
    });
  }

  function updateReasoningActivity(itemId, updater) {
    const reasoningItemId = itemId || createLocalId("reasoning");
    updateActiveTurn((turn) => {
      const existing = turn.items.find((item) => item.id === reasoningItemId);
      if (!existing) {
        return {
          ...turn,
          items: [
            ...turn.items,
            updater(createReasoningActivityItem(reasoningItemId)),
          ],
        };
      }

      return {
        ...turn,
        items: turn.items.map((item) =>
          item.id === reasoningItemId && item.type === "activity" && item.activityType === "reasoning"
            ? updater(item)
            : item,
        ),
      };
    });
  }

  /** @param {ReasoningSummaryPartAddedNotification} params */
  function ensureReasoningSummaryPart(params = {}) {
    updateReasoningActivity(params.itemId, (item) => {
      const summaryParts = [...(item.summaryParts || [])];
      const summaryIndex = reasoningPartIndex(params.summaryIndex, summaryParts.length);
      if (summaryParts[summaryIndex] == null) summaryParts[summaryIndex] = "";
      return reasoningActivityWithParts(item, summaryParts, item.contentParts || []);
    });
  }

  /** @param {ReasoningSummaryTextDeltaNotification} params */
  function appendReasoningSummaryDelta(params = {}) {
    const delta = params.delta || "";
    if (!delta) return;

    updateReasoningActivity(params.itemId, (item) => {
      const summaryParts = appendReasoningPartDelta(item.summaryParts, params.summaryIndex, delta);
      return reasoningActivityWithParts(item, summaryParts, item.contentParts || []);
    });
  }

  /** @param {ReasoningTextDeltaNotification} params */
  function appendReasoningContentDelta(params = {}) {
    const delta = params.delta || "";
    if (!delta) return;

    updateReasoningActivity(params.itemId, (item) => {
      const contentParts = appendReasoningPartDelta(item.contentParts, params.contentIndex, delta);
      return reasoningActivityWithParts(item, item.summaryParts || [], contentParts);
    });
  }

  function ensureCommandItem(params = {}) {
    const itemId = params.itemId || params.id || params.commandId || commandItemIdRef.current || createLocalId("command");
    commandItemIdRef.current = itemId;
    const nextCommand = commandItemFromParams({ ...params, id: itemId });

    updateActiveTurn((turn) => {
      if (turn.items.some((item) => item.id === itemId)) {
        return {
          ...turn,
          items: turn.items.map((item) =>
            item.id === itemId ? mergeCommandItems(item, nextCommand) : item,
          ),
        };
      }
      return {
        ...turn,
        items: [
          ...turn.items,
          nextCommand,
        ],
      };
    });

    return itemId;
  }

  function appendCommandDelta(params = {}) {
    const delta = params.delta || params.chunk || params.output || "";
    if (!delta) return;
    const itemId = ensureCommandItem(params);

    updateActiveTurn((turn) => ({
      ...turn,
      items: turn.items.map((item) =>
        item.id === itemId
          ? {
              ...item,
              command: item.command || normalizeCommand(params.command || params.cmd || params.argv),
              output: `${item.output || ""}${delta}`,
              stdout: `${item.stdout || ""}${delta}`,
              status: "running",
            }
          : item,
      ),
    }));
  }

  function appendApprovalRequest(message) {
    const item = approvalItemFromMessage(message);
    if (!item) return;
    rememberPendingInteraction(message);
    appendItemToActive(item);
  }

  function rememberPendingInteraction(message) {
    const item = pendingInteractionFromMessage(message);
    if (!item) return;
    setPendingInteractions((current) => dedupePendingInteractions([...current, item]));
  }

  function ensureFileChangeItem(params = {}) {
    const item = fileChangeItemFromParams(params);
    updateActiveTurn((turn) => {
      if (turn.items.some((existing) => existing.id === item.id)) {
        return {
          ...turn,
          items: turn.items.map((existing) => existing.id === item.id ? mergeFileChangeItems(existing, item) : existing),
        };
      }
      return {
        ...turn,
        items: [...turn.items, item],
      };
    });
  }

  const activeThread = useMemo(
    () => threads.find((thread) => thread.id === activeThreadId),
    [threads, activeThreadId],
  );
  const workspaceOptions = useMemo(() => {
    const seen = new Set();
    return [newThreadCwd, defaultThreadCwd, ...threads.map((thread) => thread.cwd)]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .filter((value) => !getCodexWorktreeInfo(value))
      .filter((value) => {
        const key = normalizePathKey(value);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [defaultThreadCwd, newThreadCwd, threads]);
  const workspaceCandidates = useMemo(
    () => workspaceOptions.length ? workspaceOptions : [newThreadCwd, defaultThreadCwd].filter(Boolean),
    [defaultThreadCwd, newThreadCwd, workspaceOptions],
  );
  const filteredThreads = useMemo(() => {
    const query = threadQuery.trim().toLowerCase();
    if (!query) return threads;
    return threads.filter((thread) =>
      [thread.name, thread.preview, thread.cwd, getThreadWorkspaceRoot(thread, workspaceCandidates), thread.id].some((value) =>
        String(value || "").toLowerCase().includes(query),
      ),
    );
  }, [threads, threadQuery, workspaceCandidates]);

  const status = statusError || statusText;
  const isErrorStatus = Boolean(statusError);

  return (
    <main className="h-dvh overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <div className="grid h-dvh lg:grid-cols-[320px_minmax(0,1fr)]">
        <ThreadSidebar
          activeThreadId={activeThreadId}
          filteredThreads={filteredThreads}
          isErrorStatus={isErrorStatus}
          onNewThread={startNewThread}
          onQueryChange={setThreadQuery}
          onSelectThread={selectThread}
          query={threadQuery}
          status={status}
          workspaceCandidates={workspaceCandidates}
        />

        <section className="flex h-dvh min-w-0 flex-col overflow-hidden">
          <ChatHeader
            activeThread={activeThread}
            activeThreadId={activeThreadId}
            activeTurnId={activeTurnId}
            busy={busy}
            connected={connected}
            onInterrupt={interruptTurn}
            onOpenThreads={() => setThreadSheetOpen(true)}
            onThemeChange={setTheme}
            status={status}
            statusError={statusError}
            theme={theme}
          />

          <Timeline
            activeThreadId={activeThreadId}
            busy={busy}
            isAtBottom={isTimelineAtBottom}
            newThreadCwd={newThreadCwd || defaultThreadCwd}
            defaultThreadCwd={defaultThreadCwd}
            onAtBottomChange={setIsTimelineAtBottom}
            onInteractionRespond={respondToInteraction}
            onJumpToComposer={scrollToComposer}
            onWorkspaceChange={setNewThreadCwd}
            pendingInteractions={pendingInteractions}
            ref={timelineRef}
            turns={turns}
            workspaceOptions={workspaceOptions}
          />

          <Composer
            busy={busy}
            highlighted={composerHighlighted}
            connected={connected}
            effort={activeEffort}
            inputRef={composerInputRef}
            model={activeModel}
            modelOverridePending={modelOverridePending}
            modelSource={modelSource}
            models={models}
            onChange={setPrompt}
            onModelChange={setModelOverride}
            onPermissionModeChange={setPermissionMode}
            onSubmit={sendPrompt}
            permissionMode={permissionMode}
            prompt={prompt}
          />
        </section>
      </div>

      <MobileThreadSheet
        activeThreadId={activeThreadId}
        filteredThreads={filteredThreads}
        isErrorStatus={isErrorStatus}
        onNewThread={startNewThread}
        onOpenChange={setThreadSheetOpen}
        onQueryChange={setThreadQuery}
        onSelectThread={selectThread}
        open={threadSheetOpen}
        query={threadQuery}
        status={status}
        workspaceCandidates={workspaceCandidates}
      />
    </main>
  );
}

function ComponentPlayground({ onThemeChange, theme }) {
  const [variant, setVariant] = useState("command");
  const [status, setStatus] = useState("pending");
  const [toolVariant, setToolVariant] = useState("success");
  const [decisionLog, setDecisionLog] = useState([]);
  const item = useMemo(() => playgroundApprovalItem(variant, status), [variant, status]);
  const toolItem = useMemo(() => playgroundCommandItem(toolVariant), [toolVariant]);
  const variants = [
    { id: "command", label: "Command" },
    { id: "fileChange", label: "File change" },
    { id: "permission", label: "Permission" },
    { id: "missingResponse", label: "Missing id" },
  ];
  const states = [
    { id: "pending", label: "Pending" },
    { id: "accept", label: "Approved" },
    { id: "decline", label: "Denied" },
  ];
  const toolStates = [
    { id: "success", label: "Success" },
    { id: "running", label: "Running" },
    { id: "failed", label: "Failed" },
  ];

  function handleApprovalResponse(responseId, decision) {
    const label = approvalDecisionLabel(decision);
    setStatus(label === "decline" ? "decline" : "accept");
    setDecisionLog((current) => [
      {
        id: createLocalId("decision"),
        responseId: responseId ?? "none",
        decision: label,
        at: new Date().toLocaleTimeString(),
      },
      ...current,
    ].slice(0, 5));
  }

  return (
    <main className="min-h-dvh bg-[var(--background)] text-[var(--foreground)]">
      <div className="playground-shell">
        <header className="playground-header">
          <div>
            <a className="playground-back" href={appUrl("")}>Back to bridge</a>
            <h1>Component Playground</h1>
            <p>Exercise bridge UI components with local sample data.</p>
          </div>
          <div className="playground-header-actions">
            <ThemeToggle onChange={onThemeChange} theme={theme} />
            <div className="playground-badge">Approval focus</div>
          </div>
        </header>

        <section className="playground-grid">
          <aside className="playground-panel">
            <div className="playground-control">
              <div className="playground-label">Approval type</div>
              <div className="playground-segmented" role="radiogroup" aria-label="Approval type">
                {variants.map((option) => (
                  <button
                    aria-checked={variant === option.id}
                    className={cn("playground-segment", variant === option.id && "playground-segment-active")}
                    key={option.id}
                    onClick={() => {
                      setVariant(option.id);
                      setStatus("pending");
                    }}
                    role="radio"
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="playground-control">
              <div className="playground-label">Status</div>
              <div className="playground-segmented" role="radiogroup" aria-label="Approval status">
                {states.map((option) => (
                  <button
                    aria-checked={status === option.id}
                    className={cn("playground-segment", status === option.id && "playground-segment-active")}
                    key={option.id}
                    onClick={() => setStatus(option.id)}
                    role="radio"
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="playground-control">
              <div className="playground-label">Last decisions</div>
              {decisionLog.length ? (
                <div className="playground-log">
                  {decisionLog.map((entry) => (
                    <div className="playground-log-row" key={entry.id}>
                      <span>{entry.decision}</span>
                      <code>{entry.responseId}</code>
                      <time>{entry.at}</time>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="playground-muted">Click Approve or Deny to see the outgoing response shape.</p>
              )}
            </div>

            <div className="playground-control">
              <div className="playground-label">Tool output</div>
              <div className="playground-segmented" role="radiogroup" aria-label="Tool output state">
                {toolStates.map((option) => (
                  <button
                    aria-checked={toolVariant === option.id}
                    className={cn("playground-segment", toolVariant === option.id && "playground-segment-active")}
                    key={option.id}
                    onClick={() => setToolVariant(option.id)}
                    role="radio"
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          </aside>

          <section className="playground-preview" aria-label="Component previews">
            <div className="playground-preview-toolbar">
              <span>Approval preview</span>
              <span>{item.method}</span>
            </div>
            <div className="playground-preview-surface">
              <ApprovalCard item={item} onRespond={handleApprovalResponse} />
            </div>
            <div className="playground-mobile-frame">
              <div className="playground-preview-toolbar">
                <span>Mobile width</span>
                <span>360px</span>
              </div>
              <ApprovalCard item={item} onRespond={handleApprovalResponse} />
            </div>

            <div className="playground-preview-toolbar playground-preview-toolbar-spaced">
              <span>Tool output preview</span>
              <span>{toolItem.status}</span>
            </div>
            <div className="playground-preview-surface">
              <CommandCard item={toolItem} key={`desktop-${toolVariant}`} />
            </div>
            <div className="playground-mobile-frame">
              <div className="playground-preview-toolbar">
                <span>Mobile width</span>
                <span>360px</span>
              </div>
              <CommandCard item={toolItem} key={`mobile-${toolVariant}`} />
            </div>

            <div className="playground-preview-toolbar playground-preview-toolbar-spaced">
              <span>Streamdown message preview</span>
              <span>assistant markdown</span>
            </div>
            <div className="playground-preview-surface">
              <AssistantMessage item={playgroundAssistantItem} />
            </div>
            <div className="playground-mobile-frame">
              <div className="playground-preview-toolbar">
                <span>Mobile width</span>
                <span>360px</span>
              </div>
              <AssistantMessage item={playgroundAssistantItem} />
            </div>

            <div className="playground-preview-toolbar playground-preview-toolbar-spaced">
              <span>Chat input UX mock</span>
              <span>composer</span>
            </div>
            <div className="playground-preview-surface playground-composer-surface">
              <CodexComposerMock />
            </div>
            <div className="playground-mobile-frame playground-composer-frame">
              <div className="playground-preview-toolbar">
                <span>Mobile width</span>
                <span>360px</span>
              </div>
              <CodexComposerMock compact />
            </div>
          </section>
        </section>
      </div>
    </main>
  );
}

function CodexComposerMock({ compact = false }) {
  return (
    <div className={cn("codex-composer-mock", compact && "codex-composer-mock-compact")}>
      <TextareaAutosize
        className="codex-composer-input"
        maxRows={compact ? 5 : 7}
        minRows={compact ? 2 : 3}
        readOnly
        value={"Plan the next UI pass, then update the bridge components."}
      />
      <div className="codex-composer-footer">
        <div className="codex-composer-actions" aria-label="Composer tools">
          <button className="codex-composer-chip codex-composer-chip-muted" type="button">
            <ShieldCheck className="size-3.5" />
            <span>Default</span>
          </button>
          <button className="codex-composer-chip" type="button">
            <span>GPT-5.2 high</span>
          </button>
          <button className="codex-composer-icon" type="button" aria-label="Attach file" hidden>
            <Paperclip className="size-4" />
          </button>
          <button className="codex-composer-icon" type="button" aria-label="Add image" hidden>
            <Image className="size-4" />
          </button>
        </div>
        <div className="codex-composer-actions">
          <button className="codex-composer-send" type="button" aria-label="Send message">
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

function ThreadSidebar(props) {
  return (
    <aside className="hidden h-dvh border-r border-[var(--border)] bg-[var(--sidebar)] lg:flex lg:flex-col">
      <ThreadPanel {...props} />
    </aside>
  );
}

function ThreadPanel({
  activeThreadId,
  filteredThreads,
  isErrorStatus,
  onNewThread,
  onQueryChange,
  onSelectThread,
  query,
  status,
  workspaceCandidates,
}) {
  return (
    <>
      <div className="border-b border-[var(--border)] px-4 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <PanelLeft className="size-4 text-[var(--muted-foreground)]" />
              <h1 className="truncate text-sm font-semibold tracking-[0]">Codex Bridge</h1>
            </div>
            <p className={cn("mt-1 truncate text-xs", isErrorStatus ? "text-[var(--destructive)]" : "text-[var(--muted-foreground)]")}>
              {status}
            </p>
          </div>
          <button className="icon-button" type="button" aria-label="New thread" onClick={onNewThread}>
            <Plus className="size-4" />
          </button>
        </div>
        <label className="mt-4 flex h-9 items-center gap-2 rounded-md border border-[var(--input)] bg-[var(--background)] px-3 text-sm">
          <Search className="size-4 shrink-0 text-[var(--muted-foreground)]" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[var(--muted-foreground)]"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search threads"
          />
        </label>
        <a className="sidebar-nav-link" href={appUrl("playground")}>
          <SlidersHorizontal className="size-4" />
          <span>Component playground</span>
        </a>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {filteredThreads.length ? (
          filteredThreads.map((thread) => (
            <ThreadButton
              active={thread.id === activeThreadId}
              key={thread.id}
              onClick={() => onSelectThread(thread.id)}
              thread={thread}
              workspaceRoot={getThreadWorkspaceRoot(thread, workspaceCandidates)}
            />
          ))
        ) : (
          <div className="px-3 py-8 text-sm text-[var(--muted-foreground)]">No matching threads.</div>
        )}
      </div>
    </>
  );
}

function MobileThreadSheet(props) {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 lg:hidden" />
        <Dialog.Content className="fixed inset-y-0 left-0 z-50 flex w-[min(88vw,360px)] flex-col border-r border-[var(--border)] bg-[var(--sidebar)] shadow-2xl outline-none lg:hidden">
          <Dialog.Title className="sr-only">Threads</Dialog.Title>
          <Dialog.Description className="sr-only">Search and switch between recent Codex threads.</Dialog.Description>
          <ThreadPanel {...props} />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ThreadButton({ active, onClick, thread, workspaceRoot }) {
  const name = thread.name || thread.preview || "Untitled thread";
  const worktreeInfo = getCodexWorktreeInfo(thread.cwd);
  const meta = [formatDate(thread.updatedAt), compactPath(formatHomePath(workspaceRoot || thread.cwd))]
    .filter(Boolean)
    .join(" · ");
  return (
    <button className={cn("thread-button", active && "thread-button-active")} type="button" onClick={onClick}>
      <span className="flex min-w-0 items-center gap-2">
        <span className="block min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
        {worktreeInfo ? <span className="thread-badge">worktree</span> : null}
      </span>
      <span className="mt-1 block truncate text-xs text-[var(--muted-foreground)]" title={thread.cwd}>
        {meta || thread.id}
      </span>
    </button>
  );
}

function ChatHeader({
  activeThread,
  activeThreadId,
  activeTurnId,
  busy,
  connected,
  onInterrupt,
  onOpenThreads,
  onThemeChange,
  status,
  statusError,
  theme,
}) {
  const title = activeThread?.name || activeThread?.preview || (activeThreadId ? "Selected Thread" : "New Thread");
  return (
    <header className="sticky top-0 z-20 flex min-h-16 items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--background)]/92 px-3 backdrop-blur md:px-5">
      <div className="flex min-w-0 items-center gap-3">
        <button className="icon-button lg:hidden" type="button" aria-label="Open threads" onClick={onOpenThreads}>
          <Menu className="size-4" />
        </button>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold md:text-base">{title}</h2>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
            <StatusDot connected={connected} busy={busy} error={Boolean(statusError)} />
            <span className={cn("truncate", statusError && "text-[var(--destructive)]")}>{status}</span>
            {activeThreadId ? <span className="hidden truncate md:inline">· {activeThreadId}</span> : null}
          </div>
        </div>
      </div>
      <div className="header-actions">
        <ThemeToggle onChange={onThemeChange} theme={theme} />
        <button className="secondary-button" type="button" disabled={!activeTurnId} onClick={onInterrupt}>
          <Square className="size-3.5" />
          <span>Stop</span>
        </button>
      </div>
    </header>
  );
}

function ModelSelector({ disabled, effort, model, modelOverridePending, modelSource, models, onChange }) {
  const visibleModels = useMemo(
    () => models.filter((option) => !option.hidden || option.model === model),
    [model, models],
  );
  const selectedModel = model || visibleModels.find((option) => option.isDefault)?.model || "";
  const selected = findModel(models, selectedModel);
  const selectedEffort = normalizeEffortForModel(selected, effort);
  const sourceLabel = modelSourceLabel(modelSource, modelOverridePending);
  const modelsForOptions = selectedModel && !visibleModels.some((option) => option.model === selectedModel)
    ? [{ id: selectedModel, model: selectedModel, displayName: selectedModel }, ...visibleModels]
    : visibleModels;
  const options = modelEffortOptions(modelsForOptions);
  const selectedValue = modelEffortValue(selectedModel, selectedEffort);

  return (
    <label className="model-selector" title={modelSelectorTitle(selected, selectedEffort, selectedModel)}>
      <Cpu className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
      <span className="model-selector-copy">
        <span className="model-selector-title">{selected ? selected.displayName : selectedModel || "Loading model"}</span>
        <span className="model-selector-meta">{[formatReasoningEffort(selectedEffort), sourceLabel].filter(Boolean).join(" · ")}</span>
      </span>
      <select
        aria-label="Model and reasoning effort"
        className="model-selector-select"
        disabled={disabled || !options.length}
        onChange={(event) => onChange(event.target.value)}
        value={selectedValue}
      >
        {options.length ? (
          options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))
        ) : (
          <option value={selectedValue}>{selectedModel || "Loading model"}</option>
        )}
      </select>
      <ChevronDown className="size-3.5 shrink-0 text-[var(--muted-foreground)]" />
    </label>
  );
}

function ThemeToggle({ onChange, theme }) {
  const dark = theme === "dark";
  return (
    <button
      className="theme-toggle"
      type="button"
      aria-label={dark ? "Use light mode" : "Use dark mode"}
      aria-pressed={dark}
      onClick={() => onChange(dark ? "light" : "dark")}
      title={dark ? "Use light mode" : "Use dark mode"}
    >
      {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

function StatusDot({ busy, connected, error }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full",
        error && "bg-[var(--destructive)]",
        !error && busy && "animate-pulse bg-[var(--warning)]",
        !error && !busy && connected && "bg-[var(--success)]",
        !error && !busy && !connected && "bg-[var(--muted-foreground)]",
      )}
    />
  );
}

const Timeline = React.forwardRef(function Timeline(
  {
    activeThreadId,
    busy,
    defaultThreadCwd,
    isAtBottom,
    newThreadCwd,
    onAtBottomChange,
    onInteractionRespond,
    onJumpToComposer,
    onWorkspaceChange,
    pendingInteractions,
    turns,
    workspaceOptions,
  },
  ref,
) {
  const scrollKey = useMemo(() => timelineScrollKey(turns), [turns]);
  const visiblePendingInteractions = useMemo(
    () => pendingInteractionsNotInTurns(pendingInteractions, turns, activeThreadId),
    [activeThreadId, pendingInteractions, turns],
  );
  const pendingApprovalKey = useMemo(
    () => latestPendingInteractionKey(turns, visiblePendingInteractions),
    [turns, visiblePendingInteractions],
  );

  function handleScroll(event) {
    const element = event.currentTarget;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    onAtBottomChange(distanceFromBottom < 80);
  }

  useEffect(() => {
    if (!isAtBottom) return;
    function scrollToBottom() {
      const element = ref.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }

    const frame = window.requestAnimationFrame(scrollToBottom);
    const timeout = window.setTimeout(scrollToBottom, 150);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [busy, isAtBottom, ref, scrollKey]);

  useEffect(() => {
    if (!pendingApprovalKey) return;

    function scrollToBottom() {
      const element = ref.current;
      if (element) {
        element.scrollTop = element.scrollHeight;
      }
    }

    const frame = window.requestAnimationFrame(scrollToBottom);
    const timeout = window.setTimeout(scrollToBottom, 150);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [pendingApprovalKey, ref]);

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={ref} className="h-full overflow-auto" onScroll={handleScroll}>
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-3 py-5 md:px-6 md:py-8">
        {turns.length ? (
          <>
            {turns.map((turn) => <TurnCard key={turn.id} busy={busy} onInteractionRespond={onInteractionRespond} turn={turn} />)}
            <PendingInteractionRecovery interactions={visiblePendingInteractions} onInteractionRespond={onInteractionRespond} />
          </>
        ) : (
          visiblePendingInteractions.length ? (
            <PendingInteractionRecovery interactions={visiblePendingInteractions} onInteractionRespond={onInteractionRespond} />
          ) : (
            <EmptyState
              defaultThreadCwd={defaultThreadCwd}
              newThreadCwd={newThreadCwd}
              onWorkspaceChange={onWorkspaceChange}
              workspaceOptions={workspaceOptions}
            />
          )
        )}
      </div>
      </div>
      {!isAtBottom ? (
        <button className="conversation-scroll-button" type="button" onClick={onJumpToComposer} aria-label="Scroll to bottom and focus input">
          <ArrowDown className="size-4" />
        </button>
      ) : null}
    </div>
  );
});

function PendingInteractionRecovery({ interactions, onInteractionRespond }) {
  if (!interactions.length) return null;

  return (
    <section className="pending-approval-recovery" aria-label="Pending interactions">
      <div className="pending-approval-recovery-header">
        <ShieldCheck className="size-4" />
        <div>
          <h2>Codex is waiting for input</h2>
          <p>Recovered from the bridge connection so the blocked request can still be answered.</p>
        </div>
      </div>
      <div className="space-y-3">
        {interactions.map((item) => (
          <PendingInteractionCard item={item} key={item.id} onRespond={onInteractionRespond} />
        ))}
      </div>
    </section>
  );
}

function EmptyState({
  defaultThreadCwd,
  newThreadCwd,
  onWorkspaceChange,
  workspaceOptions,
}) {
  const [draft, setDraft] = useState(newThreadCwd || defaultThreadCwd || "");
  const workspace = newThreadCwd || defaultThreadCwd || "No workspace configured";
  const checkoutKind = getCodexWorktreeInfo(workspace) ? "Managed worktree" : "Local checkout";
  const isDefault = workspace === defaultThreadCwd;

  useEffect(() => {
    setDraft(newThreadCwd || defaultThreadCwd || "");
  }, [defaultThreadCwd, newThreadCwd]);

  function commitWorkspace(value = draft) {
    const next = value.trim();
    if (next && next !== newThreadCwd) {
      onWorkspaceChange(next);
    }
  }

  function saveWorkspace(event) {
    event.preventDefault();
    commitWorkspace();
  }

  function resetWorkspace() {
    if (defaultThreadCwd) {
      setDraft(defaultThreadCwd);
      commitWorkspace(defaultThreadCwd);
    }
  }

  return (
    <div className="mx-auto mt-14 max-w-xl text-center">
      <div className="mx-auto flex size-11 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--card)]">
        <Bot className="size-5 text-[var(--muted-foreground)]" />
      </div>
      <h2 className="mt-4 text-lg font-semibold">Start a Codex thread</h2>
      <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
        Send a prompt or choose a recent thread. Commands, activity, and assistant output will be grouped by turn.
      </p>
      <div className="workspace-card">
        <div className="text-xs font-semibold uppercase text-[var(--muted-foreground)]">New thread workspace</div>
        <form className="mt-3 space-y-3" onSubmit={saveWorkspace}>
          <label className="block text-left text-xs font-medium text-[var(--muted-foreground)]" htmlFor="workspace-cwd">
            Choose a recent workspace or type a path
          </label>
          <input
            id="workspace-cwd"
            className="workspace-input"
            autoCapitalize="off"
            autoComplete="off"
            autoCorrect="off"
            list="workspace-options"
            spellCheck={false}
            value={draft}
            onBlur={() => commitWorkspace()}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft(newThreadCwd || defaultThreadCwd || "");
              }
            }}
            placeholder={defaultThreadCwd || "/path/to/workspace"}
            title={workspace}
          />
          <datalist id="workspace-options">
            {workspaceOptions.map((option) => (
              <option key={option} value={option} label={formatHomePath(option)} />
            ))}
          </datalist>
          {workspaceOptions.length ? (
            <div className="workspace-options" aria-label="Recent workspaces">
              {workspaceOptions.map((option) => (
                <button
                  className={cn("workspace-option", option === draft.trim() && "workspace-option-active")}
                  key={option}
                  type="button"
                  onClick={() => {
                    setDraft(option);
                    commitWorkspace(option);
                  }}
                  title={option}
                >
                  {formatHomePath(option)}
                </button>
              ))}
            </div>
          ) : null}
          <div className="workspace-summary">
            <div className="workspace-summary-row">
              <span>Checkout</span>
              <strong>{checkoutKind}</strong>
            </div>
          </div>
          {!isDefault && defaultThreadCwd ? (
            <div className="mt-3 flex flex-wrap justify-center gap-2">
              <button className="small-secondary-button" type="button" onClick={resetWorkspace}>
                Reset default
              </button>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}

function PermissionModePicker({ mode, onChange }) {
  const selected = PERMISSION_MODES[mode] || PERMISSION_MODES[DEFAULT_PERMISSION_MODE];
  return (
    <div className="permission-picker" aria-label="Permission level">
      <div className="permission-tabs" role="radiogroup" aria-label="Permission level">
        {Object.values(PERMISSION_MODES).map((option) => (
          <button
            aria-checked={option.id === selected.id}
            className={cn("permission-tab", option.id === selected.id && "permission-tab-active")}
            key={option.id}
            onClick={() => onChange(option.id)}
            role="radio"
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <div className="permission-detail">
        <ShieldCheck className="size-3.5" />
        <span>
          {selected.sandbox} · {selected.approvalPolicy}
        </span>
      </div>
      <p>{selected.description}</p>
    </div>
  );
}

function TurnCard({ busy, onInteractionRespond, turn }) {
  const visibleItems = turn.items.filter((item) => item.type !== "activity" && !isHiddenApprovalItem(item));
  const activityItems = turn.items.filter((item) => item.type === "activity");

  return (
    <article className="space-y-3">
      {turn.userInput ? (
        <div className="flex justify-end">
          <div className="user-bubble">
            <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-[var(--muted-foreground)]">
              <User className="size-3.5" />
              You
            </div>
            <div className="whitespace-pre-wrap text-sm leading-6">{turn.userInput}</div>
          </div>
        </div>
      ) : null}

      <div className="space-y-3">
        {visibleItems.map((item) => {
          if (item.type === "assistant") {
            return <AssistantMessage item={item} key={item.id} />;
          }
          if (item.type === "command") {
            return <CommandCard item={item} key={item.id} />;
          }
          if (item.type === "approval") {
            return <ApprovalCard item={item} key={item.id} onRespond={(_responseId, decision) => onInteractionRespond(item, { decision })} />;
          }
          if (item.type === "fileChange") {
            return <FileChangeCard item={item} key={item.id} />;
          }
          if (item.type === "error") {
            return <ErrorCard item={item} key={item.id} />;
          }
          return null;
        })}
        {activityItems.length ? <ActivityExpander items={activityItems} /> : null}
        {turn.status === "running" && busy ? <RunningIndicator /> : null}
      </div>
    </article>
  );
}

function AssistantMessage({ item }) {
  return (
    <div className="assistant-message">
      <div className="message-label">
        <Bot className="size-3.5" />
        Codex
        {item.streaming ? <span className="ml-1 text-[var(--muted-foreground)]">streaming</span> : null}
      </div>
      {item.text ? (
        <Streamdown className="streamdown-content" animated={item.streaming} isAnimating={item.streaming}>
          {item.text}
        </Streamdown>
      ) : (
        <div className="flex items-center gap-2 text-sm text-[var(--muted-foreground)]">
          <LoaderCircle className="size-4 animate-spin" />
          Waiting for response
        </div>
      )}
    </div>
  );
}

function CommandCard({ item }) {
  const [open, setOpen] = useState(item.status === "running");
  const [tab, setTab] = useState(item.stderr ? "stderr" : "stdout");
  const output = tab === "stderr" ? item.stderr || "" : item.stdout || item.output || "";
  const lines = output ? output.split("\n").length : 0;
  const command = item.command || "Command output";
  const failed = isFailedCommandStatus(item.status) || Number(item.exitCode) > 0;
  const StatusIcon = item.status === "running" ? LoaderCircle : failed ? XCircle : CheckCircle2;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="tool-card">
        <Collapsible.Trigger asChild>
          <button className="tool-card-trigger" type="button">
            <span className="flex min-w-0 items-center gap-2">
              <Terminal className="size-4 shrink-0 text-[var(--accent)]" />
              <span className="truncate font-mono text-xs">{command}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
              <StatusIcon className={cn("size-3.5", item.status === "running" && "animate-spin", failed && "text-[var(--destructive)]")} />
              {commandStatusLabel(item, lines)}
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            </span>
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="tool-meta-grid">
            {item.cwd ? (
              <div className="tool-meta-item" title={item.cwd}>
                <Folder className="size-3.5" />
                <span>{formatHomePath(item.cwd)}</span>
              </div>
            ) : null}
            {item.durationMs != null ? (
              <div className="tool-meta-item">
                <Clock className="size-3.5" />
                <span>{formatDuration(item.durationMs)}</span>
              </div>
            ) : null}
            {item.exitCode != null ? (
              <div className={cn("tool-meta-item", failed && "tool-meta-danger")}>
                {failed ? <XCircle className="size-3.5" /> : <CheckCircle2 className="size-3.5" />}
                <span>exit {item.exitCode}</span>
              </div>
            ) : null}
          </div>
          <div className="tool-tabs" role="tablist" aria-label="Command output streams">
            <button className={cn("tool-tab", tab === "stdout" && "tool-tab-active")} type="button" onClick={() => setTab("stdout")}>
              stdout
            </button>
            <button className={cn("tool-tab", tab === "stderr" && "tool-tab-active")} type="button" onClick={() => setTab("stderr")}>
              stderr
            </button>
          </div>
          <pre className="command-output">{output || "No output yet."}</pre>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}

function ApprovalCard({ item, onRespond }) {
  const [open, setOpen] = useState(true);
  const pending = item.status === "pending";
  const canRespond = pending && item.responseId != null;
  const approveDecision = approvalDecisionFor(item.availableDecisions, "approve");
  const denyDecision = approvalDenyDecisionFor(item);
  const statusLabel = approvalStatusLabel(item.status);

  useEffect(() => {
    setOpen(pending);
  }, [pending]);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="approval-card">
        <Collapsible.Trigger asChild>
          <button className="tool-card-trigger" type="button">
            <span className="flex min-w-0 items-center gap-2">
              <ShieldCheck className="size-4 shrink-0 text-[var(--warning)]" />
              <span className="truncate text-sm font-semibold">{item.title}</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
              {pending ? "needs approval" : statusLabel}
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            </span>
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="approval-body">
            {item.command ? <pre className="approval-command">{item.command}</pre> : null}
            {item.cwd ? (
              <div className="tool-meta-item" title={item.cwd}>
                <Folder className="size-3.5" />
                <span>{formatHomePath(item.cwd)}</span>
              </div>
            ) : null}
            {item.reason ? <p className="approval-reason">{item.reason}</p> : null}
            <div className="approval-actions">
              <button className="approval-allow" type="button" disabled={!canRespond} onClick={() => onRespond(item.responseId, approveDecision)}>
                <ShieldCheck className="size-3.5" />
                Approve
              </button>
              <button className="approval-deny" type="button" disabled={!canRespond} onClick={() => onRespond(item.responseId, denyDecision)}>
                <ShieldX className="size-3.5" />
                Deny
              </button>
            </div>
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}

function PendingInteractionCard({ item, onRespond }) {
  if (item.type === "approval") {
    return <ApprovalCard item={item} onRespond={(_responseId, decision) => onRespond(item, { decision })} />;
  }
  if (item.type === "elicitation") {
    return <ElicitationCard item={item} onRespond={onRespond} />;
  }
  if (item.type === "userInput") {
    return <UserInputCard item={item} onRespond={onRespond} />;
  }
  return null;
}

function ElicitationCard({ item, onRespond }) {
  const canAcceptWithoutFields = item.mode === "form" && Object.keys(item.schema?.properties || {}).length === 0;

  return (
    <div className="approval-card">
      <div className="tool-card-trigger">
        <span className="flex min-w-0 items-center gap-2">
          <ShieldCheck className="size-4 shrink-0 text-[var(--warning)]" />
          <span className="truncate text-sm font-semibold">{item.title}</span>
        </span>
        <span className="text-xs text-[var(--muted-foreground)]">needs input</span>
      </div>
      <div className="approval-body">
        {item.serverName ? <div className="tool-meta-item">{item.serverName}</div> : null}
        {item.message ? <p className="approval-reason">{item.message}</p> : null}
        {!canAcceptWithoutFields ? (
          <p className="approval-reason">This request needs structured input that is not supported in the bridge yet.</p>
        ) : null}
        <div className="approval-actions">
          {canAcceptWithoutFields ? (
            <button className="approval-allow" type="button" onClick={() => onRespond(item, { action: "accept", content: {}, _meta: null })}>
              <ShieldCheck className="size-3.5" />
              Allow
            </button>
          ) : null}
          <button className="approval-deny" type="button" onClick={() => onRespond(item, { action: "decline", content: null, _meta: null })}>
            <ShieldX className="size-3.5" />
            Deny
          </button>
        </div>
      </div>
    </div>
  );
}

function UserInputCard({ item, onRespond }) {
  const [answers, setAnswers] = useState(() => defaultUserInputAnswers(item.questions));
  const ready = item.questions.every((question) => {
    const values = answers[question.id] || [];
    return values.length > 0;
  });

  return (
    <div className="approval-card">
      <div className="tool-card-trigger">
        <span className="flex min-w-0 items-center gap-2">
          <CircleAlert className="size-4 shrink-0 text-[var(--warning)]" />
          <span className="truncate text-sm font-semibold">{item.title}</span>
        </span>
        <span className="text-xs text-[var(--muted-foreground)]">needs input</span>
      </div>
      <div className="approval-body">
        <div className="pending-user-input-fields">
          {item.questions.map((question) => (
            <fieldset className="pending-user-input-field" key={question.id}>
              <legend>{question.header || "Question"}</legend>
              <p>{question.question}</p>
              {question.options?.length ? (
                <div className="pending-user-input-options">
                  {question.options.map((option) => (
                    <label key={option.label}>
                      <input
                        checked={(answers[question.id] || []).includes(option.label)}
                        name={question.id}
                        onChange={() => setAnswers((current) => ({ ...current, [question.id]: [option.label] }))}
                        type="radio"
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              ) : (
                <input
                  className="pending-user-input-text"
                  onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value ? [event.target.value] : [] }))}
                  type={question.isSecret ? "password" : "text"}
                  value={(answers[question.id] || [])[0] || ""}
                />
              )}
            </fieldset>
          ))}
        </div>
        <div className="approval-actions">
          <button className="approval-allow" type="button" disabled={!ready} onClick={() => onRespond(item, { answers: toToolUserInputAnswers(answers) })}>
            <ShieldCheck className="size-3.5" />
            Submit
          </button>
        </div>
      </div>
    </div>
  );
}

function FileChangeCard({ item }) {
  const [open, setOpen] = useState(item.status === "running");
  const files = item.files || [];
  const summary = fileChangeSummary(item);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="file-change-card">
        <Collapsible.Trigger asChild>
          <button className="tool-card-trigger" type="button">
            <span className="flex min-w-0 items-center gap-2">
              <FileDiff className="size-4 shrink-0 text-[var(--accent)]" />
              <span className="truncate text-sm font-semibold">File changes</span>
            </span>
            <span className="flex shrink-0 items-center gap-2 text-xs text-[var(--muted-foreground)]">
              {summary}
              <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
            </span>
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <div className="file-change-body">
            <div className="file-change-stats">
              <span>{files.length} file{files.length === 1 ? "" : "s"}</span>
              <span>+{item.additions}</span>
              <span>-{item.deletions}</span>
              {item.autoApproved ? <span>auto-approved</span> : null}
            </div>
            {files.length ? (
              <div className="file-list">
                {files.map((file) => (
                  <div className="file-row" key={`${file.kind}:${file.path}:${file.movePath || ""}`}>
                    <span className={cn("file-kind", `file-kind-${file.kind}`)}>{file.kind}</span>
                    <span className="file-path" title={file.path}>{file.path}</span>
                    {file.movePath ? <span className="file-move-path" title={file.movePath}>→ {file.movePath}</span> : null}
                    <span className="file-line-stats">+{file.additions} -{file.deletions}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {item.diff ? <pre className="diff-output">{item.diff}</pre> : null}
          </div>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}

function ActivityExpander({ items }) {
  const [open, setOpen] = useState(false);
  const displayableItems = items.filter((item) => activityDisplayText(item).trim());
  const text = displayableItems.map(activityDisplayText).join("\n");
  if (!displayableItems.length) return null;

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen}>
      <div className="activity-card">
        <Collapsible.Trigger asChild>
          <button className="activity-trigger" type="button">
            <span>{displayableItems.length} activity update{displayableItems.length === 1 ? "" : "s"}</span>
            <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
          </button>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <pre className="activity-output">{text}</pre>
        </Collapsible.Content>
      </div>
    </Collapsible.Root>
  );
}

function ErrorCard({ item }) {
  return (
    <div className="error-card">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">
        <div className="text-sm font-medium">Error</div>
        <div className="mt-1 whitespace-pre-wrap text-sm leading-6">{item.message}</div>
      </div>
    </div>
  );
}

function RunningIndicator() {
  return (
    <div className="flex items-center gap-2 pl-2 text-xs text-[var(--muted-foreground)]">
      <LoaderCircle className="size-3.5 animate-spin" />
      Codex is working
    </div>
  );
}

function Composer({
  busy,
  connected,
  effort,
  highlighted,
  inputRef,
  model,
  modelOverridePending,
  modelSource,
  models,
  onChange,
  onModelChange,
  onPermissionModeChange,
  onSubmit,
  permissionMode,
  prompt,
}) {
  const permission = PERMISSION_MODES[permissionMode] || PERMISSION_MODES[DEFAULT_PERMISSION_MODE];
  const visibleModels = useMemo(
    () => models.filter((option) => !option.hidden || option.model === model),
    [model, models],
  );
  const selectedModel = model || visibleModels.find((option) => option.isDefault)?.model || "";
  const selected = findModel(models, selectedModel);
  const selectedEffort = normalizeEffortForModel(selected, effort);
  const sourceLabel = modelSourceLabel(modelSource, modelOverridePending);
  const modelsForOptions = selectedModel && !visibleModels.some((option) => option.model === selectedModel)
    ? [{ id: selectedModel, model: selectedModel, displayName: selectedModel }, ...visibleModels]
    : visibleModels;
  const options = modelEffortOptions(modelsForOptions);
  const selectedValue = modelEffortValue(selectedModel, selectedEffort);

  return (
    <form className="codex-composer-form" onSubmit={onSubmit}>
      <div className={cn("codex-composer-mock codex-composer-live", highlighted && "composer-shell-highlighted")}>
        <TextareaAutosize
          ref={inputRef}
          autoComplete="off"
          autoCorrect="off"
          className="codex-composer-input codex-composer-input-live"
          disabled={!connected}
          maxRows={8}
          minRows={1}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder={connected ? "Message Codex" : "Connecting..."}
          spellCheck={false}
          value={prompt}
        />
        <div className="codex-composer-footer">
          <div className="codex-composer-actions" aria-label="Composer controls">
            <label className="codex-composer-chip codex-composer-chip-muted codex-composer-control" title={permission.description}>
              <ShieldCheck className="size-3.5" />
              <span>{permission.label}</span>
              <select
                aria-label="Permission level"
                className="codex-composer-select"
                disabled={!connected}
                onChange={(event) => onPermissionModeChange(event.target.value)}
                value={permission.id}
              >
                {Object.values(PERMISSION_MODES).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="codex-composer-chip codex-composer-control" title={modelSelectorTitle(selected, selectedEffort, selectedModel)}>
              <span>{selected ? selected.displayName : selectedModel || "Loading model"}</span>
              {selectedEffort ? <span className="codex-composer-effort">{formatReasoningEffort(selectedEffort)}</span> : null}
              <select
                aria-label="Model and reasoning effort"
                className="codex-composer-select"
                disabled={!connected || !options.length}
                onChange={(event) => onModelChange(event.target.value)}
                value={selectedValue}
              >
                {options.length ? (
                  options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))
                ) : (
                  <option value={selectedValue}>{selectedModel || "Loading model"}</option>
                )}
              </select>
            </label>
            {sourceLabel ? <span className="codex-composer-source">{sourceLabel}</span> : null}
          </div>
          <div className="codex-composer-actions">
            <button className="codex-composer-send" type="submit" disabled={!connected || busy || !prompt.trim()} aria-label="Send message">
              <Send className="size-4" />
            </button>
          </div>
        </div>
      </div>
    </form>
  );
}

function appRoutePath() {
  const pathname = window.location.pathname || "/";
  if (APP_BASE_PATH !== "/" && pathname.startsWith(APP_BASE_PATH)) {
    return `/${pathname.slice(APP_BASE_PATH.length)}`.replace(/\/{2,}/g, "/");
  }
  return pathname;
}

function appUrl(path) {
  const cleanPath = String(path || "").replace(/^\/+/, "");
  return `${APP_BASE_PATH}${cleanPath}`;
}

function wsUrl(path) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${appUrl(path)}`;
}

function threadToTurns(thread) {
  if (!thread || !Array.isArray(thread.turns)) return [];

  return thread.turns.map((turn) => {
    const items = [];
    const userTexts = [];
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        userTexts.push((item.content || []).map(userInputText).filter(Boolean).join("\n"));
        continue;
      }

      const converted = itemToTurnItem(item);
      if (converted) items.push(converted);
    }

    return {
      id: turn.id || createLocalId("turn"),
      threadTurnId: turn.id || "",
      userInput: userTexts.filter(Boolean).join("\n\n"),
      items,
      status: "completed",
    };
  });
}

function itemToTurnItem(item) {
  return threadItemToTurnItem(item, "completed");
}

/**
 * Generated app-server v2 bindings currently model reasoning parts as strings.
 * Archived rollout history can still contain legacy object parts with a `text`
 * field, so the bridge accepts both shapes at this boundary and normalizes once.
 *
 * @typedef {{ type: "reasoning", id: string, summary?: string[] | LegacyReasoningPart[] | null, content?: string[] | LegacyReasoningPart[] | null }} AppServerReasoningItem
 * @typedef {{ type?: string, text?: string }} LegacyReasoningPart
 * @typedef {{ threadId: string, turnId: string, itemId: string, summaryIndex: number }} ReasoningSummaryPartAddedNotification
 * @typedef {{ threadId: string, turnId: string, itemId: string, delta: string, summaryIndex: number }} ReasoningSummaryTextDeltaNotification
 * @typedef {{ threadId: string, turnId: string, itemId: string, delta: string, contentIndex: number }} ReasoningTextDeltaNotification
 * @typedef {{ id: string, type: "activity", activityType: "reasoning", summaryParts: string[], contentParts: string[], text: string, raw?: AppServerReasoningItem }} ReasoningActivityItem
 */

function threadItemToTurnItem(item, lifecycle = "completed") {
  if (!item || typeof item !== "object") return null;
  if (item.type === "agentMessage") {
    return { id: item.id, type: "assistant", text: item.text || "", streaming: lifecycle !== "completed", raw: item };
  }
  if (item.type === "reasoning") {
    const nextItem = createReasoningActivityItem(
      item.id,
      normalizeReasoningParts(item.summary),
      normalizeReasoningParts(item.content),
      item,
    );
    return lifecycle === "completed" && !activityDisplayText(nextItem).trim() ? null : nextItem;
  }
  if (item.type === "commandExecution") {
    return commandItemFromParams({
      ...item,
      status: lifecycle === "started" ? "running" : item.status,
    });
  }
  if (item.type === "fileChange") {
    return fileChangeItemFromParams({
      ...item,
      status: lifecycle === "started" ? "running" : item.status,
    });
  }
  return null;
}

/**
 * @param {Array<string | LegacyReasoningPart> | null | undefined} parts
 * @returns {string[]}
 */
function normalizeReasoningParts(parts) {
  if (!Array.isArray(parts)) return [];
  return parts.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.text === "string") return part.text;
    return "";
  });
}

/**
 * @param {string} id
 * @param {string[]} summaryParts
 * @param {string[]} contentParts
 * @param {AppServerReasoningItem | undefined} raw
 * @returns {ReasoningActivityItem}
 */
function createReasoningActivityItem(id, summaryParts = [], contentParts = [], raw) {
  return reasoningActivityWithParts(
    {
      id,
      type: "activity",
      activityType: "reasoning",
      raw,
    },
    summaryParts,
    contentParts,
  );
}

/**
 * @param {Partial<ReasoningActivityItem> & { id: string, type: "activity", activityType: "reasoning" }} item
 * @param {string[]} summaryParts
 * @param {string[]} contentParts
 * @returns {ReasoningActivityItem}
 */
function reasoningActivityWithParts(item, summaryParts = [], contentParts = []) {
  const nextItem = {
    ...item,
    summaryParts: [...summaryParts],
    contentParts: [...contentParts],
  };
  return {
    ...nextItem,
    text: activityDisplayText(nextItem),
  };
}

function reasoningPartIndex(index, fallback) {
  return Number.isInteger(index) && index >= 0 ? index : fallback;
}

function appendReasoningPartDelta(parts = [], index, delta) {
  const nextParts = [...parts];
  const partIndex = reasoningPartIndex(index, nextParts.length);
  nextParts[partIndex] = `${nextParts[partIndex] || ""}${delta}`;
  return nextParts;
}

function mergeReasoningActivityItems(current, next) {
  const summaryParts = mergeReasoningParts(current.summaryParts, next.summaryParts);
  const contentParts = mergeReasoningParts(current.contentParts, next.contentParts);
  return reasoningActivityWithParts(
    {
      ...current,
      ...next,
    },
    summaryParts,
    contentParts,
  );
}

function mergeReasoningParts(current = [], next = []) {
  const partCount = Math.max(current.length, next.length);
  return Array.from({ length: partCount }, (_value, index) => next[index] || current[index] || "");
}

function activityDisplayText(item) {
  if (item?.activityType === "reasoning") {
    const summaryText = (item.summaryParts || []).filter(Boolean).join("\n");
    if (summaryText) return summaryText;
    return (item.contentParts || []).filter(Boolean).join("\n");
  }
  return item?.text || "";
}

function userInputText(input) {
  if (!input || typeof input !== "object") return "";
  if (input.type === "text") return input.text || "";
  if (input.type === "image") return `[image] ${input.url}`;
  if (input.type === "localImage") return `[local image] ${input.path}`;
  if (input.type === "mention" || input.type === "skill") return `[${input.type}] ${input.name || input.path}`;
  return "";
}

function notificationThreadId(params = {}) {
  return params.threadId || params.thread_id || params.thread?.id || "";
}

function notificationTurnId(params = {}) {
  return params.turnId || params.turn_id || params.turn?.id || "";
}

function normalizeCommand(command) {
  if (Array.isArray(command)) return command.join(" ");
  if (command && typeof command === "object") return JSON.stringify(command);
  return command || "";
}

function mergeCommandItems(current, next) {
  return {
    ...current,
    ...next,
    command: next.command || current.command,
    output: next.output || current.output || "",
    stdout: next.stdout || current.stdout || "",
    stderr: next.stderr || current.stderr || "",
    durationMs: next.durationMs ?? current.durationMs ?? null,
    exitCode: next.exitCode ?? current.exitCode ?? null,
    status: next.status || current.status,
  };
}

function readStoredPermissionMode() {
  const stored = localStorage.getItem(STORAGE_PERMISSION_MODE) || DEFAULT_PERMISSION_MODE;
  return PERMISSION_MODES[stored] ? stored : DEFAULT_PERMISSION_MODE;
}

function readStoredTheme() {
  const stored = localStorage.getItem(STORAGE_THEME);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function findModel(models, modelId) {
  if (!modelId) return null;
  return models.find((model) => model.model === modelId || model.id === modelId) || null;
}

function modelDisplayName(models, modelId) {
  if (!modelId) return "unknown model";
  return findModel(models, modelId)?.displayName || modelId;
}

function modelEffortOptions(models) {
  return models.flatMap((model) => {
    const efforts = modelEfforts(model);
    return efforts.map((effort) => ({
      value: modelEffortValue(model.model, effort),
      label: `${model.displayName || model.model} · ${formatReasoningEffort(effort)}`,
      model: model.model,
      effort,
    }));
  });
}

function modelEfforts(model) {
  if (!model) return [""];
  const supported = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.map((option) => option.reasoningEffort).filter(Boolean)
    : [];
  if (supported.length) return supported;
  return [model.defaultReasoningEffort || ""];
}

function normalizeEffortForModel(model, effort) {
  const efforts = modelEfforts(model);
  if (effort && efforts.includes(effort)) return effort;
  return model?.defaultReasoningEffort || efforts[0] || "";
}

function modelEffortValue(model, effort) {
  return `${model || ""}::${effort || ""}`;
}

function parseModelSelection(value) {
  const [model = "", effort = ""] = String(value || "").split("::");
  return { model, effort };
}

function formatReasoningEffort(effort) {
  if (!effort) return "";
  if (effort === "xhigh") return "XHigh";
  return `${effort.slice(0, 1).toUpperCase()}${effort.slice(1)}`;
}

function modelSelectorTitle(model, effort, modelId) {
  const modelLabel = model?.displayName || modelId || "Model loading";
  const effortLabel = formatReasoningEffort(effort);
  return [modelLabel, effortLabel, model?.description].filter(Boolean).join(" · ");
}

function modelSourceLabel(source, pending) {
  if (pending) return "pending";
  if (source === "configured") return "configured";
  if (source === "default") return "default";
  if (source === "thread") return "thread";
  if (source === "rerouted") return "rerouted";
  if (source === "override") return "pending";
  if (source === "error") return "unavailable";
  return "runtime";
}

function useThemePreference() {
  const [theme, setThemeState] = useState(readStoredTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_THEME, theme);
  }, [theme]);

  return [theme, setThemeState];
}

function commandItemFromParams(params = {}) {
  const stdout = params.stdout || params.aggregatedOutput || params.aggregated_output || "";
  const stderr = params.stderr || "";
  return {
    id: params.id || params.itemId || params.commandId || createLocalId("command"),
    type: "command",
    command: normalizeCommand(params.command || params.cmd || params.argv || params.parsed_cmd),
    cwd: params.cwd || params.workingDirectory || params.working_directory,
    durationMs: params.durationMs ?? params.duration_ms ?? null,
    exitCode: params.exitCode ?? params.exit_code ?? null,
    output: params.output || stdout || stderr || "",
    stdout,
    stderr,
    status: params.status || (params.exitCode != null || params.exit_code != null ? "completed" : "running"),
    raw: params,
  };
}

function approvalTitle(method, params = {}) {
  if (method.includes("fileChange")) return "Approve file changes";
  if (method.includes("permissions")) return "Approve permissions";
  if (method.includes("commandExecution")) return "Approve command";
  return params.title || "Approve action";
}

function approvalItemFromMessage(message) {
  if (!message?.method?.includes?.("requestApproval")) return null;
  const params = message.params || {};
  const context = interactionContextFromMessage(message, { requireItemId: true });
  if (!context) return null;
  const itemId = params.itemId ?? params.item_id ?? params.requestId ?? params.approval_id;
  return {
    id: `approval-${String(context.responseId)}`,
    type: "approval",
    itemId,
    responseId: context.responseId,
    method: message.method,
    threadId: context.threadId,
    turnId: context.turnId,
    title: approvalTitle(message.method, params),
    command: normalizeCommand(params.command || params.cmd || params.argv || params.execve?.argv),
    cwd: params.cwd || params.workingDirectory || params.working_directory,
    reason: params.reason || params.reasoning || params.message || "",
    availableDecisions: normalizeApprovalDecisions(params.available_decisions || params.availableDecisions),
    status: "pending",
    raw: params,
    recovered: Boolean(message.createdAt),
    createdAt: message.createdAt || Date.now(),
  };
}

function isPendingInteractionMessage(message) {
  const method = message?.method || "";
  return method.includes("requestApproval")
    || method === "mcpServer/elicitation/request"
    || method === "item/tool/requestUserInput";
}

function pendingInteractionFromMessage(message) {
  if (message?.method?.includes?.("requestApproval")) {
    return approvalItemFromMessage(message);
  }
  if (message?.method === "mcpServer/elicitation/request") {
    const params = message.params || {};
    const context = interactionContextFromMessage(message, { allowNullTurnId: true });
    if (!context) return null;
    return {
      id: `elicitation-${String(context.responseId)}`,
      type: "elicitation",
      responseId: context.responseId,
      method: message.method,
      threadId: context.threadId,
      turnId: context.turnId,
      title: "Approve tool access",
      serverName: params.serverName || "",
      mode: params.mode || "form",
      message: params.message || "",
      schema: params.requestedSchema || null,
      url: params.url || "",
      raw: params,
      recovered: Boolean(message.createdAt),
      createdAt: message.createdAt || Date.now(),
    };
  }
  if (message?.method === "item/tool/requestUserInput") {
    const params = message.params || {};
    const context = interactionContextFromMessage(message, { requireItemId: true });
    if (!context) return null;
    return {
      id: `user-input-${String(context.responseId)}`,
      type: "userInput",
      responseId: context.responseId,
      method: message.method,
      threadId: context.threadId,
      turnId: context.turnId,
      itemId: context.itemId,
      title: "Codex needs input",
      questions: Array.isArray(params.questions) ? params.questions : [],
      raw: params,
      recovered: Boolean(message.createdAt),
      createdAt: message.createdAt || Date.now(),
    };
  }
  return null;
}

function interactionContextFromMessage(message, { allowNullTurnId = false, requireItemId = false } = {}) {
  const params = message?.params || {};
  const threadId = notificationThreadId(params);
  const turnId = allowNullTurnId && params.turnId === null ? null : notificationTurnId(params);
  const itemId = params.itemId || params.item_id || "";
  const missing = [];

  if (message?.id == null) missing.push("id");
  if (!threadId) missing.push("threadId");
  if (turnId !== null && !turnId) missing.push("turnId");
  if (!allowNullTurnId && turnId === null) missing.push("turnId");
  if (requireItemId && !itemId) missing.push("itemId");

  if (missing.length) {
    warnMalformedInteraction(message, missing);
    return null;
  }

  return {
    responseId: message.id,
    threadId,
    turnId,
    itemId,
  };
}

function warnMalformedInteraction(message, missing) {
  console.warn("Ignoring malformed pending interaction message.", {
    method: message?.method || "",
    id: message?.id ?? null,
    missing,
  });
}

function dedupePendingInteractions(items) {
  const byResponseId = new Map();
  for (const item of items) {
    if (!item || item.responseId == null) continue;
    byResponseId.set(String(item.responseId), item);
  }
  return Array.from(byResponseId.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

function defaultUserInputAnswers(questions = []) {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      question.options?.length ? [] : [],
    ]),
  );
}

function toToolUserInputAnswers(answers) {
  return Object.fromEntries(
    Object.entries(answers).map(([id, values]) => [id, { answers: values }]),
  );
}

function playgroundApprovalItem(variant, status) {
  const base = {
    id: `playground-approval-${variant}`,
    type: "approval",
    itemId: `playground-${variant}`,
    responseId: variant === "missingResponse" ? null : 42,
    availableDecisions: [
      {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: [{ match: "touch /Users/kaiser/example-output" }],
        },
      },
      "decline",
    ],
    status,
    raw: {},
  };

  if (variant === "fileChange") {
    return {
      ...base,
      method: "item/fileChange/requestApproval",
      title: "Approve file changes",
      command: "src/client/main.jsx\nsrc/client/styles.css",
      cwd: "/Users/kaiser/workspace/codex-workspace/codex-bridge",
      reason: "Codex wants to update the approval component and supporting styles.",
    };
  }

  if (variant === "permission") {
    return {
      ...base,
      method: "item/permissions/requestApproval",
      title: "Change permission level",
      command: "sandbox: workspace-write\napprovalPolicy: on-request",
      cwd: "/Users/kaiser/workspace/codex-workspace/codex-bridge",
      reason: "This would let Codex edit files inside the selected workspace while still asking before risky actions.",
    };
  }

  return {
    ...base,
    method: "item/commandExecution/requestApproval",
    title: variant === "missingResponse" ? "Approve command without response id" : "Approve command",
    command: "/bin/zsh -lc 'touch /Users/kaiser/example-output'",
    cwd: "/Users/kaiser/workspace/codex-workspace/codex-bridge",
    reason: variant === "missingResponse"
      ? "This sample shows the disabled action state when the protocol request id is missing."
      : "Do you want to create /Users/kaiser/example-output to test the approval flow?",
  };
}

function playgroundCommandItem(variant) {
  const base = {
    id: `playground-command-${variant}`,
    type: "command",
    command: "npm run check",
    cwd: "/Users/kaiser/workspace/codex-workspace/codex-bridge",
    durationMs: variant === "running" ? null : 1240,
    exitCode: variant === "failed" ? 1 : variant === "running" ? null : 0,
    status: variant === "running" ? "running" : variant === "failed" ? "failed" : "completed",
  };

  if (variant === "failed") {
    return {
      ...base,
      stdout: "> codex-web-bridge@0.1.0 check\n> node --check src/server.js && vite build\n\ntransforming...\n",
      stderr: "src/client/main.jsx: Unexpected token (742:12)\nBuild failed with 1 error.",
      output: "src/client/main.jsx: Unexpected token (742:12)\nBuild failed with 1 error.",
    };
  }

  if (variant === "running") {
    return {
      ...base,
      stdout: "> codex-web-bridge@0.1.0 check\n> node --check src/server.js && vite build\n\nvite building client environment...\ntransforming modules...",
      stderr: "",
      output: "> codex-web-bridge@0.1.0 check\n> node --check src/server.js && vite build\n\nvite building client environment...\ntransforming modules...",
    };
  }

  return {
    ...base,
    stdout: "> codex-web-bridge@0.1.0 check\n> node --check src/server.js && vite build\n\n✓ 2089 modules transformed.\n✓ built in 229ms",
    stderr: "",
    output: "> codex-web-bridge@0.1.0 check\n> node --check src/server.js && vite build\n\n✓ 2089 modules transformed.\n✓ built in 229ms",
  };
}

const playgroundAssistantItem = {
  id: "playground-assistant-streamdown",
  type: "assistant",
  streaming: false,
  text: [
    "The `pwd` command completed successfully.",
    "",
    "Key details:",
    "",
    "- Working directory: `/Users/kaiser/workspace/codex-workspace/codex-bridge`",
    "- Exit code: `0`",
    "- Output was captured as plain shell text.",
    "",
    "```sh",
    "pwd",
    "/Users/kaiser/workspace/codex-workspace/codex-bridge",
    "```",
    "",
    "This sample is rendered through **Streamdown**, matching normal Codex assistant prose.",
  ].join("\n"),
};

function normalizeApprovalDecisions(value) {
  if (Array.isArray(value) && value.length) return value;
  return ["accept", "decline"];
}

function approvalDecisionFor(decisions, intent) {
  const list = Array.isArray(decisions) ? decisions : [];
  if (intent === "approve") {
    return list.find((decision) => approvalDecisionLabel(decision) === "acceptWithExecpolicyAmendment")
      || list.find((decision) => ["accept", "approve", "allow"].includes(approvalDecisionLabel(decision)))
      || "accept";
  }
  return approvalDenyDecisionFor({ availableDecisions: list });
}

function approvalDenyDecisionFor(item) {
  const method = item?.method || "";
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return "decline";
  }
  const list = Array.isArray(item?.availableDecisions) ? item.availableDecisions : [];
  return list.find((decision) => approvalDecisionLabel(decision) === "decline")
    || "decline";
}

function approvalDecisionLabel(decision) {
  if (typeof decision === "string") return decision;
  if (!decision || typeof decision !== "object") return String(decision || "");
  return Object.keys(decision)[0] || "decision";
}

function approvalStatusLabel(status) {
  const label = approvalDecisionLabel(status);
  if (label === "pending") return "needs approval";
  if (label === "acceptWithExecpolicyAmendment" || ["accept", "approve", "allow", "approved"].includes(label)) {
    return "approved";
  }
  if (["decline", "cancel", "deny", "denied", "reject", "abort"].includes(label)) {
    return "denied";
  }
  return label || "completed";
}

function isHiddenApprovalItem(item) {
  return item?.type === "approval" && approvalStatusLabel(item.status) === "denied";
}

function timelineScrollKey(turns) {
  return turns.map((turn) => {
    const itemsKey = (turn.items || []).map((item) => {
      if (item.type === "assistant") return `${item.id}:assistant:${item.text?.length || 0}:${item.streaming ? 1 : 0}`;
      if (item.type === "activity") return `${item.id}:activity:${activityDisplayText(item).length}`;
      if (item.type === "command") return `${item.id}:command:${item.status}:${item.output?.length || 0}`;
      if (item.type === "approval") return `${item.id}:approval:${approvalStatusLabel(item.status)}`;
      if (item.type === "fileChange") return `${item.id}:fileChange:${item.status}:${item.files?.length || 0}:${item.diff?.length || 0}`;
      return `${item.id}:${item.type || "item"}`;
    }).join(",");
    return `${turn.id}:${turn.status}:${itemsKey}`;
  }).join("|");
}

function latestPendingInteractionKey(turns, pendingInteractions = []) {
  if (pendingInteractions.length) {
    const item = pendingInteractions[pendingInteractions.length - 1];
    return `recovered:${item.id}:${item.responseId ?? ""}`;
  }
  for (let turnIndex = turns.length - 1; turnIndex >= 0; turnIndex -= 1) {
    const turn = turns[turnIndex];
    const items = turn.items || [];
    for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = items[itemIndex];
      if (item.type === "approval" && item.status === "pending") {
        return `${turn.id}:${item.id}:${item.responseId ?? ""}`;
      }
    }
  }
  return "";
}

function pendingInteractionsNotInTurns(pendingInteractions = [], turns = [], threadId = "") {
  if (!pendingInteractions.length) return [];
  const renderedResponseIds = new Set();
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === "approval" && item.responseId != null && item.status === "pending") {
        renderedResponseIds.add(String(item.responseId));
      }
    }
  }
  return pendingInteractions.filter((item) =>
    item.threadId
    && item.threadId === threadId
    && !renderedResponseIds.has(String(item.responseId)),
  );
}

function isFailedCommandStatus(status) {
  return ["failed", "error", "errored", "denied", "cancelled", "canceled"].includes(String(status || "").toLowerCase());
}

function commandStatusLabel(item, lines) {
  if (item.status === "running") return lines ? `${lines} line${lines === 1 ? "" : "s"}` : "running";
  if (item.exitCode != null) return `exit ${item.exitCode}`;
  return item.status || "completed";
}

function formatDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value)) return "";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}s`;
}

function fileChangeItemFromParams(params = {}) {
  const changes = normalizeFileChanges(params.changes || params.fileChanges || params.files || []);
  const diff = params.unified_diff || params.unifiedDiff || params.delta || params.patch || changes.map((change) => change.diff).filter(Boolean).join("\n");
  const diffStats = diffLineStats(diff);
  const fileStats = changes.reduce(
    (stats, file) => ({
      additions: stats.additions + file.additions,
      deletions: stats.deletions + file.deletions,
    }),
    { additions: 0, deletions: 0 },
  );

  return {
    id: params.id || params.itemId || params.fileChangeId || createLocalId("file-change"),
    type: "fileChange",
    files: changes,
    diff,
    additions: fileStats.additions || diffStats.additions,
    deletions: fileStats.deletions || diffStats.deletions,
    autoApproved: Boolean(params.auto_approved || params.autoApproved),
    status: params.status || "completed",
    raw: params,
  };
}

function normalizeFileChanges(changes) {
  const list = Array.isArray(changes) ? changes : [changes].filter(Boolean);
  return list.map((change) => {
    const kind = fileChangeKind(change);
    const path = change.path || change.file || change.file_path || change.relativePath || change.absolute_file_path || "Unknown file";
    const movePath = change.move_path || change.movePath || change.new_path || change.newPath || "";
    const diff = change.unified_diff || change.unifiedDiff || change.diff || "";
    const stats = diffLineStats(diff);
    return {
      kind,
      path,
      movePath,
      diff,
      additions: change.additions ?? change.added ?? stats.additions,
      deletions: change.deletions ?? change.deleted ?? stats.deletions,
    };
  });
}

function fileChangeKind(change = {}) {
  const raw = String(change.type || change.kind || change.change_type || change.changeType || "").toLowerCase();
  if (raw.includes("delete")) return "delete";
  if (raw.includes("add") || raw.includes("create")) return "add";
  if (raw.includes("move") || raw.includes("rename")) return "move";
  if (change.move_path || change.movePath) return "move";
  return "update";
}

function diffLineStats(diff) {
  if (!diff) return { additions: 0, deletions: 0 };
  return String(diff).split("\n").reduce(
    (stats, line) => {
      if (line.startsWith("+") && !line.startsWith("+++")) stats.additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) stats.deletions += 1;
      return stats;
    },
    { additions: 0, deletions: 0 },
  );
}

function mergeFileChangeItems(previous, next) {
  const files = next.files.length ? next.files : previous.files;
  const diff = [previous.diff, next.diff].filter(Boolean).join(previous.diff && next.diff ? "\n" : "");
  const diffStats = diffLineStats(diff);
  return {
    ...previous,
    ...next,
    files,
    diff,
    additions: next.additions || previous.additions || diffStats.additions,
    deletions: next.deletions || previous.deletions || diffStats.deletions,
  };
}

function fileChangeSummary(item) {
  const files = item.files?.length || 0;
  if (!files && !item.additions && !item.deletions) return item.status || "updated";
  return `${files} file${files === 1 ? "" : "s"} · +${item.additions} -${item.deletions}`;
}

function formatDate(seconds) {
  if (!seconds) return "";
  return new Date(seconds * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatHomePath(value) {
  if (!value) return "";
  const path = String(value);
  return path
    .replace(/^\/Users\/[^/]+(?=\/|$)/, "~")
    .replace(/^\/home\/[^/]+(?=\/|$)/, "~");
}

function getCodexWorktreeInfo(value) {
  if (!value) return null;
  const normalized = String(value).replaceAll("\\", "/");
  const match = normalized.match(/^(.*?\/\.codex\/worktrees)\/([^/]+)\/([^/]+)(?:\/.*)?$/);
  if (!match) return null;
  return {
    root: match[1],
    id: match[2],
    repoName: match[3],
  };
}

function getThreadWorkspaceRoot(thread, workspaceCandidates = []) {
  const cwd = String(thread?.cwd || "").trim();
  if (!cwd) return "";
  const worktreeInfo = getCodexWorktreeInfo(cwd);
  if (!worktreeInfo) return cwd;

  const matchingCandidate = workspaceCandidates.find((candidate) => {
    const normalized = normalizePathKey(candidate);
    return getPathBaseName(normalized) === worktreeInfo.repoName;
  });

  return matchingCandidate || cwd;
}

function normalizePathKey(value) {
  return String(value || "").replaceAll("\\", "/").replace(/\/+$/, "");
}

function getPathBaseName(value) {
  const normalized = normalizePathKey(value);
  const parts = normalized.split("/").filter(Boolean);
  return parts.at(-1) || normalized;
}

function compactPath(value) {
  if (!value) return "";
  const parts = String(value).split("/");
  if (parts.length <= 2) return value;
  return `.../${parts.slice(-2).join("/")}`;
}

function createLocalId(prefix = "local") {
  if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
    return `${prefix}-${globalThis.crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function cn(...values) {
  return values.filter(Boolean).join(" ");
}

function normalizeBasePath(value) {
  const raw = String(value || "/");
  if (!raw || raw === "/") return "/";
  return `/${raw.replace(/^\/+|\/+$/g, "")}/`;
}

class RpcClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = () => {};
    this.onClose = () => {};
  }

  open() {
    this.socket = new WebSocket(this.url);
    this.socket.addEventListener("message", (event) => this.handleMessage(event.data));
    this.socket.addEventListener("close", () => {
      this.rejectPending(new Error("WebSocket closed"));
      this.onClose();
    });
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
  }

  request(method, params) {
    if (!this.isOpen()) return Promise.reject(new Error("WebSocket is not connected"));
    const id = `web-${this.nextId++}`;
    const payload = { id, method, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(payload));
    });
  }

  notify(method, params) {
    if (!this.isOpen()) return;
    this.socket.send(JSON.stringify(params === undefined ? { method } : { method, params }));
  }

  respond(id, result) {
    if (!this.isOpen()) return;
    this.socket.send(JSON.stringify({ id, result }));
  }

  close() {
    if (this.socket && this.socket.readyState < WebSocket.CLOSING) {
      this.socket.close();
    }
    this.rejectPending(new Error("WebSocket closed"));
  }

  isOpen() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  rejectPending(error) {
    for (const waiter of this.pending.values()) {
      waiter.reject(error);
    }
    this.pending.clear();
  }

  handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const waiter = this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id);
      if (message.error) {
        waiter.reject(new Error(message.error.message || "RPC error"));
      } else {
        waiter.resolve(message.result);
      }
      return;
    }

    this.onNotification(message);
  }
}

const rootElement = document.querySelector("#app");
const root = globalThis.__codexBridgeRoot || createRoot(rootElement);
globalThis.__codexBridgeRoot = root;
root.render(<App />);
