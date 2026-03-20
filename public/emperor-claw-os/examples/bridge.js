#!/usr/bin/env node
"use strict";

/**
 * Emperor Claw bridge example for OpenClaw.
 *
 * This is a real runnable reference adapter that:
 * - registers a runtime node
 * - resolves or creates the local agent record
 * - opens a durable Emperor session
 * - hydrates memory from Emperor
 * - maintains heartbeat
 * - connects to the MCP WebSocket, with /messages/sync fallback
 * - exposes helper methods for memory, actions, and messages
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
  // eslint-disable-next-line global-require
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
    this.lastSeenAt = null;
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
    await this.sendMessage("Bridge online. Hydrated Emperor memory and waiting for commands.", { chat_id: "team" });

    this.startHeartbeatLoop();
    this.connectWebSocket();
    this.startSyncFallback();
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

  startHeartbeatLoop() {
    const tick = async () => {
      try {
        await http("/api/mcp/agents/heartbeat", {
          method: "POST",
          body: { agentId: this.agent.id, currentLoad: 0 },
        });
      } catch (error) {
        console.error("[bridge] heartbeat failed:", error.message);
      }
    };

    tick();
    this.heartbeatTimer = setInterval(tick, HEARTBEAT_MS);
  }

  connectWebSocket() {
    const WebSocketCtor = getWebSocketCtor();
    const socketUrl = API_URL.replace(/^http/, "ws") + "/api/mcp/ws";

    this.socket = new WebSocketCtor(socketUrl, {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });

    this.socket.onopen = () => {
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
      console.warn("[bridge] websocket disconnected, retrying in 5s");
      setTimeout(() => this.connectWebSocket(), 5000);
    };

    this.socket.onerror = (error) => {
      console.error("[bridge] websocket error:", error.message || error);
    };
  }

  startSyncFallback() {
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
      } catch (error) {
        console.error("[bridge] sync fallback failed:", error.message);
      }
    };

    this.syncTimer = setInterval(loop, 15000);
  }

  async handleRealtimeEvent(payload) {
    if (payload.type === "connected") {
      console.log("[bridge] ws tunnel established");
      return;
    }

    if (payload.type === "thread_message") {
      console.log(`[bridge] thread_message thread=${payload.thread?.id || "unknown"} sender=${payload.message?.senderType || "unknown"}`);
      return;
    }

    if (payload.type === "new_task") {
      console.log(`[bridge] new_task id=${payload.task?.id || "unknown"} type=${payload.task?.taskType || "unknown"}`);
      return;
    }

    if (payload.type === "task_updated") {
      console.log(`[bridge] task_updated id=${payload.task?.id || "unknown"} state=${payload.task?.state || "unknown"}`);
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

    console.log("[bridge] realtime event:", payload.type);
  }

  async handlePolledMessage(message) {
    console.log("[bridge] polled message:", message.text);
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

  async end(summary = "Bridge shutdown") {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    if (this.socket && this.socket.readyState === 1) this.socket.close();

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
  const bridge = new EmperorBridge();
  await bridge.start();

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
}

main().catch((error) => {
  console.error("[bridge] fatal:", error);
  process.exit(1);
});
