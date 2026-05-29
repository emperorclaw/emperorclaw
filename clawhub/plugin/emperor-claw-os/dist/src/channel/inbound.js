import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { resolveEmperorChannelAccount } from "./config.js";
import { decideThreadRouting } from "./routing-policy.js";
import { sendEmperorOutboundText } from "./outbound.js";
import { loadManifests } from "../state/manifests.js";
import { loadThreadOwners, setThreadOwner } from "../state/thread-owners.js";
const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const SYNC_POLL_MS = 15_000;
const BRAIN_TIMEOUT_MS = 120_000;
const MAX_DEDUPE = 1_000;
function jitter(ms) {
    return ms + Math.floor(ms * 0.2 * (Math.random() - 0.5));
}
function nextBackoff(attempt) {
    return jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, attempt)));
}
function dedupeInsert(set, id) {
    if (set.has(id))
        return true;
    set.add(id);
    if (set.size > MAX_DEDUPE) {
        const first = set.values().next().value;
        if (first)
            set.delete(first);
    }
    return false;
}
function resolveManifestWorkspaceDir(manifest) {
    return path.join(os.homedir(), ".openclaw", `workspace-${manifest.localBrainAgentId}`);
}
async function invokeBrain(runtime, manifest, sessionId, prompt, ctx) {
    try {
        const agentId = manifest.localBrainAgentId;
        const workspaceDir = resolveManifestWorkspaceDir(manifest);
        const sessionFile = runtime.agent.session.resolveSessionFilePath(sessionId, {}, { agentId });
        const result = await runtime.agent.runEmbeddedPiAgent({
            sessionId,
            sessionFile,
            workspaceDir,
            agentId,
            prompt,
            timeoutMs: BRAIN_TIMEOUT_MS,
            runId: randomUUID(),
            trigger: "user",
            requireExplicitMessageTarget: false,
            disableMessageTool: false,
        });
        const payloads = Array.isArray(result?.payloads) ? result.payloads : [];
        const best = payloads
            .map((p) => String(p?.text || "").trim())
            .filter(Boolean)
            .pop();
        return (best ?? String(result?.reply || result?.text || "").trim()) || null;
    }
    catch (err) {
        ctx.logger.error(`Emperor inbound: brain invocation failed for ${manifest.localBrainAgentId}: ${err}`);
        return null;
    }
}
async function dispatchMessage(message, account, paths, runtime, seenIds, ctx) {
    const text = String(message?.text || "").trim();
    if (!text)
        return;
    const msgId = String(message?.id || "");
    const dedupeKey = msgId
        || `${message.threadId}:${message.createdAt}:${text.slice(0, 40)}`;
    if (dedupeInsert(seenIds, dedupeKey))
        return;
    const senderType = String(message?.senderType || "");
    if (senderType !== "human")
        return;
    const threadId = String(message?.threadId || "");
    const threadType = String(message?.threadType || "direct");
    const senderId = String(message?.senderId || "");
    const targetAgentId = String(message?.targetAgentId || "") || null;
    const manifests = loadManifests(paths);
    if (manifests.length === 0)
        return;
    const threadOwners = loadThreadOwners(paths);
    for (const manifest of manifests) {
        if (!manifest.agentId || !manifest.localBrainAgentId)
            continue;
        const decision = decideThreadRouting({ id: threadId, type: threadType }, { senderId, senderType: "human", text, targetAgentId }, {
            currentAgentId: manifest.agentId,
            currentAgentName: manifest.agentName,
            profile: manifest.profile || "operator",
            existingThreadOwnerId: (threadOwners[threadId] ?? null),
            policy: manifest.threadPolicy,
        });
        if (!decision.shouldProcess)
            continue;
        if (decision.nextThreadOwnerId) {
            setThreadOwner(paths, threadId, decision.nextThreadOwnerId);
        }
        const sessionId = `emperor:${manifest.localBrainAgentId}:${threadId}`;
        const reply = await invokeBrain(runtime, manifest, sessionId, text, ctx);
        if (!reply)
            continue;
        try {
            await sendEmperorOutboundText({
                account,
                to: `emperor-claw-os:thread:${threadId}`,
                text: reply,
                threadId,
                threadType: threadType,
                targetAgentId: senderId || null,
            });
        }
        catch (err) {
            ctx.logger.error(`Emperor inbound: reply send failed: ${err}`);
        }
        break;
    }
}
async function runSyncPoll(account, paths, runtime, state, ctx) {
    try {
        const since = state.lastSeenAt
            ? `&since=${encodeURIComponent(state.lastSeenAt)}`
            : "";
        const res = await fetch(`${account.apiUrl}/api/mcp/messages/sync?mode=all${since}`, { headers: { Authorization: `Bearer ${account.token}` } });
        if (!res.ok)
            return;
        const data = await res.json();
        const messages = Array.isArray(data?.messages)
            ? data.messages
            : [];
        for (const msg of messages) {
            const ts = String(msg?.createdAt || "");
            if (ts)
                state.lastSeenAt = ts;
            await dispatchMessage(msg, account, paths, runtime, state.seenIds, ctx);
        }
    }
    catch (err) {
        ctx.logger.warn?.(`Emperor inbound: sync poll error: ${err}`);
    }
}
function startSyncFallback(account, paths, runtime, state, ctx) {
    if (state.syncTimer)
        return;
    void runSyncPoll(account, paths, runtime, state, ctx);
    state.syncTimer = setInterval(() => void runSyncPoll(account, paths, runtime, state, ctx), SYNC_POLL_MS);
}
function stopSyncFallback(state) {
    if (state.syncTimer) {
        clearInterval(state.syncTimer);
        state.syncTimer = null;
    }
}
function scheduleReconnect(account, paths, runtime, state, ctx) {
    if (state.stopped)
        return;
    const delay = nextBackoff(state.reconnectAttempt++);
    ctx.logger.info(`Emperor inbound: reconnecting in ${delay}ms (attempt ${state.reconnectAttempt})`);
    state.reconnectTimer = setTimeout(() => {
        if (!state.stopped)
            openWebSocket(account, paths, runtime, state, ctx);
    }, delay);
}
function openWebSocket(account, paths, runtime, state, ctx) {
    if (state.stopped)
        return;
    // Node 22+ ships WebSocket globally; fall back to sync polling on older runtimes.
    const WS = globalThis["WebSocket"];
    if (!WS) {
        ctx.logger.warn?.("Emperor inbound: built-in WebSocket unavailable, using sync polling only");
        startSyncFallback(account, paths, runtime, state, ctx);
        return;
    }
    const wsUrl = account.apiUrl
        .replace(/^https:\/\//, "wss://")
        .replace(/^http:\/\//, "ws://")
        + "/api/mcp/ws";
    const ws = new WS(wsUrl, {
        headers: { Authorization: `Bearer ${account.token}` },
    });
    state.ws = ws;
    ws.addEventListener("open", () => {
        ctx.logger.info("Emperor inbound: WebSocket connected");
        state.reconnectAttempt = 0;
        stopSyncFallback(state);
    });
    ws.addEventListener("message", (event) => {
        try {
            const envelope = JSON.parse(event.data);
            const payload = envelope?.payload;
            if (payload?.type === "thread_message" && payload.message) {
                void dispatchMessage(payload.message, account, paths, runtime, state.seenIds, ctx);
            }
        }
        catch {
            // Ignore malformed frames
        }
    });
    ws.addEventListener("close", () => {
        if (state.stopped)
            return;
        ctx.logger.warn?.("Emperor inbound: WebSocket closed, switching to sync fallback");
        state.ws = null;
        startSyncFallback(account, paths, runtime, state, ctx);
        scheduleReconnect(account, paths, runtime, state, ctx);
    });
    ws.addEventListener("error", () => {
        if (state.stopped)
            return;
        state.ws = null;
        startSyncFallback(account, paths, runtime, state, ctx);
        scheduleReconnect(account, paths, runtime, state, ctx);
    });
}
export function createEmperorInboundService(paths, getRuntime) {
    const state = {
        stopped: false,
        ws: null,
        syncTimer: null,
        reconnectTimer: null,
        reconnectAttempt: 0,
        lastSeenAt: null,
        seenIds: new Set(),
    };
    return {
        id: "emperor-inbound",
        async start(ctx) {
            const runtime = getRuntime();
            if (!runtime) {
                ctx.logger.warn?.("Emperor inbound: runtime not yet available, service will not start");
                return;
            }
            let account;
            try {
                account = resolveEmperorChannelAccount(ctx.config);
            }
            catch {
                ctx.logger.warn?.("Emperor inbound: channel not configured (channels.emperor-claw-os.token missing), service idle");
                return;
            }
            ctx.logger.info("Emperor inbound: starting");
            openWebSocket(account, paths, runtime, state, ctx);
        },
        async stop() {
            state.stopped = true;
            clearTimeout(state.reconnectTimer ?? undefined);
            stopSyncFallback(state);
            if (state.ws) {
                try {
                    state.ws.close();
                }
                catch { /* ignore */ }
                state.ws = null;
            }
        },
    };
}
