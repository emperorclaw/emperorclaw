#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Emperor Claw bridge example for OpenClaw.
 *
 * This is a runnable reference adapter that:
 * - registers a runtime node
 * - resolves or creates the local agent record
 * - opens a durable Emperor session
 * - hydrates memory from Emperor
 * - maintains heartbeat
 * - connects to the MCP WebSocket, with /messages/sync fallback
 * - persists a local state journal for reconnect cursors, backoff, and dedupe
 * - exposes helper methods for memory, actions, and messages
 *
 * It does not implement planning or execution logic by itself.
 *
 * Usage:
 *   EMPEROR_CLAW_API_TOKEN=... node examples/bridge.js
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API_URL = process.env.EMPEROR_CLAW_API_URL || "https://emperorclaw.malecu.eu";
const API_TOKEN = process.env.EMPEROR_CLAW_API_TOKEN;
const RUNTIME_ID = process.env.EMPEROR_CLAW_RUNTIME_ID || crypto.randomUUID();
const AGENT_ID = process.env.EMPEROR_CLAW_AGENT_ID || null;
const AGENT_NAME = process.env.EMPEROR_CLAW_AGENT_NAME || "Viktor";
const AGENT_ROLE = process.env.EMPEROR_CLAW_AGENT_ROLE || "manager";
const GATEWAY_VERSION = process.env.OPENCLAW_GATEWAY_VERSION || "unknown";
const HEARTBEAT_MS = Number(process.env.EMPEROR_CLAW_HEARTBEAT_MS || 30000);
const SYNC_MS = Number(process.env.EMPEROR_CLAW_SYNC_MS || 15000);
const CLAIM_LIMIT = Number(process.env.EMPEROR_CLAW_MAX_CONCURRENT_TASKS || 1);
const COMPANION_DIR =
  process.env.EMPEROR_CLAW_COMPANION_DIR
  || path.join(os.homedir(), ".openclaw", "emperor-control-plane");
const STATE_DIR =
  process.env.EMPEROR_CLAW_STATE_DIR
  || path.join(COMPANION_DIR, "state");
const BRIDGE_STATE_PATH =
  process.env.EMPEROR_CLAW_BRIDGE_STATE_PATH
  || path.join(STATE_DIR, "bridge-state.json");
const CONFIG_PATH =
  process.env.EMPEROR_CLAW_CONFIG_PATH
  || path.join(COMPANION_DIR, "bridge.config.json");
const RECONNECT_BASE_MS = Number(process.env.EMPEROR_CLAW_RECONNECT_BASE_MS || 2000);
const RECONNECT_MAX_MS = Number(process.env.EMPEROR_CLAW_RECONNECT_MAX_MS || 60000);
const DEDUPE_WINDOW = Number(process.env.EMPEROR_CLAW_DEDUPE_WINDOW || 1000);
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execFileAsync = promisify(execFile);
const OPENCLAW_GATEWAY_PORT = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
const OPENCLAW_GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || "***REMOVED***";
const VIKTOR_BRAIN_SESSION_KEY = process.env.EMPEROR_CLAW_BRAIN_SESSION_KEY || "hook:viktor:emperor-brain";
const VIKTOR_BRAIN_THINKING = process.env.EMPEROR_CLAW_BRAIN_THINKING || "medium";
const VIKTOR_BRAIN_AGENT_ID = process.env.EMPEROR_CLAW_BRAIN_AGENT_ID || "viktor";
const OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH || "openclaw";
const EMPEROR_CLAW_AUTO_CLAIM = String(process.env.EMPEROR_CLAW_AUTO_CLAIM || "false").toLowerCase() === "true";
const EMPEROR_CLAW_DEBUG_PROMPTS = String(process.env.EMPEROR_CLAW_DEBUG_PROMPTS || "false").toLowerCase() === "true";
const EMPEROR_CLAW_USE_EXECUTOR = String(process.env.EMPEROR_CLAW_USE_EXECUTOR || "false").toLowerCase() === "true";
const EMPEROR_CLAW_AGENT_PROFILE = process.env.EMPEROR_CLAW_AGENT_PROFILE
  || ((String(AGENT_NAME).toLowerCase() === "manager" || String(VIKTOR_BRAIN_AGENT_ID).toLowerCase() === "manager") ? "manager" : "operator");
const EMPEROR_CLAW_MANAGER_REVIEW_MS = Number(process.env.EMPEROR_CLAW_MANAGER_REVIEW_MS || 1800000);
const IS_MANAGER_PROFILE = EMPEROR_CLAW_AGENT_PROFILE === "manager";

if (!API_TOKEN) {
  console.error("EMPEROR_CLAW_API_TOKEN is required");
  process.exit(1);
}

function makeIdempotencyKey(prefix = "bridge") {
  return `${prefix}-${crypto.randomUUID()}`;
}

function stableHash(value) {
  const normalized = typeof value === "string" ? value : JSON.stringify(value);
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonFile(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

async function http(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.idempotencyKey
      ? { "Idempotency-Key": options.idempotencyKey }
      : options.idempotent
        ? { "Idempotency-Key": makeIdempotencyKey(options.idempotencyPrefix) }
        : {}),
    ...(options.headers || {}),
  };

  const response = await fetch(`${API_URL}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${options.method || "GET"} ${path} failed: ${response.status} ${text}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

async function callLocalOpenClawAgent(message, options = {}) {
  const args = [
    "agent",
    "--agent",
    options.agentId || VIKTOR_BRAIN_AGENT_ID,
    "--message",
    message,
    "--thinking",
    options.thinking || VIKTOR_BRAIN_THINKING,
    "--timeout",
    String(options.timeoutSeconds || 120),
    "--json",
  ];

  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  const { stdout, stderr } = await execFileAsync(OPENCLAW_CLI_PATH, args, {
    cwd: "/home/jose/.openclaw/workspace",
    timeout: (options.timeoutSeconds || 120) * 1000 + 5000,
    env: {
      ...process.env,
      OPENCLAW_GATEWAY_PORT: String(OPENCLAW_GATEWAY_PORT),
    },
    maxBuffer: 1024 * 1024,
  });

  let parsed = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = { raw: stdout, stderr };
  }

  const result = parsed?.result && typeof parsed.result === "object" ? parsed.result : parsed;

  const payloadTexts = Array.isArray(result?.payloads)
    ? result.payloads
        .map((item) => (item && typeof item.text === "string" ? item.text.trim() : ""))
        .filter(Boolean)
    : [];

  const extractedText = payloadTexts.length > 0
    ? payloadTexts.join("\n\n")
    : typeof result?.reply === "string" && result.reply.trim()
      ? result.reply.trim()
      : typeof result?.text === "string" && result.text.trim()
        ? result.text.trim()
        : typeof result?.message === "string" && result.message.trim()
          ? result.message.trim()
          : null;

  return {
    raw: parsed,
    stderr,
    text: extractedText,
    sessionId: result?.meta?.agentMeta?.sessionId || result?.sessionId || result?.session?.id || result?.session_id || parsed?.sessionId || null,
  };
}

function getWebSocketCtor() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  return require("ws");
}

function stripCodeFences(text) {
  const value = String(text || "").trim();
  if (value.startsWith("```") && value.endsWith("```")) {
    return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  }
  return value;
}

function parseStructuredEnvelope(text) {
  const cleaned = stripCodeFences(text);
  if (!cleaned || (!cleaned.startsWith("{") && !cleaned.startsWith("["))) {
    return null;
  }
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

function appendDebugLog(baseDir, entry) {
  try {
    const path = `${baseDir}/delegation-debug.log`;
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    fs.appendFileSync(path, `${line}\n`, "utf8");
  } catch (error) {
    console.error("[bridge] debug log write failed:", error.message);
  }
}

function getFallbackSharedOperatorDoctrine() {
  return [
    "Emperor Claw is the control plane and system of record; OpenClaw is the runtime executor.",
    "Connection model: API base is https://emperorclaw.malecu.eu, MCP REST base is https://emperorclaw.malecu.eu/api/mcp, websocket is wss://emperorclaw.malecu.eu/api/mcp/ws, and auth uses Authorization: Bearer <company_token> from EMPEROR_CLAW_API_TOKEN.",
    "Use Emperor as canonical for customers, projects, tasks, task notes/events, project memory, scoped resources, artifacts, threads, schedules, templates, tactics, playbooks, incidents, approvals, and agent context when relevant.",
    "Resources are first-class plain-text context via configText.",
    "Artifacts are first-class outputs via contentText.",
    "Do the work with OpenClaw capabilities, then report, coordinate, and persist the important results back into Emperor.",
  ].join("\n");
}

function getFallbackRoleOperatorOverlay(isManager) {
  if (isManager) {
    return [
      "Manager overlay:",
      "- Keep work moving by detecting blockers, stale work, overload, and missing ownership.",
      "- Delegate explicitly and use canonical Emperor state before judging status or ownership.",
      "- Do not pretend execution happened just because you recommended it.",
    ].join("\n");
  }

  return [
    "Worker overlay:",
    "- Understand the assigned task clearly before acting.",
    "- Execute honestly and report blockers early.",
    "- Keep Emperor state synchronized with reality.",
  ].join("\n");
}

function extractTaskRef(text) {
  const value = String(text || "");
  const match = value.match(/TASK-([A-F0-9]{8})/i);
  return match ? match[1].toUpperCase() : null;
}

function extractExplicitAgentMention(text) {
  const value = String(text || "");
  const match = value.match(/@([a-z0-9_-]+)/i);
  return match ? match[1] : null;
}

function isProjectCreationIntent(text) {
  const value = String(text || "").toLowerCase();
  return /\b(create|set up|setup|define|spin up|start)\b.{0,40}\bproject\b/.test(value)
    || /\b(break down|plan|scope)\b.{0,40}\b(goal|project|work)\b/.test(value)
    || /\bcreate\b.{0,40}\b(tasks|task list|plan)\b/.test(value);
}

class EmperorBridge {
  constructor() {
    this.agent = null;
    this.runtime = null;
    this.session = null;
    this.memory = null;
    this.companyContextNotes = null;
    this.integrations = [];
    this.socket = null;
    this.heartbeatTimer = null;
    this.syncTimer = null;
    this.controlSyncTimer = null;
    this.reconnectTimer = null;
    this.shutdownRequested = false;
    this.lastSeenAt = null;
    this.lastSyncAt = null;
    this.syncInFlight = false;
    this.claimInFlight = false;
    this.activeTasks = new Map();
    this.recentMessageIds = new Set();
    this.recentTaskFingerprints = new Set();
    this.pendingOperationIds = new Set();
    this.persistTimer = null;
    this.reconnectAttempt = 0;
    this.bridgeState = this.loadBridgeState();
    this.lastClaimKey = null;
    this.onMessage = null;
    this.onTask = null;
  }

  loadBridgeState() {
    const defaults = {
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      backoffMs: RECONNECT_BASE_MS,
      reconnectAttempt: 0,
      lastSeenAt: null,
      lastSyncAt: null,
      lastRuntimeId: null,
      lastSessionId: null,
      lastAgentId: null,
      lastManagerReviewAt: null,
      recentMessageIds: [],
      recentTaskFingerprints: [],
      pendingOperationIds: [],
    };
    const loaded = readJsonFile(BRIDGE_STATE_PATH);
    const state = loaded && typeof loaded === "object" ? { ...defaults, ...loaded } : defaults;
    state.recentMessageIds = Array.isArray(state.recentMessageIds) ? state.recentMessageIds.slice(-DEDUPE_WINDOW) : [];
    state.recentTaskFingerprints = Array.isArray(state.recentTaskFingerprints) ? state.recentTaskFingerprints.slice(-DEDUPE_WINDOW) : [];
    state.pendingOperationIds = Array.isArray(state.pendingOperationIds) ? state.pendingOperationIds.slice(-DEDUPE_WINDOW) : [];
    this.recentMessageIds = new Set(state.recentMessageIds);
    this.recentTaskFingerprints = new Set(state.recentTaskFingerprints);
    this.pendingOperationIds = new Set(state.pendingOperationIds);
    this.reconnectAttempt = Number(state.reconnectAttempt || 0);
    this.lastSeenAt = state.lastSeenAt || null;
    this.lastSyncAt = state.lastSyncAt || null;
    return state;
  }

  snapshotBridgeState() {
    return {
      ...this.bridgeState,
      updatedAt: new Date().toISOString(),
      backoffMs: this.bridgeState.backoffMs || RECONNECT_BASE_MS,
      reconnectAttempt: this.reconnectAttempt,
      lastSeenAt: this.lastSeenAt,
      lastSyncAt: this.lastSyncAt,
      lastRuntimeId: this.runtime?.runtimeId || this.bridgeState.lastRuntimeId || null,
      lastSessionId: this.session?.id || this.bridgeState.lastSessionId || null,
      lastAgentId: this.agent?.id || this.bridgeState.lastAgentId || null,
      recentMessageIds: Array.from(this.recentMessageIds).slice(-DEDUPE_WINDOW),
      recentTaskFingerprints: Array.from(this.recentTaskFingerprints).slice(-DEDUPE_WINDOW),
      pendingOperationIds: Array.from(this.pendingOperationIds).slice(-DEDUPE_WINDOW),
    };
  }

  persistBridgeState() {
    this.bridgeState = this.snapshotBridgeState();
    writeJsonFile(BRIDGE_STATE_PATH, this.bridgeState);
  }

  schedulePersistBridgeState() {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      try {
        this.persistBridgeState();
      } catch (error) {
        console.error("[bridge] failed to persist bridge state:", error.message);
      }
    }, 100);
  }

  rememberMessage(message) {
    const key = this.messageKey(message);
    if (this.recentMessageIds.has(key)) return false;
    this.recentMessageIds.add(key);
    while (this.recentMessageIds.size > DEDUPE_WINDOW) {
      this.recentMessageIds.delete(this.recentMessageIds.values().next().value);
    }
    this.schedulePersistBridgeState();
    return true;
  }

  rememberTask(task) {
    const key = this.taskKey(task);
    if (this.recentTaskFingerprints.has(key)) return false;
    this.recentTaskFingerprints.add(key);
    while (this.recentTaskFingerprints.size > DEDUPE_WINDOW) {
      this.recentTaskFingerprints.delete(this.recentTaskFingerprints.values().next().value);
    }
    this.schedulePersistBridgeState();
    return true;
  }

  messageKey(message = {}) {
    if (message.id) return `msg:${message.id}`;
    return `msg:${stableHash({
      threadId: message.threadId || message.thread_id || message.chat_id || null,
      senderId: message.senderId || null,
      createdAt: message.createdAt || null,
      text: message.text || null,
    })}`;
  }

  taskKey(task = {}) {
    if (!task) return "task:unknown";
    return `task:${task.id || "unknown"}:${task.state || task.status || "unknown"}:${task.updatedAt || task.lastUpdatedAt || task.assignedAgentId || "na"}`;
  }

  noteKey(taskId, note, handoff = null) {
    return `note:${taskId}:${stableHash({ note, handoff })}`;
  }

  resultKey(taskId, result) {
    return `result:${taskId}:${stableHash(result || {})}`;
  }

  checkpointKey(payload) {
    return `checkpoint:${stableHash(payload || {})}`;
  }

  messageSendKey(text, options = {}) {
    return `send:${stableHash({
      text,
      thread_id: options.thread_id || null,
      thread_type: options.thread_type || "team",
      targetAgentId: options.target_id || options.targetAgentId || null,
      agentId: this.agent?.id || null,
    })}`;
  }

  scheduleReconnect(reason) {
    if (this.shutdownRequested || this.reconnectTimer) return;
    const attempt = Math.max(0, Number(this.reconnectAttempt || 0));
    const baseDelay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * (2 ** attempt));
    const jitter = Math.floor(baseDelay * 0.2 * Math.random());
    const delay = Math.min(RECONNECT_MAX_MS, baseDelay + jitter);
    this.reconnectAttempt = attempt + 1;
    this.bridgeState.backoffMs = delay;
    this.bridgeState.reconnectAttempt = this.reconnectAttempt;
    this.schedulePersistBridgeState();
    console.warn(`[bridge] websocket disconnected (${reason}), retrying in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWebSocket();
    }, delay);
  }

  async bootstrap() {
    this.runtime = await this.registerRuntime();
    this.agent = await this.resolveAgent();
    const openclawSessionId = `openclaw-${Date.now()}`;
    const sessionPayload = await http(`/api/mcp/agents/${this.agent.id}/sessions/start`, {
      method: "POST",
      body: {
        runtimeId: this.runtime.runtimeId,
        openclawSessionId,
        sessionType: "main",
        channel: "bridge",
      },
    });

    this.session = sessionPayload.session;
    this.memory = sessionPayload.memory;
    this.companyContextNotes = sessionPayload.contextNotes || null;
    this.lastSeenAt = null;
    this.bridgeState.lastRuntimeId = this.runtime.runtimeId;
    this.bridgeState.lastAgentId = this.agent.id;
    this.bridgeState.lastSessionId = this.session.id;
    this.bridgeState.backoffMs = RECONNECT_BASE_MS;
    this.bridgeState.reconnectAttempt = 0;
    await this.refreshIntegrations();
    this.persistBridgeState();

    console.log(`[bridge] runtime=${this.runtime.runtimeId} agent=${this.agent.name} session=${this.session.id}`);
    console.log(`[bridge] memory snapshot loaded=${Boolean(this.memory?.snapshot)}`);
    console.log(`[bridge] company context loaded=${Boolean(this.companyContextNotes)}`);
    console.log(`[bridge] companion config=${CONFIG_PATH}`);
    console.log(`[bridge] state journal=${BRIDGE_STATE_PATH}`);
  }

  async registerRuntime() {
    const payload = await http("/api/mcp/runtime/register", {
      method: "POST",
      body: {
        runtimeId: RUNTIME_ID,
        name: `OpenClaw ${process.env.COMPUTERNAME || process.env.HOSTNAME || "runtime"}`,
        hostname: process.env.COMPUTERNAME || process.env.HOSTNAME || null,
        gatewayVersion: GATEWAY_VERSION,
        capabilitiesJson: ["bridge", "ws", "memory", "actions", "credentials"],
        startedAt: new Date().toISOString(),
      },
    });
    return payload.runtimeNode;
  }

  async resolveAgent() {
    const payload = await http("/api/mcp/agents?limit=200");
    const allAgents = payload.agents || [];

    let agent = null;
    if (AGENT_ID) {
      agent = allAgents.find((candidate) => candidate.id === AGENT_ID);
    }
    if (!agent) {
      agent = allAgents.find((candidate) => candidate.name === AGENT_NAME);
    }

    if (agent) return agent;

    const created = await http("/api/mcp/agents", {
      method: "POST",
      idempotent: true,
      body: {
        name: AGENT_NAME,
        role: AGENT_ROLE,
        skillsJson: ["bridge", "coordination"],
        memory: "## Session Context\nInitial bridge bootstrap.\n",
      },
    });

    return created.agent;
  }

  async start() {
    await this.bootstrap();
    this.onMessage = this.onMessage || this.defaultMessageHandler.bind(this);
    this.onTask = this.onTask || this.defaultTaskHandler.bind(this);
    await this.sendMessage("Bridge online. Control-plane connection established.", { chat_id: "team" });
    this.startHeartbeatLoop();
    this.startSyncLoop();
    this.connectWebSocket();
  }

  async refreshStatusSummary() {
    const payload = await http("/api/mcp", {
      method: "POST",
      body: {
        jsonrpc: "2.0",
        id: "status-summary",
        method: "status.summary",
        params: {},
      },
    });
    this.companyContextNotes = payload.result?.contextNotes || null;
    return payload.result || null;
  }

  async refreshIntegrations() {
    if (!this.agent) return [];
    const payload = await http(`/api/mcp/agents/${this.agent.id}/integrations`);
    this.integrations = payload.integrations || [];
    return this.integrations;
  }

  async leaseIntegration(integrationId, options = {}) {
    if (!this.agent) {
      throw new Error("Agent not initialized");
    }

    return http(`/api/mcp/agents/${this.agent.id}/integrations/${integrationId}/lease`, {
      method: "POST",
      body: {
        sessionId: options.sessionId || this.session?.id || null,
        reason: options.reason || null,
      },
    });
  }

  startHeartbeatLoop() {
    const tick = async () => {
      try {
        await http("/api/mcp/agents/heartbeat", {
          method: "POST",
          body: { agentId: this.agent.id, currentLoad: this.activeTasks.size },
        });
      } catch (error) {
        console.error("[bridge] heartbeat failed:", error.message);
      }
    };

    tick();
    this.heartbeatTimer = setInterval(tick, HEARTBEAT_MS);
  }

  startSyncLoop() {
    // Sync loop disabled for now; sync will be driven manually or by websocket events.
    return;
  }

  connectWebSocket() {
    if (this.shutdownRequested) return;
    const WebSocketCtor = getWebSocketCtor();
    const socketUrl = API_URL.replace(/^http/, "ws") + "/api/mcp/ws";

    this.socket = new WebSocketCtor(socketUrl, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });

    this.socket.onopen = () => {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.reconnectAttempt = 0;
      this.bridgeState.backoffMs = RECONNECT_BASE_MS;
      this.bridgeState.reconnectAttempt = 0;
      this.schedulePersistBridgeState();
      this.stopSyncFallback();
      console.log("[bridge] websocket connected");
      void this.syncControlPlane("ws-open");
    };

    this.socket.onmessage = async (event) => {
      const raw = typeof event.data === "string" ? event.data : event.data.toString();
      try {
        const payload = JSON.parse(raw);
        await this.handleRealtimeEvent(payload);
      } catch (error) {
        console.error("[bridge] failed to parse ws payload:", error.message);
      }
    };

    this.socket.onclose = () => {
      this.socket = null;
      this.startSyncFallback();
      this.scheduleReconnect("close");
    };

    this.socket.onerror = (error) => {
      this.startSyncFallback();
      console.error("[bridge] websocket error:", error.message || error);
      this.scheduleReconnect("error");
    };
  }

  startSyncFallback() {
    if (this.syncTimer) return;

    const loop = async () => {
      try {
        const payload = await http(`/api/mcp/messages/sync?mode=all${this.lastSeenAt ? `&since=${encodeURIComponent(this.lastSeenAt)}` : ""}`);
        const messages = payload.messages || [];
        if (messages.length > 0) {
          this.lastSeenAt = messages[messages.length - 1].createdAt;
          for (const message of messages) {
            await this.handlePolledMessage(message);
          }
        }
        await this.syncControlPlane("fallback");
      } catch (error) {
        console.error("[bridge] sync fallback failed:", error.message);
      }
    };

    void loop();
    this.syncTimer = setInterval(loop, 15000);
  }

  stopSyncFallback() {
    if (!this.syncTimer) return;
    clearInterval(this.syncTimer);
    this.syncTimer = null;
  }

  async handleRealtimeEvent(payload) {
    if (payload.type === "connected") {
      console.log("[bridge] ws tunnel established");
      return;
    }

    if (payload.type === "thread_message") {
      const message = payload.message;
      const thread = payload.thread;
      this.lastSeenAt = message?.createdAt || this.lastSeenAt;
      this.bridgeState.lastSeenAt = this.lastSeenAt;
      this.schedulePersistBridgeState();

      if (!this.rememberMessage(message)) return;

      // Ignore our own messages to avoid loops.
      if (message.senderId === this.agent?.id) return;

      console.log(`[bridge] incoming message in thread ${thread.id}: "${message.text}"`);
      await this.handleThreadMessage(message, thread);
      return;
    }

    if (payload.type === "new_task") {
      console.log(`[bridge] new_task id=${payload.task?.id || "unknown"} type=${payload.task?.taskType || "unknown"}`);
      await this.syncControlPlane("new_task");
      return;
    }

    if (payload.type === "task_updated") {
      console.log(`[bridge] task_updated id=${payload.task?.id || "unknown"} state=${payload.task?.state || "unknown"}`);
      await this.handleTaskUpdate(payload.task);
      return;
    }

    if (payload.type === "company_context_updated") {
      this.companyContextNotes = payload.company?.contextNotes || null;
      console.log("[bridge] company context updated via ws");
      return;
    }

    if (payload.type === "agent_integration_created" || payload.type === "agent_integration_archived") {
      if (payload.agentId === this.agent?.id) {
        await this.refreshIntegrations();
        console.log(`[bridge] integrations refreshed after ${payload.type}`);
      }
      return;
    }

    if (payload.type === "company_token_created") {
      console.log(`[bridge] company_token_created id=${payload.token?.id || "unknown"}`);
      return;
    }

    if (payload.type === "project_memory_added") {
      console.log(`[bridge] project_memory_added project=${payload.projectId || "unknown"} memory=${payload.memory?.id || "unknown"}`);
      return;
    }

    if (payload.type === "task_note_added") {
      console.log(`[bridge] task_note_added task=${payload.taskId || "unknown"} event=${payload.event?.id || "unknown"}`);
      return;
    }

    console.log("[bridge] realtime event:", payload.type);
  }

  async handlePolledMessage(message) {
    const thread = {
      id: message.threadId || message.thread_id || message.chat_id || "team",
      type: message.threadType || message.thread_type || "team",
    };
    if (!this.rememberMessage(message)) return;
    console.log("[bridge] polled message:", message.text);
    await this.handleThreadMessage(message, thread);
  }

  async handleThreadMessage(message, thread) {
    if (!message || !thread) return;
    if (message.senderId === this.agent?.id) return;
    const processedHumanMessages = this.bridgeState.processedHumanMessages || {};
    const processGuardKey = message.id ? `${thread.id}:${message.id}` : null;
    const normalizedText = String(message.text || "").trim().toLowerCase().replace(/\s+/g, " ");
    const recentTurnKey = normalizedText ? `${thread.id}:text:${normalizedText}` : null;
    if (processGuardKey && processedHumanMessages[processGuardKey]) {
      const ageMs = Date.now() - Date.parse(processedHumanMessages[processGuardKey]);
      if (Number.isFinite(ageMs) && ageMs < 30000) {
        console.log(`[bridge] duplicate message processing suppressed for ${processGuardKey}`);
        return;
      }
    }
    if (recentTurnKey && processedHumanMessages[recentTurnKey]) {
      const ageMs = Date.now() - Date.parse(processedHumanMessages[recentTurnKey]);
      if (Number.isFinite(ageMs) && ageMs < 15000) {
        console.log(`[bridge] duplicate recent-turn text suppressed for ${recentTurnKey}`);
        return;
      }
    }
    if (processGuardKey || recentTurnKey) {
      this.bridgeState.processedHumanMessages = this.bridgeState.processedHumanMessages || {};
      const nowIso = new Date().toISOString();
      if (processGuardKey) this.bridgeState.processedHumanMessages[processGuardKey] = nowIso;
      if (recentTurnKey) this.bridgeState.processedHumanMessages[recentTurnKey] = nowIso;
      const keys = Object.keys(this.bridgeState.processedHumanMessages);
      if (keys.length > 500) {
        keys.sort((a, b) => String(this.bridgeState.processedHumanMessages[a]).localeCompare(String(this.bridgeState.processedHumanMessages[b])));
        for (const key of keys.slice(0, keys.length - 500)) {
          delete this.bridgeState.processedHumanMessages[key];
        }
      }
      this.schedulePersistBridgeState();
    }
    if (this.onMessage) {
      await this.onMessage(message, thread);
    }
  }

  async handleTaskUpdate(task) {
    if (!task || !task.id) return;
    if (!this.rememberTask(task)) return;
    if (task.assignedAgentId === this.agent?.id) {
      this.activeTasks.set(task.id, task);
    }
    if (task.state === "done" || task.state === "failed") {
      this.activeTasks.delete(task.id);
      if (this.lastClaimKey) {
        this.pendingOperationIds.delete(this.lastClaimKey);
      }
      this.schedulePersistBridgeState();
      await this.checkpoint(
        {
          lastTaskId: task.id,
          lastTaskState: task.state,
          activeTaskCount: this.activeTasks.size,
          reason: "task_updated",
        },
        `Task ${task.id} ${task.state}`,
      );
    }
  }

  async defaultMessageHandler(message, thread) {
    const text = String(message?.text || "").trim();
    const agentName = String(this.agent?.name || AGENT_NAME || "Viktor").trim();
    const lowered = text.toLowerCase();
    const mentionsAgent = agentName
      ? lowered.includes(`@${agentName.toLowerCase()}`) || lowered.includes(agentName.toLowerCase())
      : false;
    const isDirectThread = String(thread?.type || "").toLowerCase() === "direct";
    const senderType = String(message?.senderType || "unknown").toLowerCase();
    const isHuman = senderType === "human" || senderType === "user";
    const isAgentSender = senderType === "agent";
    const lowSignal = !text || text.length < 4;
    const taskRef = extractTaskRef(text);
    const explicitAtMention = agentName ? lowered.includes(`@${agentName.toLowerCase()}`) : false;

    if (IS_MANAGER_PROFILE) {
      if (!isHuman || lowSignal || !explicitAtMention) {
        console.log(`[bridge] manager ignoring thread ${thread.id} message (human=${isHuman} lowSignal=${lowSignal} mentions=${explicitAtMention})`);
        return;
      }
    } else if (isAgentSender) {
      const explicitAgentInstruction = explicitAtMention;
      if (!explicitAgentInstruction) {
        console.log(`[bridge] ignoring agent message in thread ${thread.id} without explicit @${agentName} mention`);
        return;
      }
    } else if (!isDirectThread && !explicitAtMention) {
      console.log(`[bridge] ignoring thread ${thread.id} message without explicit @${agentName} mention`);
      return;
    }

    const mentionedAgentRef = extractExplicitAgentMention(text.replace(new RegExp(`@${agentName}`, 'ig'), '').trim()) || null;

    await this.updateChatStatus(thread.id, true, true);
    await this.writeMemory(
      `Observed thread ${thread.id} message mentioning ${agentName} from ${message.senderType || "unknown"} at ${new Date().toISOString()}.`,
      {
        kind: "thread_observation",
        taskId: message.taskId || null,
        summary: `Observed thread ${thread.id}`,
        metadataJson: {
          threadId: thread.id,
          threadType: thread.type,
          senderId: message.senderId || null,
          agentName,
          matchedByMention: true,
        },
      },
    );

    let liveContext = null;
    try {
      liveContext = await this.buildLiveContextForMessage(text);
    } catch (error) {
      console.error("[bridge] live context fetch failed:", error.message);
    }

    let claimedTask = null;
    let referencedTask = null;
    let referencedTaskContext = null;
    if (taskRef) {
      try {
        referencedTask = await this.findTaskByRef(taskRef);
        if (referencedTask) {
          console.log(`[bridge] task-ref resolved TASK-${taskRef} -> ${referencedTask.id} assignedAgentId=${referencedTask.assignedAgentId || 'null'} state=${referencedTask.state || 'unknown'}`);
          appendDebugLog(COMPANION_DIR, { kind: "task-ref-resolved", bridgeAgent: agentName, taskRef, taskId: referencedTask.id, assignedAgentId: referencedTask.assignedAgentId || null, state: referencedTask.state || null });
          try {
            referencedTaskContext = await this.fetchTaskContext(referencedTask.id);
          } catch (contextError) {
            console.error("[bridge] task context fetch failed:", contextError.message);
          }

          const taskContextBlock = this.formatTaskContextBundle(referencedTaskContext);
          if (taskContextBlock) {
            liveContext = liveContext ? `${taskContextBlock}\n\n${liveContext}` : taskContextBlock;
          } else {
            const taskSummary = `Referenced task: TASK-${taskRef} => ${referencedTask.title || referencedTask.goal || referencedTask.id} [state=${referencedTask.state || "unknown"}, type=${referencedTask.taskType || "unknown"}]`;
            liveContext = liveContext ? `${taskSummary}\n\n${liveContext}` : taskSummary;
          }
        } else {
          console.log(`[bridge] task-ref TASK-${taskRef} did not resolve`);
        }
      } catch (error) {
        console.error("[bridge] task ref lookup failed:", error.message);
      }
    }

    const doctrine = await this.getDoctrinePromptParts(IS_MANAGER_PROFILE);
    const forceSharedResources = await this.getForceSharedResourcesForAgent();
    const prompt = [
      `You are ${agentName}, replying to an Emperor Claw thread as a helpful assistant.`,
      `Reply naturally and helpfully as ${agentName}.`,
      `Shared Emperor doctrine:\n${doctrine.sharedText}`,
      `Role overlay:\n${doctrine.roleText}`,
      forceSharedResources ? `${forceSharedResources}` : null,
      `Only answer the user's latest message; do not mention internal bridges, hooks, or routing.`,
      `Use your Emperor MCP understanding directly. Reply naturally. Do not emit raw JSON or action envelopes in chat. If you need Emperor state or context, use it directly rather than describing a bridge contract.`,
      `Emperor MCP lets you directly read/use customers, projects, tasks, notes, project memory, resources, artifacts, threads, templates, tactics, playbooks, incidents, approvals, schedules, and agent context when relevant. Resources are plain text/context; artifacts are preserved outputs.`,
      `If the human asks to create a project, define a project, break down a goal, or set up work, do the work directly using Emperor/OpenClaw where appropriate and answer naturally.`,
      `When another agent delegates work, only treat it as actionable if it explicitly uses @${agentName} and includes a concrete task/work verb. If a TASK-XXXXXXXX reference is present, use that specific task as the intended target.`,
      `If a TASK-XXXXXXXX reference is present, prefer the canonical Emperor task detail/context in the prompt over chat memory. Do not claim that task details are missing unless the canonical task detail is genuinely empty or retrieval failed.`,
      `If the human asks whether work is finished, blocked, or what the task says, ground the reply in the referenced task's state, notes, acceptance criteria, deliverables, and visible blockers before answering.`,
      `If the human asks an epistemic/context question like whether you know, remember, understand, or have full context, answer once in one concise paragraph. Be truthful, but do not layer multiple hedges, restatements, or near-duplicate answers.`,
      `Reply naturally. Do not emit JSON in chat. Use your judgment and your available Emperor/OpenClaw capabilities directly.`,
      IS_MANAGER_PROFILE
        ? `Use the Agent profiles in Emperor to delegate intentionally. When execution work should go to a worker like Viktor, prefer a visible team-thread delegation via thread_reply tagging @Viktor with a concrete instruction. Use explicit @agent-name mentions for agent-to-agent delegation. If the human references a TASK-XXXXXXXX id, include that exact task reference in the delegation. Keep your human-facing reply natural and concise.`
        : `If another agent such as Manager delegates execution work to you, treat a concrete @${agentName} instruction about taking or working on a task as actionable and stay honest about progress, blockers, and results. Keep your updates natural and do not emit action envelopes in chat.`,
      IS_MANAGER_PROFILE
        ? `When asked to create a project for a goal, behave like an operator-planner: propose or carry out a clear lightweight project shape, seed useful context, and suggest a small initial executable task breakdown. Keep the reply natural and do not emit JSON in chat.`
        : `If another agent such as Manager delegates execution work to you, stay practical and honest. If work is done, say what happened plainly; if blocked, say what is missing; if follow-up state should exist in Emperor, refer to it naturally rather than emitting structured JSON in chat.`,
      liveContext ? `Live Emperor context:\n${liveContext}` : null,
      `Thread ID: ${thread.id}`,
      `Thread type: ${thread.type}`,
      `Sender type: ${message.senderType || "unknown"}`,
      `Latest message: ${text}`,
    ].filter(Boolean).join("\n\n");

    const handledReplies = this.bridgeState.handledReplies || {};
    const replyGuardKey = message.id ? `${thread.id}:${message.id}` : null;
    if (replyGuardKey && handledReplies[replyGuardKey]) {
      console.log(`[bridge] duplicate reply suppressed for ${replyGuardKey}`);
      await this.updateChatStatus(thread.id, false);
      return;
    }

    let replyText = null;
    try {
      const knownSessionId = this.bridgeState.viktorBrainSessionId || null;
      const useFreshSession = false;
      if (EMPEROR_CLAW_DEBUG_PROMPTS && IS_MANAGER_PROFILE && isProjectCreationIntent(text)) {
        appendDebugLog(COMPANION_DIR, {
          kind: "project-create-prompt",
          bridgeAgent: agentName,
          threadId: thread.id,
          text,
          prompt,
          liveContext: liveContext || null,
          knownSessionId,
          useFreshSession,
        });
      }
      const agentResult = await callLocalOpenClawAgent(prompt, {
        sessionId: useFreshSession ? null : knownSessionId,
        thinking: VIKTOR_BRAIN_THINKING,
        timeoutSeconds: 120,
      });
      const nextSessionId = agentResult?.sessionId || null;
      if (nextSessionId) {
        this.bridgeState.viktorBrainSessionId = nextSessionId;
        this.schedulePersistBridgeState();
      }
      let structured = parseStructuredEnvelope(agentResult?.text || "");
      if (!EMPEROR_CLAW_USE_EXECUTOR && structured) {
        const naturalRetryPrompt = [
          prompt,
          "Your previous draft looked like a structured JSON/action envelope.",
          "Do not emit JSON, action envelopes, or code blocks.",
          "Reply as a normal teammate in natural language only.",
          "Do not mention bridge contracts, action lists, or schema rules unless explicitly asked.",
        ].join("\n\n");
        const naturalRetry = await callLocalOpenClawAgent(naturalRetryPrompt, {
          sessionId: null,
          thinking: VIKTOR_BRAIN_THINKING,
          timeoutSeconds: 120,
        });
        structured = parseStructuredEnvelope(naturalRetry?.text || "");
        if (!structured) {
          agentResult.text = naturalRetry?.text || agentResult?.text || "";
        }
      }
      if (EMPEROR_CLAW_DEBUG_PROMPTS && IS_MANAGER_PROFILE && isProjectCreationIntent(text)) {
        appendDebugLog(COMPANION_DIR, {
          kind: "project-create-first-output",
          bridgeAgent: agentName,
          threadId: thread.id,
          structured: Boolean(structured),
          output: agentResult?.text || "",
          prompt,
          liveContext: liveContext || null,
          executorEnabled: false,
        });
      }
      replyText = agentResult?.text || null;
    } catch (error) {
      console.error("[bridge] viktor brain handoff failed:", error.message);
      replyText = IS_MANAGER_PROFILE ? null : "I hit a local brain handoff issue just now. Please try again in a moment.";
    }

    if (!replyText || !String(replyText).trim()) {
      if (IS_MANAGER_PROFILE) {
        console.log("[bridge] suppressing unusable reply");
        await this.updateChatStatus(thread.id, false);
        return;
      }
      replyText = "I saw your message, but I don't have a usable reply yet.";
    }

    replyText = String(replyText).trim();
    if (/\b(do you|you do)\b.*\b(full context|understand|know|remember)\b|\bfull context\b|\bunderstand the emperor mcp\b/i.test(text)) {
      replyText = replyText
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
        .slice(0, 2)
        .join("\n\n");
      const sentences = replyText.match(/[^.!?]+[.!?]+/g);
      if (sentences && sentences.length > 3) {
        replyText = sentences.slice(0, 3).join(" ").trim();
      }
    }

    const sent = await this.sendChatReplyOnce(replyText, {
      thread_id: thread.id,
      thread_type: thread.type,
    });
    if (!sent) {
      await this.updateChatStatus(thread.id, false);
      return;
    }
    if (replyGuardKey) {
      this.bridgeState.handledReplies = this.bridgeState.handledReplies || {};
      this.bridgeState.handledReplies[replyGuardKey] = new Date().toISOString();
      const keys = Object.keys(this.bridgeState.handledReplies);
      if (keys.length > 500) {
        keys.sort((a, b) => String(this.bridgeState.handledReplies[a]).localeCompare(String(this.bridgeState.handledReplies[b])));
        for (const key of keys.slice(0, keys.length - 500)) {
          delete this.bridgeState.handledReplies[key];
        }
      }
      this.schedulePersistBridgeState();
      if (EMPEROR_CLAW_DEBUG_PROMPTS && IS_MANAGER_PROFILE && isProjectCreationIntent(text)) {
        appendDebugLog(COMPANION_DIR, {
          kind: "project-create-final-reply",
          bridgeAgent: agentName,
          threadId: thread.id,
          messageId: message.id || null,
          replyText: String(replyText).trim(),
        });
      }
    }
    await this.updateChatStatus(thread.id, false);
    await this.checkpoint(
      {
        reason: "thread_message",
        threadId: thread.id,
        threadType: thread.type,
        lastSeenMessageId: message.id || null,
        brainSessionKey: VIKTOR_BRAIN_SESSION_KEY,
      },
      `Processed thread ${thread.id}`,
    );
  }

  async sendChatReplyOnce(text, target = {}) {
    const replyText = String(text || '').trim();
    if (!replyText) return false;
    const threadId = target.thread_id || target.threadId || target.chat_id || target.chatId || 'unknown';
    const normalizedReplyText = replyText.toLowerCase().replace(/\s+/g, ' ').trim();
    const outgoingReplyKey = normalizedReplyText ? `${threadId}:reply:${normalizedReplyText}` : null;
    const recentReplies = this.bridgeState.recentReplies || {};
    if (outgoingReplyKey && recentReplies[outgoingReplyKey]) {
      const ageMs = Date.now() - Date.parse(recentReplies[outgoingReplyKey]);
      if (Number.isFinite(ageMs) && ageMs < 60000) {
        console.log(`[bridge] duplicate outgoing reply suppressed for ${outgoingReplyKey}`);
        return false;
      }
    }
    await this.sendMessage(replyText, target);
    const nowIso = new Date().toISOString();
    this.bridgeState.recentReplies = this.bridgeState.recentReplies || {};
    if (outgoingReplyKey) this.bridgeState.recentReplies[outgoingReplyKey] = nowIso;
    const recentKeys = Object.keys(this.bridgeState.recentReplies);
    if (recentKeys.length > 500) {
      recentKeys.sort((a, b) => String(this.bridgeState.recentReplies[a]).localeCompare(String(this.bridgeState.recentReplies[b])));
      for (const key of recentKeys.slice(0, recentKeys.length - 500)) {
        delete this.bridgeState.recentReplies[key];
      }
    }
    this.schedulePersistBridgeState();
    return true;
  }

  async defaultTaskHandler(task) {
    console.log(`[agent-brain] task ${task.id} claimed but no executor is attached`);
    await this.writeMemory(
      `Claimed task ${task.id} without a local executor attached.`,
      {
        kind: "task_claim",
        taskId: task.id,
        projectId: task.projectId || null,
        summary: `Claimed task ${task.id}`,
        metadataJson: {
          taskState: task.state || null,
          reason: "no_executor",
        },
      },
    );
    return null;
  }

  async syncControlPlane(reason = "manual") {
    if (this.syncInFlight) return null;
    this.syncInFlight = true;
    try {
      const [health, tasksPayload, threadsPayload] = await Promise.allSettled([
        http("/api/mcp/runtime/health"),
        http("/api/mcp/tasks"),
        http("/api/mcp/threads?type=team"),
      ]);

      this.lastSyncAt = new Date().toISOString();

      const tasks = tasksPayload.status === "fulfilled"
        ? (Array.isArray(tasksPayload.value) ? tasksPayload.value : tasksPayload.value?.tasks || [])
        : [];
      const teamThreads = threadsPayload.status === "fulfilled"
        ? (Array.isArray(threadsPayload.value) ? threadsPayload.value : threadsPayload.value?.threads || [])
        : [];

      console.log(
        `[bridge] sync ${reason}: tasks=${tasks.length} teamThreads=${teamThreads.length} active=${this.activeTasks.size}`,
      );
      this.lastSyncAt = new Date().toISOString();
      this.bridgeState.lastSyncAt = this.lastSyncAt;
      this.schedulePersistBridgeState();

      if (health.status === "fulfilled" && health.value?.ok === false) {
        console.warn("[bridge] control-plane health reported not ok");
      }

      if (EMPEROR_CLAW_AUTO_CLAIM && this.activeTasks.size < CLAIM_LIMIT) {
        const claimable = tasks.filter((task) => {
          const state = String(task.state || task.status || "").toLowerCase();
          return state === "inbox" || state === "queued";
        });
        if (claimable.length > 0) {
          await this.claimNextTask(reason);
        }
      }

      const snapshot = { tasks, teamThreads };
      if (IS_MANAGER_PROFILE) {
        try {
          await this.maybeRunManagerReview(snapshot, reason);
        } catch (error) {
          console.error("[bridge] manager review failed:", error.message);
        }
      }
      return snapshot;
    } finally {
      this.syncInFlight = false;
    }
  }

  async claimNextTask(reason = "sync") {
    if (this.claimInFlight || this.activeTasks.size >= CLAIM_LIMIT) return null;
    this.claimInFlight = true;
    try {
      const claimKey = `claim:${stableHash({
        agentId: this.agent?.id || null,
        runtimeId: this.runtime?.runtimeId || null,
        reason,
        activeTaskIds: Array.from(this.activeTasks.keys()),
        lastSeenAt: this.lastSeenAt,
      })}`;
      const payload = await http("/api/mcp/tasks/claim", {
        method: "POST",
        idempotencyKey: claimKey,
        body: {
          agentId: this.agent.id,
          strictOwnerRole: true,
          allowedRoles: this.agent?.role ? [this.agent.role] : [],
        },
      });
      const task = payload.task || null;
      if (!task) {
        console.log(`[bridge] no tasks available during ${reason}`);
        return null;
      }

      this.activeTasks.set(task.id, task);
      this.lastClaimKey = claimKey;
      this.pendingOperationIds.add(claimKey);
      this.bridgeState.pendingOperationIds = Array.from(this.pendingOperationIds).slice(-DEDUPE_WINDOW);
      this.schedulePersistBridgeState();
      console.log(`[bridge] claimed task ${task.id} (${task.state || "unknown"})`);
      await this.writeTaskNote(task.id, `Bridge claimed this task during ${reason}. This adapter is monitoring lease, thread updates, and checkpoints.`, {
        fromRole: this.agent?.role || "agent",
        toRole: "executor",
        summary: "Bridge claim acknowledgement",
        nextStep: "Run local execution or hand off to a real executor.",
      }, `task-note:${task.id}:${reason}:claim`);
      await this.checkpoint(
        {
          reason,
          activeTaskIds: Array.from(this.activeTasks.keys()),
          claimedTaskId: task.id,
          claimedTaskState: task.state || null,
          lastSyncAt: this.lastSyncAt,
        },
        `Claimed task ${task.id}`,
        `checkpoint:${task.id}:${reason}:claim`,
      );

      if (this.onTask) {
        const result = await this.onTask(task);
        if (result && result.state) {
          await this.reportTaskResult(task.id, result, `task-result:${task.id}:${stableHash(result)}`);
          this.activeTasks.delete(task.id);
          if (this.lastClaimKey) {
            this.pendingOperationIds.delete(this.lastClaimKey);
          }
          this.schedulePersistBridgeState();
        }
      }

      return task;
    } catch (error) {
      console.error("[bridge] task claim failed:", error.message);
      return null;
    } finally {
      this.claimInFlight = false;
    }
  }

  async writeTaskNote(taskId, note, handoff = null, idempotencyKey = null) {
    return http(`/api/mcp/tasks/${taskId}/notes`, {
      method: "POST",
      idempotencyKey: idempotencyKey || this.noteKey(taskId, note, handoff),
      body: {
        note,
        agentId: this.agent.id,
        handoff,
      },
    });
  }

  async reportTaskResult(taskId, result, idempotencyKey = null) {
    return http(`/api/mcp/tasks/${taskId}/result`, {
      method: "POST",
      idempotencyKey: idempotencyKey || this.resultKey(taskId, result),
      body: {
        state: result.state,
        agentId: this.agent.id,
        outputJson: result.outputJson || null,
        comment: result.comment || null,
        approvalRationale: result.approvalRationale || null,
        confidence: result.confidence || 0,
      },
    });
  }

  async writeMemory(content, options = {}) {
    const payload = await http(`/api/mcp/agents/${this.agent.id}/memory`, {
      method: "POST",
      idempotencyKey: options.idempotencyKey || `memory:${stableHash({
        content,
        kind: options.kind || "context",
        projectId: options.projectId || null,
        taskId: options.taskId || null,
        sessionId: this.session?.id || null,
        snapshot: options.snapshot || null,
        metadataJson: options.metadataJson || null,
      })}`,
      body: {
        sessionId: this.session.id,
        kind: options.kind || "context",
        projectId: options.projectId || null,
        taskId: options.taskId || null,
        content,
        summary: options.summary || null,
        metadataJson: options.metadataJson || {},
        snapshot: options.snapshot || null,
      },
    });
    this.memory = payload;
    return payload;
  }

  async addProjectMemory(projectId, content, summary = null) {
    return http(`/api/mcp/projects/${projectId}/memory`, {
      method: "POST",
      idempotencyKey: `project-memory:${stableHash({ projectId, content, summary })}`,
      body: {
        content,
        summary,
      },
    });
  }

  async executeStructuredEnvelope(envelope, context = {}) {
    if (!envelope || typeof envelope !== "object") {
      return { replyText: null, executed: [], errors: [] };
    }

    const executionContext = {
      ...context,
      lastProjectId: context.projectId || null,
      lastTaskId: context.taskId || null,
    };
    const resolveToken = (value) => {
      if (value === "$LAST_PROJECT_ID") return executionContext.lastProjectId || null;
      if (value === "$LAST_TASK_ID") return executionContext.lastTaskId || null;
      return value;
    };

    const executed = [];
    const errors = [];
    const actions = Array.isArray(envelope.actions) ? envelope.actions : [];
    for (const rawAction of actions) {
      if (!rawAction || typeof rawAction !== "object") continue;
      let action = rawAction;
      let type = String(action.type || "").trim();
      if (!type) {
        const keys = Object.keys(action);
        if (keys.length === 1 && action[keys[0]] && typeof action[keys[0]] === "object") {
          type = String(keys[0]).trim();
          action = { type, ...action[keys[0]] };
        }
      }
      try {
        if (type === "task_note") {
          const taskId = resolveToken(action.task_id || action.taskId || executionContext.taskId || null);
          const note = String(action.note || "").trim();
          if (!taskId || !note) continue;
          await this.writeTaskNote(taskId, note, action.handoff || null);
          executed.push({ type, taskId });
          continue;
        }

        if (type === "task_result") {
          const taskId = resolveToken(action.task_id || action.taskId || executionContext.taskId || null);
          const state = String(action.state || "").trim();
          if (!taskId || !["done", "failed", "review"].includes(state)) continue;
          await this.reportTaskResult(taskId, {
            state,
            comment: action.comment || null,
            outputJson: action.output_json || action.outputJson || null,
            confidence: typeof action.confidence === "number" ? action.confidence : 0,
          });
          executed.push({ type, taskId, state });
          continue;
        }

        if (type === "thread_reply") {
          const text = String(action.text || "").trim();
          if (!text) continue;
          await this.sendMessage(text, {
            thread_id: resolveToken(action.thread_id || action.threadId || executionContext.threadId || null),
            thread_type: action.thread_type || action.threadType || executionContext.threadType || null,
            targetAgentId: resolveToken(action.target_agent_id || action.targetAgentId || null),
            chat_id: action.chat_id || action.chatId || executionContext.chatId || null,
          });
          executed.push({ type, threadId: resolveToken(action.thread_id || action.threadId || executionContext.threadId || null) });
          continue;
        }

        if (type === "task_assign") {
          const taskId = resolveToken(action.task_id || action.taskId || executionContext.taskId || null);
          const agentRef = resolveToken(action.agent_id || action.agentId || null);
          const mode = action.mode === "claim" ? "claim" : "assign";
          if (!taskId || !agentRef) continue;
          const resolvedAgent = await this.resolveAgentRef(agentRef);
          console.log(`[bridge] task_assign requested taskId=${taskId} agentRef=${agentRef} resolvedAgentId=${resolvedAgent?.id || 'null'} resolvedAgentName=${resolvedAgent?.name || 'null'} mode=${mode}`);
          appendDebugLog(COMPANION_DIR, { kind: "task-assign-requested", taskId, agentRef, resolvedAgentId: resolvedAgent?.id || null, resolvedAgentName: resolvedAgent?.name || null, mode });
          if (!resolvedAgent?.id) {
            console.error(`[bridge] task_assign could not resolve agent ref: ${agentRef}`);
            continue;
          }
          const payload = await http(`/api/mcp/tasks/${taskId}/assign`, {
            method: "POST",
            idempotencyKey: `task-assign:${stableHash({ taskId, agentId: resolvedAgent.id, mode })}`,
            body: { agentId: resolvedAgent.id, mode },
          });
          console.log(`[bridge] task_assign success taskId=${taskId} assignedAgentId=${resolvedAgent.id} mode=${mode}`);
          appendDebugLog(COMPANION_DIR, { kind: "task-assign-success", taskId, assignedAgentId: resolvedAgent.id, mode });
          executed.push({ type, taskId, agentId: resolvedAgent.id, mode, payload });
          continue;
        }

        if (type === "project_memory") {
          const projectId = resolveToken(action.project_id || action.projectId || executionContext.projectId || executionContext.lastProjectId || null);
          const content = String(action.content || "").trim();
          if (!projectId || !content) continue;
          await this.addProjectMemory(projectId, content, action.summary || null);
          executed.push({ type, projectId });
          continue;
        }

        if (type === "project_create") {
          const goal = String(action.goal || "").trim();
          if (!goal) continue;
          const leadAgentRef = resolveToken(action.lead_agent_id || action.leadAgentId || null);
          const resolvedLeadAgent = leadAgentRef ? await this.resolveAgentRef(leadAgentRef) : null;
          const customerId = resolveToken(action.customer_id || action.customerId || null);
          const payload = await http("/api/mcp/projects", {
            method: "POST",
            idempotencyKey: `project-create:${stableHash({ goal, customerId })}`,
            body: {
              goal,
              customerId,
              status: action.status || "active",
              leadAgentId: resolvedLeadAgent?.id || null,
              maxActiveAgents: typeof action.max_active_agents === "number" ? action.max_active_agents : (typeof action.maxActiveAgents === "number" ? action.maxActiveAgents : 3),
            },
          });
          const project = payload?.project || null;
          if (project?.id) {
            executionContext.projectId = project.id;
            executionContext.lastProjectId = project.id;
          }
          executed.push({ type, projectId: project?.id || null, payload });
          continue;
        }

        if (type === "task_create") {
          const projectId = resolveToken(action.project_id || action.projectId || executionContext.projectId || executionContext.lastProjectId || null);
          const taskType = String(action.task_type || action.taskType || "").trim();
          const title = String(action.title || "").trim();
          const description = String(action.description || "").trim();
          if (!projectId || !taskType || !title || !description) continue;
          const payload = await http("/api/mcp/tasks", {
            method: "POST",
            idempotencyKey: `task-create:${stableHash({ projectId, taskType, title, description })}`,
            body: {
              projectId,
              taskType,
              title,
              description,
              acceptanceCriteria: action.acceptance_criteria || action.acceptanceCriteria || [],
              definitionOfDone: action.definition_of_done || action.definitionOfDone || null,
              deliverables: action.deliverables || [],
              ownerRole: action.owner_role || action.ownerRole || null,
              priority: typeof action.priority === "number" ? action.priority : 0,
              blockedByTaskIds: action.blocked_by_task_ids || action.blockedByTaskIds || [],
            },
          });
          if (payload?.task?.id) {
            executionContext.taskId = payload.task.id;
            executionContext.lastTaskId = payload.task.id;
          }
          executed.push({ type, projectId, taskId: payload?.task?.id || null, payload });
          continue;
        }
      } catch (error) {
        console.error(`[bridge] structured action ${type} failed:`, error.message);
        errors.push({ type, error: error.message });
      }
    }

    return {
      replyText: typeof envelope.reply_text === "string" ? envelope.reply_text.trim() : null,
      status: typeof envelope.status === "string" ? envelope.status.trim() : null,
      summary: typeof envelope.summary === "string" ? envelope.summary.trim() : null,
      executed,
      errors,
    };
  }

  async fetchCustomers() {
    const payload = await http("/api/mcp/customers", { method: "GET" });
    return Array.isArray(payload?.customers) ? payload.customers : Array.isArray(payload) ? payload : [];
  }

  async fetchProjects() {
    const payload = await http("/api/mcp/projects", { method: "GET" });
    return Array.isArray(payload?.projects) ? payload.projects : Array.isArray(payload) ? payload : [];
  }

  async fetchTasks(projectId = null) {
    const suffix = projectId ? `?projectId=${encodeURIComponent(projectId)}` : "";
    const payload = await http(`/api/mcp/tasks${suffix}`, { method: "GET" });
    return Array.isArray(payload?.tasks) ? payload.tasks : Array.isArray(payload) ? payload : [];
  }

  async fetchTaskDetail(taskId) {
    if (!taskId) return null;
    const payload = await http(`/api/mcp/tasks/${taskId}`, { method: "GET" });
    return payload?.task || null;
  }

  async fetchTaskContext(taskId) {
    if (!taskId) return null;
    return http(`/api/mcp/tasks/${taskId}/context`, { method: "GET" });
  }

  formatTaskContextBundle(bundle) {
    if (!bundle || typeof bundle !== "object") return null;
    const task = bundle.task || null;
    if (!task) return null;

    const sections = [];
    const taskLines = [
      `Task: ${task.title || task.goal || task.id}`,
      `Task ID: ${task.id}`,
      `Task ref: TASK-${task.shortCode || String(task.id || '').slice(0, 8).toUpperCase()}`,
      `State: ${task.state || 'unknown'}`,
      `Type: ${task.taskType || 'unknown'}`,
      `Priority: ${task.priority ?? 'unknown'}`,
      `Assigned agent: ${task.assignedAgent?.name || task.assignedAgentId || 'unassigned'}`,
      `Project: ${task.project?.goal || task.project?.name || task.projectId || 'unknown'}`,
      `Customer: ${task.customer?.name || task.customerId || 'none'}`,
    ];
    if (task.description) taskLines.push(`Description: ${task.description}`);
    if (task.definitionOfDone) taskLines.push(`Definition of done: ${task.definitionOfDone}`);
    if (task.blockedReason) taskLines.push(`Blocked reason: ${task.blockedReason}`);
    sections.push(taskLines.join("\n"));

    if (Array.isArray(task.acceptanceCriteria) && task.acceptanceCriteria.length > 0) {
      sections.push(`Acceptance criteria:\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`);
    }

    if (Array.isArray(task.deliverables) && task.deliverables.length > 0) {
      sections.push(`Deliverables:\n${task.deliverables.map((item) => `- ${item}`).join("\n")}`);
    }

    if (Array.isArray(bundle.notes) && bundle.notes.length > 0) {
      const noteLines = bundle.notes.slice(-10).map((event) => {
        const payload = event?.payloadJson || {};
        const note = typeof payload.note === 'string' ? payload.note : null;
        const handoff = payload.handoff && typeof payload.handoff === 'object' ? payload.handoff : null;
        if (note) return `- [${event.eventType || 'event'}] ${note}`;
        if (handoff) return `- [${event.eventType || 'handoff'}] ${handoff.fromRole || 'unknown'} -> ${handoff.toRole || 'unknown'} | ${handoff.summary || ''}`;
        return `- [${event.eventType || 'event'}] ${JSON.stringify(payload).slice(0, 240)}`;
      });
      sections.push(`Recent task notes/events:\n${noteLines.join("\n")}`);
    }

    if (Array.isArray(bundle.projectMemory) && bundle.projectMemory.length > 0) {
      const memoryLines = bundle.projectMemory.slice(0, 8).map((item) => `- ${String(item.content || '').trim()}`);
      sections.push(`Recent project memory:\n${memoryLines.join("\n")}`);
    }

    const projectResources = Array.isArray(bundle.resources?.project) ? bundle.resources.project : [];
    const customerResources = Array.isArray(bundle.resources?.customer) ? bundle.resources.customer : [];
    const allResources = [...projectResources, ...customerResources];
    if (allResources.length > 0) {
      const injectable = allResources.filter((resource) => this.isInjectableResource(resource));
      const resourceLines = allResources.slice(0, 12).map((resource) => {
        const marker = this.isInjectableResource(resource) ? "inject" : "manual";
        return `- ${resource.name || resource.displayName || resource.id} [type=${resource.resourceType || 'unknown'}, provider=${resource.provider || 'unknown'}, scope=${resource.scopeType || 'unknown'}, mode=${marker}]`;
      });
      sections.push(`Relevant scoped resources:\n${resourceLines.join("\n")}`);
      if (injectable.length > 0) {
        const injectedBlocks = injectable
          .filter((resource) => {
            const text = this.getResourceText(resource);
            return typeof text === 'string' && text.trim();
          })
          .slice(0, 4)
          .map((resource) => `### Resource: ${resource.displayName || resource.name || resource.id}\n\n${this.getResourceText(resource)}`);
        if (injectedBlocks.length > 0) {
          sections.push(`Auto-injected resource context (isShared=true):\n\n${injectedBlocks.join("\n\n")}`);
        }
      }
    }

    if (bundle.agentProfile) {
      const profileLines = [];
      if (bundle.agentProfile.displayName) profileLines.push(`Display name: ${bundle.agentProfile.displayName}`);
      if (bundle.agentProfile.signature) profileLines.push(`Signature: ${bundle.agentProfile.signature}`);
      if (bundle.agentProfile.memorySeed) profileLines.push(`Memory seed: ${bundle.agentProfile.memorySeed}`);
      if (profileLines.length > 0) {
        sections.push(`Project-specific agent profile:\n${profileLines.join("\n")}`);
      }
    }

    if (Array.isArray(bundle.relatedThreads) && bundle.relatedThreads.length > 0) {
      const threadBlocks = bundle.relatedThreads.slice(0, 4).map((entry) => {
        const thread = entry.thread || {};
        const messages = Array.isArray(entry.recentMessages) ? entry.recentMessages.slice(0, 5) : [];
        const preview = messages.map((msg) => `  - ${msg.senderType || 'unknown'}: ${String(msg.text || '').trim()}`).join("\n");
        return `- Thread ${thread.id} [type=${thread.type || 'unknown'}]\n${preview}`;
      });
      sections.push(`Related thread context:\n${threadBlocks.join("\n")}`);
    }

    return sections.join("\n\n");
  }

  async findTaskByRef(taskRef) {
    if (!taskRef) return null;
    const tasks = await this.fetchTasks();
    const task = tasks.find((item) => String(item.id || "").slice(0, 8).toUpperCase() === String(taskRef).toUpperCase()) || null;
    if (!task?.id) return task;
    try {
      return await this.fetchTaskDetail(task.id);
    } catch (error) {
      console.error("[bridge] task detail fetch failed:", error.message);
      return task;
    }
  }

  async fetchResources() {
    const payload = await http("/api/mcp/resources", { method: "GET" });
    return Array.isArray(payload?.resources) ? payload.resources : Array.isArray(payload) ? payload : [];
  }

  isInjectableResource(resource) {
    if (!resource || typeof resource !== "object") return false;
    // Force sharing (`isShared`) is the control-plane signal that this resource
    // should be injected into agent context by default rather than only
    // discovered on-demand.
    return Boolean(resource.isShared);
  }

  async fetchAgents() {
    const payload = await http("/api/mcp/agents", { method: "GET" });
    return Array.isArray(payload?.agents) ? payload.agents : Array.isArray(payload) ? payload : [];
  }

  async resolveAgentRef(agentRef) {
    if (!agentRef) return null;
    const agents = await this.fetchAgents();
    const ref = String(agentRef).trim().toLowerCase();
    return agents.find((agent) => String(agent.id || "").toLowerCase() === ref || String(agent.name || "").toLowerCase() === ref) || null;
  }

  async fetchDoctrineResources() {
    const resources = await this.fetchResources();
    return resources.filter((resource) => {
      const name = String(resource?.name || "").trim();
      // Only inject doctrine that is explicitly force-shared at the control plane
      if (!this.isInjectableResource(resource)) return false;
      return ["Emperor Operator Handbook", "Emperor Role Doctrine", "Manager Doctrine", "Worker Doctrine", "Manager Agent Handbook", "Viktor Agent Handbook"].includes(name);
    });
  }

  getResourceText(resource) {
    // First check configText
    const configText = resource?.configText;
    if (configText && typeof configText === "string") {
      // Try to parse as JSON (for agent profiles with profileText)
      try {
        const parsed = JSON.parse(configText);
        if (parsed && typeof parsed === "object") {
          // Return profileText if it exists in JSON
          if (parsed.profileText && typeof parsed.profileText === "string") {
            return parsed.profileText.trim();
          }
          // Or return markdown if it exists
          if (parsed.markdown && typeof parsed.markdown === "string") {
            return parsed.markdown.trim();
          }
          // Or stringify the JSON if no known fields
          return JSON.stringify(parsed, null, 2);
        }
      } catch {
        // Not JSON, use as plain text
        return configText.trim();
      }
    }
    
    // Fallback to configJson fields (legacy)
    const text = resource?.configJson?.markdown || resource?.configJson?.profileText || "";
    return typeof text === "string" ? text.trim() : "";
  }

  getResourceJson(resource) {
    // Parse configText as JSON if possible
    const configText = resource?.configText;
    if (configText && typeof configText === "string") {
      try {
        const parsed = JSON.parse(configText);
        if (parsed && typeof parsed === "object") {
          return parsed;
        }
      } catch {
        // Not JSON
      }
    }
    // Fallback to configJson (legacy)
    return resource?.configJson || {};
  }

  extractRoleSection(roleDocText, isManager) {
    const text = String(roleDocText || "").trim();
    if (!text) return "";
    const heading = isManager ? "## If you are Manager" : "## If you are a Worker";
    const start = text.indexOf(heading);
    if (start === -1) return text;
    const rest = text.slice(start);
    const next = rest.indexOf("\n---\n", 1);
    return (next === -1 ? rest : rest.slice(0, next)).trim();
  }

  async getDoctrinePromptParts(isManager) {
    try {
      const resources = await this.fetchDoctrineResources();
      const shared = resources.find((r) => String(r?.name || "") === "Emperor Operator Handbook" && String(r?.scopeType || "") === "company");
      const unifiedRole = resources.find((r) => String(r?.name || "") === "Emperor Role Doctrine" && String(r?.scopeType || "") === "company");
      const legacyRole = resources.find((r) => String(r?.name || "") === (isManager ? "Manager Doctrine" : "Worker Doctrine") && String(r?.scopeType || "") === "company");
      const sharedText = this.getResourceText(shared) || getFallbackSharedOperatorDoctrine();
      const unifiedRoleText = this.getResourceText(unifiedRole);
      const roleText = this.extractRoleSection(unifiedRoleText, isManager) || this.getResourceText(legacyRole) || getFallbackRoleOperatorOverlay(isManager);
      return { sharedText, roleText };
    } catch (error) {
      console.error("[bridge] doctrine resource fetch failed:", error.message);
      return {
        sharedText: getFallbackSharedOperatorDoctrine(),
        roleText: getFallbackRoleOperatorOverlay(isManager),
      };
    }
  }

  async getForceSharedResourcesForAgent() {
    try {
      // Get all resources
      const allResources = await this.fetchResources();
      
      // Filter for force-shared resources (isShared: true)
      const forceSharedResources = allResources.filter((resource) => {
        if (!this.isInjectableResource(resource)) return false; // isShared: true
        
        // Check if resource is scoped to this agent
        const scopeType = String(resource?.scopeType || "");
        const scopeId = String(resource?.scopeId || "");
        
        // Company resources: available to all agents
        if (scopeType === "company") return true;
        
        // Agent resources: only if scoped to this agent
        if (scopeType === "agent") {
          return scopeId === AGENT_ID;
        }
        
        // Customer/project resources: available if in context
        // For now, include them (they'll be filtered by scope in composeLiveContext)
        return true;
      });
      
      if (forceSharedResources.length === 0) {
        return null;
      }
      
      // Build injected text
      const injectedBlocks = forceSharedResources
        .filter((resource) => {
          const text = this.getResourceText(resource);
          return typeof text === 'string' && text.trim();
        })
        .slice(0, 8) // Limit to 8 resources to avoid token overflow
        .map((resource) => {
          const scopeInfo = resource.scopeType ? ` [scope: ${resource.scopeType}]` : '';
          return `### Resource: ${resource.displayName || resource.name || resource.id}${scopeInfo}\n\n${this.getResourceText(resource)}`;
        });
      
      if (injectedBlocks.length === 0) {
        return null;
      }
      
      return `Force-shared resources (isShared=true):\n\n${injectedBlocks.join("\n\n")}`;
      
    } catch (error) {
      console.error("[bridge] force-shared resource fetch failed:", error.message);
      return null;
    }
  }

  async fetchAgentProfiles(scopeId = null) {
    const resources = await this.fetchResources();
    return resources.filter((resource) => {
      const text = this.getResourceText(resource);
      const name = String(resource?.name || "");
      if (!text) return false;
      if (!/Agent Profile:/i.test(text) && !/Agent Handbook/i.test(name) && !/^Agent Profile - /i.test(name)) return false;
      if (!scopeId) return true;
      return String(resource.scopeId || "") === String(scopeId);
    });
  }

  async buildLiveContextForMessage(text) {
    const lowered = String(text || "").toLowerCase();
    const wantsCustomers = /\bcustomer\b|\bcustomers\b|\bclient\b|\bclients\b/.test(lowered);
    const wantsProjects = /\bproject\b|\bprojects\b/.test(lowered);
    const wantsTasks = /\btask\b|\btasks\b|\bto do\b|\btodo\b|\bbacklog\b/.test(lowered);
    const wantsResources = /\bresource\b|\bresources\b|\btemplate\b|\btemplates\b/.test(lowered);
    const wantsEmperorOverview = /\bemperor\b|\bhere\b|\bwhat do we have\b|\bwhat's here\b|\bcheck here\b|\blist\b|\bshow me\b/.test(lowered);
    const wantsNorthstar = /northstar forge|northstar/.test(lowered);

    if (!wantsCustomers && !wantsProjects && !wantsTasks && !wantsResources && !wantsEmperorOverview && !wantsNorthstar) {
      return null;
    }

    return this.composeLiveContext({
      includeCustomers: wantsCustomers || wantsNorthstar || wantsEmperorOverview,
      includeProjects: wantsProjects || wantsNorthstar || wantsEmperorOverview,
      includeTasks: wantsTasks || wantsNorthstar || wantsEmperorOverview,
      includeResources: wantsResources || wantsNorthstar || wantsEmperorOverview,
      includeAgents: wantsEmperorOverview || /\bagent\b|\bagents\b|\bviktor\b|\bmanager\b|\bdelegate\b|\bdelegation\b/.test(lowered),
      focusName: wantsNorthstar ? "northstar" : null,
      includeOverview: wantsEmperorOverview,
    });
  }

  async composeLiveContext(options = {}) {
    const sections = [];
    const customers = await this.fetchCustomers();
    const projects = await this.fetchProjects();

    if (options.includeOverview) {
      sections.push(`Emperor snapshot: customers=${customers.length}, projects=${projects.length}, activeTasks=${(await this.fetchTasks()).length}`);
    }

    if (options.includeCustomers) {
      const customerLines = customers.slice(0, 10).map((customer) => {
        const parts = [customer.name || customer.displayName || customer.id];
        if (customer.notes) parts.push(`notes: ${customer.notes}`);
        return `- ${parts.join(" — ")}`;
      });
      if (customerLines.length > 0) sections.push(`Customers in Emperor:\n${customerLines.join("\n")}`);
    }

    let matchedCustomer = null;
    if (options.focusName) {
      matchedCustomer = customers.find((customer) => String(customer.name || "").toLowerCase().includes(String(options.focusName).toLowerCase())) || null;
    }

    let matchedProject = null;
    if (options.focusName) {
      matchedProject = projects.find((project) => String(project.goal || "").toLowerCase().includes("developer portal") || String(project.customerId || "") === String(matchedCustomer?.id || "")) || null;
    }

    if (options.includeProjects) {
      const projectLines = projects.slice(0, 10).map((project) => `- ${project.goal || project.name || project.id} [status=${project.status || "unknown"}]`);
      if (projectLines.length > 0) sections.push(`Projects in Emperor:\n${projectLines.join("\n")}`);
    }

    const tasks = options.includeTasks
      ? await this.fetchTasks(matchedProject?.id || null)
      : [];
    if (tasks.length > 0) {
      const taskLines = tasks.slice(0, 12).map((task) => `- ${task.title || task.goal || task.id} [type=${task.taskType || "unknown"}, state=${task.state || "unknown"}]`);
      sections.push(`Tasks in scope:\n${taskLines.join("\n")}`);
    }

    if (options.includeResources) {
      let resources = [];
      try {
        if (matchedProject?.id) {
          resources = await this.fetchResourcesByProject(matchedProject.id);
        } else if (matchedCustomer?.id) {
          resources = await this.fetchResourcesByCustomer(matchedCustomer.id);
        } else {
          resources = await this.fetchResources();
        }
      } catch (error) {
        console.error("[bridge] live resource fetch failed:", error.message);
      }

      const filteredResources = options.focusName
        ? resources.filter((resource) => {
            const haystack = [resource?.name, resource?.displayName, resource?.configText]
              .map((value) => String(value || "").toLowerCase())
              .join(" ");
            return haystack.includes(String(options.focusName).toLowerCase())
              || String(resource?.scopeId || "") === String(matchedProject?.id || matchedCustomer?.id || "");
          })
        : resources;

      const visibleResources = filteredResources.slice(0, 12);
      if (visibleResources.length > 0) {
        const resourceLines = visibleResources.map((resource) => {
          const marker = this.isInjectableResource(resource) ? "inject" : "manual";
          return `- ${resource.name || resource.displayName || resource.id} [type=${resource.resourceType || 'unknown'}, provider=${resource.provider || 'unknown'}, scope=${resource.scopeType || 'unknown'}, mode=${marker}]`;
        });
        sections.push(`Relevant scoped resources:\n${resourceLines.join("\n")}`);

        const sharedBlocks = visibleResources
          .filter((resource) => this.isInjectableResource(resource))
          .filter((resource) => {
            const text = this.getResourceText(resource);
            return typeof text === 'string' && text.trim();
          })
          .slice(0, 4)
          .map((resource) => `### Resource: ${resource.displayName || resource.name || resource.id}\n\n${this.getResourceText(resource)}`);

        if (sharedBlocks.length > 0) {
          sections.push(`Auto-injected resource context (isShared=true):\n\n${sharedBlocks.join("\n\n")}`);
        }
      } else if (options.focusName) {
        sections.push("No scoped resources matched the requested project/customer focus.");
      } else {
        sections.push("Known scoped resources may include project templates, identities, mailboxes, or other project/customer assets.");
      }
    }

    if (options.includeResources || options.includeOverview || options.includeAgents) {
      const profiles = await this.fetchAgentProfiles(matchedCustomer?.id || null);
      if (profiles.length > 0) {
        const profileBlocks = profiles.slice(0, 10).map((resource) => {
          const json = this.getResourceJson(resource);
          const name = resource?.name || json?.agentId || resource?.id;
          const text = this.getResourceText(resource);
          return `## ${name}\n${text}`;
        });
        sections.push(`Agent profiles in Emperor:\n${profileBlocks.join("\n\n")}`);
      }
    }

    return sections.length > 0 ? sections.join("\n\n") : null;
  }

  async maybeRunManagerReview(snapshot, reason = "timer") {
    if (!IS_MANAGER_PROFILE) return null;
    const now = Date.now();
    const lastAt = this.bridgeState.lastManagerReviewAt ? Date.parse(this.bridgeState.lastManagerReviewAt) : 0;
    if (lastAt && Number.isFinite(lastAt) && now - lastAt < EMPEROR_CLAW_MANAGER_REVIEW_MS) {
      return null;
    }

    const liveContext = await this.composeLiveContext({
      includeOverview: true,
      includeCustomers: true,
      includeProjects: true,
      includeTasks: true,
      includeResources: true,
      includeAgents: true,
    });

    const doctrine = await this.getDoctrinePromptParts(true);
    const forceSharedResources = await this.getForceSharedResourcesForAgent();
    const prompt = [
      "You are Manager, an Emperor oversight agent.",
      `Shared Emperor doctrine:\n${doctrine.sharedText}`,
      `Role overlay:\n${doctrine.roleText}`,
      forceSharedResources ? `${forceSharedResources}` : null,
      "Review the live Emperor state and decide whether anything actually needs attention.",
      "Use these thresholds unless the data clearly suggests otherwise: inbox > 24h is stale, queued > 24h is stale, in_progress > 6h without visible update is at risk, active project with no movement > 72h is idle.",
      "Reply naturally in plain language. Do not emit raw JSON, action envelopes, or schema talk.",
      "If nothing actionable needs attention, reply with a short no-op acknowledgement like 'Nothing needs attention right now.'",
      "If something needs attention, say plainly what needs attention and what should happen next. Keep it concise and non-dramatic.",
      "Use Agent profiles from Emperor to decide delegation. If a concrete task should move to a worker, say so naturally rather than talking about action surfaces.",
      liveContext ? `Live Emperor context:\n${liveContext}` : null,
      `Review reason: ${reason}`,
      `Current sync snapshot: tasks=${Array.isArray(snapshot?.tasks) ? snapshot.tasks.length : 0}, teamThreads=${Array.isArray(snapshot?.teamThreads) ? snapshot.teamThreads.length : 0}`,
    ].filter(Boolean).join("\n\n");

    const knownSessionId = this.bridgeState.viktorBrainSessionId || null;
    const agentResult = await callLocalOpenClawAgent(prompt, {
      sessionId: knownSessionId,
      thinking: VIKTOR_BRAIN_THINKING,
      timeoutSeconds: 120,
    });
    const nextSessionId = agentResult?.sessionId || null;
    if (nextSessionId) {
      this.bridgeState.viktorBrainSessionId = nextSessionId;
    }
    this.bridgeState.lastManagerReviewAt = new Date(now).toISOString();
    this.schedulePersistBridgeState();

    const reviewText = String(agentResult?.text || "").trim();
    if (!reviewText || /nothing needs attention right now\.?/i.test(reviewText)) {
      console.log("[bridge] manager review produced no actionable follow-up");
      return null;
    }

    const executed = { replyText: reviewText, executed: [] };
    const hasActions = false;
    const shouldPostSummary = Boolean(executed.replyText)
      && ["blocked", "failed", "needs_human", "working", "done"].includes(String(executed.status || "").trim())
      && hasActions;

    if (shouldPostSummary) {
      await this.sendChatReplyOnce(executed.replyText, { chat_id: "team", thread_type: "team" });
    } else if (executed.replyText) {
      console.log("[bridge] manager review produced non-actionable reply; suppressing proactive post");
    }

    return executed;
  }

  async startAction(metadata = {}) {
    const payload = await http("/api/mcp/actions", {
      method: "POST",
      body: {
        agentId: this.agent.id,
        sessionId: this.session.id,
        kind: metadata.kind || "task_execution",
        projectId: metadata.projectId || null,
        taskId: metadata.taskId || null,
        summary: metadata.summary || null,
        metadataJson: metadata.metadataJson || {},
      },
    });
    return payload.actionRun;
  }

  async logActionStep(actionRunId, step) {
    return http(`/api/mcp/actions/${actionRunId}/steps`, {
      method: "POST",
      body: {
        stepType: step.stepType || "tool",
        toolName: step.toolName || null,
        status: step.status || "success",
        target: step.target || null,
        inputSummaryJson: step.inputSummaryJson || {},
        outputSummaryJson: step.outputSummaryJson || {},
        errorText: step.errorText || null,
        startedAt: step.startedAt || new Date().toISOString(),
        endedAt: step.endedAt || new Date().toISOString(),
      },
    });
  }

  async sendMessage(text, options = {}) {
    return http("/api/mcp/messages/send", {
      method: "POST",
      idempotencyKey: options.idempotencyKey || this.messageSendKey(text, options),
      body: {
        chat_id: options.chat_id || "team",
        thread_type: options.thread_type || (options.targetAgentId ? "direct" : "team"),
        targetAgentId: options.targetAgentId || null,
        thread_id: options.thread_id || null,
        text,
        from_user_id: this.agent.id,
      },
    });
  }

  async checkpoint(checkpointJson, summary = null, idempotencyKey = null) {
    return http(`/api/mcp/agents/${this.agent.id}/sessions/${this.session.id}/checkpoint`, {
      method: "POST",
      idempotencyKey: idempotencyKey || this.checkpointKey({ checkpointJson, summary, sessionId: this.session?.id }),
      body: {
        checkpointJson,
        summary,
        status: "active",
      },
    });
  }

  /**
   * Signaling: Tell the UI that we are thinking or reading.
   * Useful for Long-Running processes.
   * 
   * @param {string} threadId - The thread ID to update.
   * @param {boolean} typing - Set to true to show the typing indicator.
   * @param {boolean} markRead - Set to true to clear unread counts.
   */
  async updateChatStatus(threadId, typing = null, markRead = false) {
    return http("/api/mcp/chat/status/", {
      method: "POST",
      body: {
        threadId,
        agentId: this.agent.id,
        typing,
        markRead,
      },
    });
  }

  async end(summary = "Bridge shutdown") {
    this.shutdownRequested = true;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.controlSyncTimer) clearInterval(this.controlSyncTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.persistTimer) clearTimeout(this.persistTimer);
    if (this.socket && this.socket.readyState === 1) this.socket.close();
    if (this.activeTasks.size > 0) {
      await this.checkpoint({
        reason: "shutdown",
        activeTaskIds: Array.from(this.activeTasks.keys()),
      }, summary, `checkpoint:shutdown:${stableHash({ sessionId: this.session?.id || null, activeTaskIds: Array.from(this.activeTasks.keys()) })}`);
    }
    this.persistBridgeState();

    return http(`/api/mcp/agents/${this.agent.id}/sessions/${this.session.id}/end`, {
      method: "POST",
      body: {
        status: "ended",
        summary,
      },
    });
  }
}

async function main() {
  console.log("[bridge] starting emperor bridge adapter...");
  const bridge = new EmperorBridge();
  
  try {
    // Example listening loop. Replace this stub with your runtime's real agent logic.
    bridge.onMessage = async (message, thread) => {
      console.log(`[agent-brain] acknowledging ${message.senderType || "thread"}...`);
      await bridge.defaultMessageHandler(message, thread);
    };

    bridge.onTask = async (task) => {
      console.log(`[agent-brain] task ${task.id} claimed but no executor is attached`);
      await bridge.defaultTaskHandler(task);
      return null;
    };

    await bridge.start();
    
    // Example: signal typing before a slow operation.
    // await bridge.updateChatStatus("team", true, true);
    // setTimeout(() => bridge.updateChatStatus("team", false), 5000);

    process.on("SIGINT", async () => {
      console.log("\n[bridge] shutting down...");
      try {
        await bridge.end("Bridge interrupted");
      } finally {
        process.exit(0);
      }
    });

    process.on("SIGTERM", async () => {
      console.log("\n[bridge] terminating...");
      try {
        await bridge.end("Bridge terminated");
      } finally {
        process.exit(0);
      }
    });
  } catch (err) {
    console.error("[bridge] fatal error during setup:", err.message);
    process.exit(1);
  }
}

main();
