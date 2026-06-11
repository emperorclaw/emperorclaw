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
const LOCAL_BRAIN_AGENT_ID = process.env.EMPEROR_CLAW_BRAIN_AGENT_ID || "viktor";
const LOCAL_BRAIN_THINKING = process.env.EMPEROR_CLAW_BRAIN_THINKING || "medium";
const LOCAL_BRAIN_SESSION_KEY = process.env.EMPEROR_CLAW_BRAIN_SESSION_KEY || `hook:${LOCAL_BRAIN_AGENT_ID}:emperor-brain`;
const OPENCLAW_CLI_PATH = process.env.OPENCLAW_CLI_PATH || "/home/jose/.npm-global/bin/openclaw";
const EMPEROR_CLAW_AUTO_CLAIM = String(process.env.EMPEROR_CLAW_AUTO_CLAIM || "false").toLowerCase() === "true";
const EMPEROR_CLAW_AGENT_PROFILE = process.env.EMPEROR_CLAW_AGENT_PROFILE
  || ((String(AGENT_NAME).toLowerCase() === "manager" || String(LOCAL_BRAIN_AGENT_ID).toLowerCase() === "manager") ? "manager" : "operator");
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
    options.agentId || LOCAL_BRAIN_AGENT_ID,
    "--message",
    message,
    "--thinking",
    options.thinking || LOCAL_BRAIN_THINKING,
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

const EMPEROR_CLAW_USE_EXECUTOR = String(process.env.EMPEROR_CLAW_USE_EXECUTOR || "false").toLowerCase() === "true";

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

function getSharedOperatorDoctrine() {
  return [
    "Emperor Claw is the control plane and system of record; OpenClaw is the runtime executor.",
    "Connection model: API base is https://emperorclaw.malecu.eu, MCP REST base is https://emperorclaw.malecu.eu/api/mcp, websocket is wss://emperorclaw.malecu.eu/api/mcp/ws, and auth uses Authorization: Bearer <company_token> from EMPEROR_CLAW_API_TOKEN.",
    "Use Emperor as canonical for customers, projects, tasks, task notes/events, project memory, scoped resources, artifacts, threads, schedules, templates, tactics, playbooks, incidents, approvals, and agent context when relevant.",
    "Resources are first-class plain-text context via configText: use them for templates, profiles, SOPs, reusable docs, scoped references, and operational notes.",
    "Artifacts are first-class outputs backed by Bunny for fresh file bytes and by Emperor metadata for search, scope, and permissions; use them for deliverables, proofs, working files, source documents, reports, templates, and export bundles when real work product should be preserved.",
    "If chat memory and Emperor disagree, prefer Emperor and surface the mismatch honestly.",
    "You are allowed to use your local OpenClaw runtime capabilities to do the work: tools, files, browser/web access, coding, and enabled skills on the machine where you run.",
    "Do not limit yourself to chat-only behavior when real execution or research is needed and your runtime can do it.",
    "Your bridge/runtime usually handles registration, session lifecycle, websocket/sync, heartbeat, dedupe, reconnect state, and local brain handoff; you still need to understand what Emperor objects and state changes mean.",
    "The rule is: do the work with OpenClaw capabilities, then report, coordinate, and persist the important results back into Emperor.",
    "Read first when truth matters: if a TASK-XXXXXXXX reference is present, read canonical task detail/context before answering; also prefer reading task notes, project memory, relevant resources, or thread context before making confident claims.",
    "A task is not execution-ready just because it exists; treat tasks missing title, description, acceptance criteria/definition of done, or deliverables as under-specified.",
    "If a task is under-specified, say so clearly and name the missing fields instead of pretending it is executable.",
    "Do not hallucinate task details when live Emperor state should be checked.",
    "Do not report a task as done unless a real executor produced a result.",
    "If blocked, state the concrete blocker.",
    "Put durable operational state back into Emperor using the right surface: thread replies for visible coordination, task notes for progress/blockers/handoffs, task results for outcomes, project memory for shared durable context, resources for reusable scoped context, and artifacts for real deliverables/evidence.",
    "Direct threads: respond normally. Team threads: be useful, not noisy. Delegation should be explicit. Status answers should be concrete.",
  ].join("\n");
}

function getRoleOperatorOverlay(isManager) {
  if (isManager) {
    return [
      "Manager overlay:",
      "- Keep work moving by detecting blockers, stale work, overload, and missing ownership.",
      "- Prefer concise summaries over long essays.",
      "- Delegate explicitly and use canonical Emperor state before judging status or ownership.",
      "- Be explicit about whether you observed, recommended, delegated, or actually changed state.",
      "- Do not pretend execution happened just because you recommended it.",
    ].join("\n");
  }

  return [
    "Worker overlay:",
    "- Understand the assigned task clearly before acting.",
    "- Execute honestly and report blockers early.",
    "- Keep Emperor state synchronized with reality.",
    "- If you start work, prefer a durable task note; if blocked, prefer a blocker note; if complete, prefer a task result with useful output.",
    "- Do not ask the human to paste task text unless Emperor truly lacks it.",
    "- Do not say you took or finished a task unless Emperor assignment/claim/result state supports it.",
  ].join("\n");
}

function extractTaskRef(text) {
  const value = String(text || "");
  const match = value.match(/TASK-([A-F0-9]{8})/i);
  return match ? match[1].toUpperCase() : null;
}

function extractExplicitAgentMention(text) {
  const value = String(text || "");
  const match = value.match(/@([^\s,.;:!?]+(?:\s+[^\s,.;:!?]+)?)/i);
  return match ? match[1] : null;
}

function normalizeAgentMention(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function agentNameAliases(name) {
  const raw = String(name || "").trim();
  const clean = raw
    .replace(/\([^)]*\)/g, "")
    .split(/\s+-\s+|\s+—\s+|\s+\|\s+/)[0]
    .trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  const aliases = new Set([raw, clean]);
  if (parts.length > 0) {
    aliases.add(parts[0]);
    aliases.add(parts.join("-"));
    aliases.add(parts.join("_"));
  }
  return Array.from(aliases).map((value) => value.replace(/^@+/, "").trim()).filter(Boolean);
}

function extractMentionRefs(text) {
  const refs = [];
  const pattern = /@([^\s,.;:!?]+(?:\s+[^\s,.;:!?]+)?)/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    refs.push(raw);
    refs.push(raw.split(/\s+/)[0]);
  }
  return refs;
}

function mentionsAgentName(text, agentName) {
  const mentionKeys = new Set(extractMentionRefs(text).map(normalizeAgentMention));
  return agentNameAliases(agentName).some((alias) => mentionKeys.has(normalizeAgentMention(alias)));
}

function extractOtherAgentMention(text, currentAgentName) {
  const ownAliases = new Set(agentNameAliases(currentAgentName).map(normalizeAgentMention));
  for (const ref of extractMentionRefs(text)) {
    if (!ownAliases.has(normalizeAgentMention(ref))) return ref;
  }
  return null;
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
      localBrainSessionId: null,
      recentMessageIds: [],
      recentTaskFingerprints: [],
      pendingOperationIds: [],
      threadOwners: {},
    };
    const loaded = readJsonFile(BRIDGE_STATE_PATH);
    const state = loaded && typeof loaded === "object" ? { ...defaults, ...loaded } : defaults;
    state.localBrainSessionId = state.localBrainSessionId || state.viktorBrainSessionId || null;
    state.recentMessageIds = Array.isArray(state.recentMessageIds) ? state.recentMessageIds.slice(-DEDUPE_WINDOW) : [];
    state.recentTaskFingerprints = Array.isArray(state.recentTaskFingerprints) ? state.recentTaskFingerprints.slice(-DEDUPE_WINDOW) : [];
    state.pendingOperationIds = Array.isArray(state.pendingOperationIds) ? state.pendingOperationIds.slice(-DEDUPE_WINDOW) : [];
    state.threadOwners = state.threadOwners || {};
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
      localBrainSessionId: this.bridgeState.localBrainSessionId || null,
      recentMessageIds: Array.from(this.recentMessageIds).slice(-DEDUPE_WINDOW),
      recentTaskFingerprints: Array.from(this.recentTaskFingerprints).slice(-DEDUPE_WINDOW),
      pendingOperationIds: Array.from(this.pendingOperationIds).slice(-DEDUPE_WINDOW),
      threadOwners: { ...(this.bridgeState.threadOwners || {}) },
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
  updateThreadOwner(threadId, agentId) {
    if (!threadId || !agentId) return;
    if (!this.bridgeState.threadOwners) {
      this.bridgeState.threadOwners = {};
    }
    if (this.bridgeState.threadOwners[threadId] === agentId) return;
    this.bridgeState.threadOwners[threadId] = agentId;
    this.schedulePersistBridgeState();
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
    if (this.controlSyncTimer) return;

    const tick = async () => {
      try {
        await this.syncControlPlane("timer");
      } catch (error) {
        console.error("[bridge] sync loop failed:", error.message);
      }
    };

    void tick();
    this.controlSyncTimer = setInterval(tick, SYNC_MS);
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
    const mentionsAgent = agentName ? mentionsAgentName(text, agentName) : false;
    const isDirectThread = String(thread?.type || "").toLowerCase() === "direct";
    const senderType = String(message?.senderType || "unknown").toLowerCase();
    const isHuman = senderType === "human" || senderType === "user";
    const isAgentSender = senderType === "agent";
    const lowSignal = !text || text.length < 4;
    const taskRef = extractTaskRef(text);
    const explicitAtMention = agentName ? mentionsAgentName(text, agentName) : false;

    const metadata = message?.metadataJson || {};
    const targetAgentHint = message?.targetAgentId || metadata.targetAgentId || metadata.target_agent_id || metadata.target_agent || null;
    const directThread = isDirectThread;
    const threadOwner = (this.bridgeState.threadOwners || {})[thread.id] || null;
    let intendedAgentId = threadOwner;

    if (targetAgentHint) {
      intendedAgentId = targetAgentHint;
      this.updateThreadOwner(thread.id, targetAgentHint);
    } else if (directThread && explicitAtMention && this.agent?.id) {
      intendedAgentId = this.agent.id;
      this.updateThreadOwner(thread.id, this.agent.id);
    }

    if (directThread && intendedAgentId && this.agent?.id && intendedAgentId !== this.agent.id) {
      console.log(`[bridge] skipping thread ${thread.id} message targeted at ${intendedAgentId}`);
      return;
    }

    if (IS_MANAGER_PROFILE) {
      if (!isHuman || lowSignal || !explicitAtMention) {
        console.log(`[bridge] manager ignoring thread ${thread.id} message (human=${isHuman} lowSignal=${lowSignal} mentions=${explicitAtMention})`);
        return;
      }
    } else if (!isDirectThread && !explicitAtMention) {
      // For non-manager profiles, in team threads, require @mention regardless of sender type
      console.log(`[bridge] ignoring thread ${thread.id} message without explicit @${agentName} mention (senderType=${senderType})`);
      return;
    }
    // If we reach here, message is allowed:
    // - Manager profile: human, non-lowSignal, with @mention
    // - Non-manager profile: either direct thread OR has @mention

    // Debug log for agent messages
    if (isAgentSender) {
      console.log(`[bridge] processing agent message from ${message.senderId} with @mention=${explicitAtMention}`);
    }

    const explicitClaimRequest = /\b(claim|take|start working on|work on|pick up|handle)\b.*\b(task|ticket|job)\b|\b(next task)\b/.test(lowered);
    const explicitDelegationRequest = /\b(delegate|assign)\b/.test(lowered) && Boolean(taskRef);
    const explicitProjectCreationRequest = IS_MANAGER_PROFILE && isProjectCreationIntent(text);
    const mentionedAgentRef = extractOtherAgentMention(text, agentName) || null;
    if (explicitDelegationRequest) {
      console.log(`[bridge] delegation-request detected thread=${thread.id} senderType=${senderType} taskRef=${taskRef} text=${JSON.stringify(text)}`);
      appendDebugLog(COMPANION_DIR, { kind: "delegation-request", bridgeAgent: agentName, threadId: thread.id, senderType, taskRef, text });
    }

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
    if (IS_MANAGER_PROFILE && explicitDelegationRequest && referencedTask && mentionedAgentRef) {
      try {
        const targetAgent = await this.resolveAgentRef(mentionedAgentRef);
        if (targetAgent?.id && referencedTask.assignedAgentId && String(referencedTask.assignedAgentId) === String(targetAgent.id)) {
          const alreadyAssignedReply = `TASK-${taskRef} is already assigned to ${targetAgent.name || mentionedAgentRef}. No new delegation needed.`;
          appendDebugLog(COMPANION_DIR, { kind: 'delegation-already-assigned', bridgeAgent: agentName, taskId: referencedTask.id, targetAgentId: targetAgent.id, targetAgentName: targetAgent.name || mentionedAgentRef });
          await this.sendMessage(alreadyAssignedReply, { thread_id: thread.id, thread_type: thread.type });
          await this.updateChatStatus(thread.id, false);
          return;
        }
      } catch (error) {
        console.error('[bridge] delegation precheck failed:', error.message);
      }
    }

    if (explicitClaimRequest) {
      try {
        claimedTask = await this.claimNextTask("explicit-thread-command");
        if (claimedTask) {
          const claimSummary = `Explicitly claimed task ${claimedTask.id} [type=${claimedTask.taskType || "unknown"}, state=${claimedTask.state || "unknown"}]`;
          liveContext = liveContext ? `${liveContext}\n\n${claimSummary}` : claimSummary;
        }
      } catch (error) {
        console.error("[bridge] explicit task claim failed:", error.message);
      }
    }

    const prompt = [
      `You are ${agentName}, replying to an Emperor Claw thread as a helpful assistant.`,
      `Reply naturally and helpfully as ${agentName}.`,
      `Shared Emperor doctrine:\n${getSharedOperatorDoctrine()}`,
      `Role overlay:\n${getRoleOperatorOverlay(IS_MANAGER_PROFILE)}`,
      `Only answer the user's latest message; do not mention internal bridges, hooks, or routing.`,
      `Runtime access note: this Emperor-connected runtime already has working Emperor authentication and API access. Emperor API base: ${API_URL}/api/mcp . Authorization bearer token available in runtime: ${API_TOKEN}. Use it when direct Emperor calls are needed. Do not claim you lack the Emperor API key or Emperor access unless a real call fails.`,
      `If you want Emperor state changed, return raw JSON only with this schema: {"reply_text":"string","summary":"optional","status":"observed|working|blocked|done|failed|needs_human","actions":[...]}.`,
      `Supported actions in this turn are: task_note {task_id,note,handoff?}, task_result {task_id,state,comment?,output_json?}, task_assign {task_id,agent_id,mode?}, thread_reply {thread_id?,thread_type?,text,chat_id?,target_agent_id?}, project_memory {project_id,content,summary?}, project_create {goal,customer_id?,status?,lead_agent_id?,max_active_agents?}, task_create {project_id,task_type,title,description,acceptance_criteria?,definition_of_done?,deliverables?,owner_role?,priority?,blocked_by_task_ids?}. Also remember that Emperor MCP lets you read/use customers, projects, tasks, notes, project memory, resources, artifacts, threads, templates, tactics, playbooks, incidents, approvals, schedules, and agent context when relevant. Resources are plain text/context; artifacts are preserved outputs.`,
      `If the human asks to create a project, define a project, break down a goal, or set up work, and the request is clear enough, use the creation actions available in this turn instead of only describing what you would do.`,
      `When another agent delegates work, only treat it as actionable if it explicitly uses @${agentName} and includes a concrete task/work verb. If a TASK-XXXXXXXX reference is present, use that specific task as the intended target.`,
      `If a TASK-XXXXXXXX reference is present, prefer the canonical Emperor task detail/context in the prompt over chat memory. Do not claim that task details are missing unless the canonical task detail is genuinely empty or retrieval failed.`,
      `If the human asks whether work is finished, blocked, or what the task says, ground the reply in the referenced task's state, notes, acceptance criteria, deliverables, and visible blockers before answering.`,
      explicitDelegationRequest && IS_MANAGER_PROFILE
        ? `This is a delegation turn. Use structured actions for the handoff rather than only describing the handoff in prose.`
        : explicitProjectCreationRequest
          ? `This is a project-setup turn. If the request is clear enough, use structured creation actions to set it up instead of only describing the intended project in prose.`
          : `If no Emperor mutation is needed, you may reply with plain natural language text instead of JSON. Do not wrap JSON in markdown fences.`,
      IS_MANAGER_PROFILE
        ? `Use the Agent profiles in Emperor to delegate intentionally. When execution work should go to a worker like Viktor, prefer a visible team-thread delegation via thread_reply tagging @Viktor with a concrete instruction. Use explicit @agent-name mentions for agent-to-agent delegation. If the human references a TASK-XXXXXXXX id, include that exact task reference in the delegation. If you are assigning a specific task to a worker, prefer task_assign first, then the visible delegation message. Keep your human-facing reply generic (for example: "I’m delegating that now.") and avoid mentioning the worker name there if you also send a separate delegation message.`
        : `If another agent such as Manager delegates execution work to you, treat a concrete @${agentName} instruction about taking or working on a task as actionable and stay honest about progress, blockers, and results. If you accept a specific task, prefer structured actions so Emperor stays consistent: assign or claim the task if needed, add a start note, and later add a blocker note or task_result instead of only chatting about it. Never say you took a task unless the assignment/claim succeeded.`,
      IS_MANAGER_PROFILE
        ? `When asked to create a project for a goal, behave like an operator-planner: create a project, seed project memory with project brief/assumptions/constraints/success definition/next steps, then create a small initial executable task breakdown. Prefer 3-7 execution-ready tasks over many vague tasks. If the request is too vague, ask a sharp clarifying question or create a draft project with explicit assumptions.`
        : null,
      liveContext ? `Live Emperor context:\n${liveContext}` : null,
      `Thread ID: ${thread.id}`,
      `Thread type: ${thread.type}`,
      `Sender type: ${message.senderType || "unknown"}`,
      `Latest message: ${text}`,
    ].filter(Boolean).join("\n\n");

    let replyText = null;
    try {
      const knownSessionId = this.bridgeState.localBrainSessionId || null;
      const useFreshSession = false;
      const agentResult = await callLocalOpenClawAgent(prompt, {
        sessionId: useFreshSession ? null : knownSessionId,
        thinking: LOCAL_BRAIN_THINKING,
        timeoutSeconds: 120,
      });
      const nextSessionId = agentResult?.sessionId || null;
      if (nextSessionId) {
        this.bridgeState.localBrainSessionId = nextSessionId;
        this.schedulePersistBridgeState();
      }
      const structured = parseStructuredEnvelope(agentResult?.text || "");
      if (explicitDelegationRequest) {
        console.log(`[bridge] delegation brain-output structured=${Boolean(structured)} text=${JSON.stringify((agentResult?.text || '').slice(0, 800))}`);
        appendDebugLog(COMPANION_DIR, { kind: "delegation-brain-output", bridgeAgent: agentName, structured: Boolean(structured), text: (agentResult?.text || '').slice(0, 800) });
      }
      if (EMPEROR_CLAW_USE_EXECUTOR && structured) {
        const executed = await this.executeStructuredEnvelope(structured, {
          threadId: thread.id,
          threadType: thread.type,
          taskId: referencedTask?.id || claimedTask?.id || message.taskId || null,
          projectId: referencedTask?.projectId || claimedTask?.projectId || null,
        });
        if (explicitDelegationRequest) {
          console.log(`[bridge] delegation executed actions=${JSON.stringify(executed.executed || [])} replyText=${JSON.stringify(executed.replyText || '')}`);
          appendDebugLog(COMPANION_DIR, { kind: "delegation-executed", bridgeAgent: agentName, actions: executed.executed || [], replyText: executed.replyText || '' });
        }
        if (explicitProjectCreationRequest) {
          const createdProject = (executed.executed || []).find((item) => item.type === "project_create" && item.projectId);
          const createdTasks = (executed.executed || []).filter((item) => item.type === "task_create");
          if (createdProject) {
            replyText = `Done — I created the project and seeded ${createdTasks.length} starter task${createdTasks.length === 1 ? '' : 's'}.`;
          } else {
            replyText = null;
          }
        } else {
          replyText = executed.replyText || null;
        }
      } else {
        if (!IS_MANAGER_PROFILE && referencedTask && !referencedTask.assignedAgentId && isAgentSender && explicitAtMention && /\b(take|claim|work on|handle|pick up|start)\b/.test(lowered)) {
          try {
            console.log(`[bridge] self-assign attempt taskId=${referencedTask.id} agentId=${this.agent?.id || LOCAL_BRAIN_AGENT_ID}`);
            appendDebugLog(COMPANION_DIR, { kind: "self-assign-attempt", bridgeAgent: agentName, taskId: referencedTask.id, agentId: this.agent?.id || LOCAL_BRAIN_AGENT_ID });
            await http(`/api/mcp/tasks/${referencedTask.id}/assign`, {
              method: "POST",
              idempotencyKey: `self-assign:${stableHash({ taskId: referencedTask.id, agentId: this.agent?.id || LOCAL_BRAIN_AGENT_ID })}`,
              body: { agentId: this.agent?.id || LOCAL_BRAIN_AGENT_ID, mode: "assign" },
            });
            console.log(`[bridge] self-assign success taskId=${referencedTask.id}`);
            appendDebugLog(COMPANION_DIR, { kind: "self-assign-success", bridgeAgent: agentName, taskId: referencedTask.id });
            replyText = agentResult?.text || null;
          } catch (error) {
            console.error("[bridge] self-assign failed:", error.message);
            appendDebugLog(COMPANION_DIR, { kind: "self-assign-failed", bridgeAgent: agentName, taskId: referencedTask.id, error: error.message });
            replyText = agentResult?.text || null;
          }
        } else {
          replyText = agentResult?.text || null;
        }
      }
    } catch (error) {
      console.error("[bridge] viktor brain handoff failed:", error.message);
      replyText = IS_MANAGER_PROFILE ? null : "I hit a local brain handoff issue just now. Please try again in a moment.";
    }

    if (!replyText || !String(replyText).trim()) {
      if (IS_MANAGER_PROFILE || explicitDelegationRequest || explicitProjectCreationRequest) {
        console.log("[bridge] suppressing unusable reply");
        await this.updateChatStatus(thread.id, false);
        return;
      }
      replyText = "I saw your message, but I don't have a usable reply yet.";
    }

    await this.sendMessage(String(replyText).trim(), {
      thread_id: thread.id,
      thread_type: thread.type,
    });
    if (thread?.id && this.agent?.id) {
      this.updateThreadOwner(thread.id, this.agent.id);
    }
    await this.updateChatStatus(thread.id, false);
    await this.checkpoint(
      {
        reason: "thread_message",
        threadId: thread.id,
        threadType: thread.type,
        lastSeenMessageId: message.id || null,
        brainSessionKey: LOCAL_BRAIN_SESSION_KEY,
      },
      `Processed thread ${thread.id}`,
    );
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
      const resourceLines = allResources.slice(0, 12).map((resource) => `- ${resource.name || resource.displayName || resource.id} [type=${resource.resourceType || 'unknown'}, provider=${resource.provider || 'unknown'}, scope=${resource.scopeType || 'unknown'}]`);
      sections.push(`Relevant scoped resources:\n${resourceLines.join("\n")}`);
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

  async fetchAgents() {
    const payload = await http("/api/mcp/agents", { method: "GET" });
    return Array.isArray(payload?.agents) ? payload.agents : Array.isArray(payload) ? payload : [];
  }

  async resolveAgentRef(agentRef) {
    if (!agentRef) return null;
    const agents = await this.fetchAgents();
    const ref = normalizeAgentMention(agentRef);
    return agents.find((agent) => {
      if (normalizeAgentMention(agent.id || "") === ref) return true;
      return agentNameAliases(agent.name || agent.displayName || "").some((alias) => normalizeAgentMention(alias) === ref);
    }) || null;
  }

  async fetchAgentProfiles(scopeId = null) {
    const resources = await this.fetchResources();
    return resources.filter((resource) => {
      const profileText = resource?.configJson?.profileText;
      const name = String(resource?.name || "");
      const scopeType = String(resource?.scopeType || "");
      const scopeIdValue = String(resource?.scopeId || "");
      if (!profileText || typeof profileText !== "string") return false;
      if (!/Agent Profile:/i.test(profileText) && !/^Agent Profile - /i.test(name)) return false;

      if (scopeType === "agent") {
        return scopeIdValue === String(AGENT_ID || "");
      }

      if (scopeType === "company") {
        return true;
      }

      if (!scopeId) return true;
      return scopeIdValue === String(scopeId);
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
      if (options.focusName) {
        sections.push("Known scoped resource: Northstar Product Brief [type=template, provider=emperor-demo]");
      } else {
        sections.push("Known scoped resources may include project templates, identities, mailboxes, or other project/customer assets. Agent-scoped resources must stay private to their owner agent.");
      }
    }

    if (options.includeResources || options.includeOverview || options.includeAgents) {
      const profiles = await this.fetchAgentProfiles(matchedCustomer?.id || null);
      if (profiles.length > 0) {
        const profileBlocks = profiles.slice(0, 10).map((resource) => {
          const name = resource?.name || resource?.configJson?.agentId || resource?.id;
          const text = String(resource?.configJson?.profileText || "").trim();
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

    const prompt = [
      "You are Manager, an Emperor oversight agent.",
      `Runtime access note: this Emperor-connected runtime already has working Emperor authentication and API access. Emperor API base: ${API_URL}/api/mcp . Authorization bearer token available in runtime: ${API_TOKEN}. Use it when direct Emperor calls are needed. Do not claim you lack the Emperor API key or Emperor access unless a real call fails.`,
      `Shared Emperor doctrine:\n${getSharedOperatorDoctrine()}`,
      `Role overlay:\n${getRoleOperatorOverlay(true)}`,
      "Review the live Emperor state and decide whether anything actually needs attention.",
      "Use these thresholds unless the data clearly suggests otherwise: inbox > 24h is stale, queued > 24h is stale, in_progress > 6h without visible update is at risk, active project with no movement > 72h is idle.",
      "Do not create drama. If nothing actionable needs attention, return raw JSON only: {\"reply_text\":\"\",\"status\":\"observed\",\"actions\":[]}",
      "If something needs attention, return raw JSON only with schema {\"reply_text\":\"string\",\"summary\":\"optional\",\"status\":\"observed|working|blocked|done|failed|needs_human\",\"actions\":[...]}",
      "Supported actions in this turn are: task_note {task_id,note,handoff?}, task_assign {task_id,agent_id,mode?}, thread_reply {thread_id?,thread_type?,text,chat_id?,target_agent_id?}, project_memory {project_id,content,summary?}, project_create {goal,customer_id?,status?,lead_agent_id?,max_active_agents?}, task_create {project_id,task_type,title,description,acceptance_criteria?,definition_of_done?,deliverables?,owner_role?,priority?,blocked_by_task_ids?}.",
      "Use Agent profiles from Emperor to decide delegation. If the human references a specific TASK-XXXXXXXX and asks you to delegate or assign it to a worker, prefer a task_assign action first (agent_id should be the worker, usually viktor), then a visible team-thread handoff using thread_reply with chat_id=team, thread_type=team, and a concrete @Viktor instruction.",
      liveContext ? `Live Emperor context:\n${liveContext}` : null,
      `Review reason: ${reason}`,
      `Current sync snapshot: tasks=${Array.isArray(snapshot?.tasks) ? snapshot.tasks.length : 0}, teamThreads=${Array.isArray(snapshot?.teamThreads) ? snapshot.teamThreads.length : 0}`,
    ].filter(Boolean).join("\n\n");

    const knownSessionId = this.bridgeState.localBrainSessionId || null;
    const agentResult = await callLocalOpenClawAgent(prompt, {
      sessionId: knownSessionId,
      thinking: LOCAL_BRAIN_THINKING,
      timeoutSeconds: 120,
    });
    const nextSessionId = agentResult?.sessionId || null;
    if (nextSessionId) {
      this.bridgeState.localBrainSessionId = nextSessionId;
    }
    this.bridgeState.lastManagerReviewAt = new Date(now).toISOString();
    this.schedulePersistBridgeState();

    const envelope = parseStructuredEnvelope(agentResult?.text || "");
    if (!envelope) {
      console.log("[bridge] manager review returned plain text; skipping proactive post");
      return null;
    }
    const executed = await this.executeStructuredEnvelope(envelope, {
      threadType: "team",
      chatId: "team",
    });

    const hasActions = Array.isArray(executed.executed) && executed.executed.length > 0;
    const shouldPostSummary = Boolean(executed.replyText)
      && ["blocked", "failed", "needs_human", "working", "done"].includes(String(executed.status || "").trim())
      && hasActions;

    if (shouldPostSummary) {
      await this.sendMessage(executed.replyText, { chat_id: "team", thread_type: "team" });
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
