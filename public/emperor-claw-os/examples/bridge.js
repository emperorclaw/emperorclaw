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
 * - exposes helper methods for memory, actions, and messages
 *
 * It does not implement planning or execution logic by itself.
 *
 * Usage:
 *   EMPEROR_CLAW_API_TOKEN=... node examples/bridge.js
 */

const crypto = require("node:crypto");

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

if (!API_TOKEN) {
  console.error("EMPEROR_CLAW_API_TOKEN is required");
  process.exit(1);
}

function makeIdempotencyKey() {
  return crypto.randomUUID();
}

async function http(path, options = {}) {
  const headers = {
    Authorization: `Bearer ${API_TOKEN}`,
    "Content-Type": "application/json",
    ...(options.idempotent ? { "Idempotency-Key": makeIdempotencyKey() } : {}),
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

function getWebSocketCtor() {
  if (typeof WebSocket !== "undefined") return WebSocket;
  return require("ws");
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
    this.lastSeenAt = null;
    this.lastSyncAt = null;
    this.syncInFlight = false;
    this.claimInFlight = false;
    this.activeTasks = new Map();
    this.onMessage = null;
    this.onTask = null;
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
    await this.refreshIntegrations();

    console.log(`[bridge] runtime=${this.runtime.runtimeId} agent=${this.agent.name} session=${this.session.id}`);
    console.log(`[bridge] memory snapshot loaded=${Boolean(this.memory?.snapshot)}`);
    console.log(`[bridge] company context loaded=${Boolean(this.companyContextNotes)}`);
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
    const WebSocketCtor = getWebSocketCtor();
    const socketUrl = API_URL.replace(/^http/, "ws") + "/api/mcp/ws";

    this.socket = new WebSocketCtor(socketUrl, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });

    this.socket.onopen = () => {
      this.stopSyncFallback();
      console.log("[bridge] websocket connected");
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
      this.startSyncFallback();
      console.warn("[bridge] websocket disconnected, retrying in 5s");
      setTimeout(() => this.connectWebSocket(), 5000);
    };

    this.socket.onerror = (error) => {
      this.startSyncFallback();
      console.error("[bridge] websocket error:", error.message || error);
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
    if (task.assignedAgentId === this.agent?.id) {
      this.activeTasks.set(task.id, task);
    }
    if (task.state === "done" || task.state === "failed") {
      this.activeTasks.delete(task.id);
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
    await this.updateChatStatus(thread.id, true, true);
    await this.writeMemory(
      `Observed thread ${thread.id} message from ${message.senderType || "unknown"} at ${new Date().toISOString()}.`,
      {
        kind: "thread_observation",
        taskId: message.taskId || null,
        summary: `Observed thread ${thread.id}`,
        metadataJson: {
          threadId: thread.id,
          threadType: thread.type,
          senderId: message.senderId || null,
        },
      },
    );
    await this.sendMessage("Acknowledged. I recorded this thread and will keep the session alive.", {
      thread_id: thread.id,
      thread_type: thread.type,
    });
    await this.updateChatStatus(thread.id, false);
    await this.checkpoint(
      {
        reason: "thread_message",
        threadId: thread.id,
        threadType: thread.type,
        lastSeenMessageId: message.id || null,
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

      if (health.status === "fulfilled" && health.value?.ok === false) {
        console.warn("[bridge] control-plane health reported not ok");
      }

      if (this.activeTasks.size < CLAIM_LIMIT) {
        const claimable = tasks.filter((task) => {
          const state = String(task.state || task.status || "").toLowerCase();
          return state === "inbox" || state === "queued";
        });
        if (claimable.length > 0) {
          await this.claimNextTask(reason);
        }
      }
      return { tasks, teamThreads };
    } finally {
      this.syncInFlight = false;
    }
  }

  async claimNextTask(reason = "sync") {
    if (this.claimInFlight || this.activeTasks.size >= CLAIM_LIMIT) return null;
    this.claimInFlight = true;
    try {
      const payload = await http("/api/mcp/tasks/claim", {
        method: "POST",
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
      console.log(`[bridge] claimed task ${task.id} (${task.state || "unknown"})`);
      await this.writeTaskNote(task.id, `Bridge claimed this task during ${reason}. This adapter is monitoring lease, thread updates, and checkpoints.`, {
        fromRole: this.agent?.role || "agent",
        toRole: "executor",
        summary: "Bridge claim acknowledgement",
        nextStep: "Run local execution or hand off to a real executor.",
      });
      await this.checkpoint(
        {
          reason,
          activeTaskIds: Array.from(this.activeTasks.keys()),
          claimedTaskId: task.id,
          claimedTaskState: task.state || null,
          lastSyncAt: this.lastSyncAt,
        },
        `Claimed task ${task.id}`,
      );

      if (this.onTask) {
        const result = await this.onTask(task);
        if (result && result.state) {
          await this.reportTaskResult(task.id, result);
          this.activeTasks.delete(task.id);
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

  async writeTaskNote(taskId, note, handoff = null) {
    return http(`/api/mcp/tasks/${taskId}/notes`, {
      method: "POST",
      body: {
        note,
        agentId: this.agent.id,
        handoff,
      },
    });
  }

  async reportTaskResult(taskId, result) {
    return http(`/api/mcp/tasks/${taskId}/result`, {
      method: "POST",
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

  async checkpoint(checkpointJson, summary = null) {
    return http(`/api/mcp/agents/${this.agent.id}/sessions/${this.session.id}/checkpoint`, {
      method: "POST",
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
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.controlSyncTimer) clearInterval(this.controlSyncTimer);
    if (this.socket && this.socket.readyState === 1) this.socket.close();
    if (this.activeTasks.size > 0) {
      await this.checkpoint({
        reason: "shutdown",
        activeTaskIds: Array.from(this.activeTasks.keys()),
      }, summary);
    }

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
