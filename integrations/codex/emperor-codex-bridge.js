/**
 * EmperorClaw Codex Bridge
 *
 * Polls EmperorClaw for new messages directed to this agent,
 * runs `codex exec` with the message as prompt, and posts the result back.
 *
 * Usage: node emperor-codex-bridge.js
 *
 * Env vars (same contract as Hermes bridge):
 *   EMPEROR_CLAW_API_URL     — EmperorClaw base URL (default http://localhost:3000)
 *   EMPEROR_CLAW_API_TOKEN   — API token (required)
 *   EMPEROR_CLAW_AGENT_ID    — Agent UUID (required)
 *   EMPEROR_CLAW_AGENT_NAME  — Agent display name
 *   EMPEROR_CLAW_AGENT_ROLE  — Agent role description
 *   POLL_SECONDS             — Poll interval (default 5)
 */

const { spawn } = require("child_process");
const os = require("os");
const crypto = require("crypto");
const {
    classifyMessage, loopGuardOk, estimateUsageTokens, stripCodexNoise, replyFormatGuide,
    organizationContext, parseServerCapabilities, serverSupportsRuns, mapRunFinishStatus,
    mapExitToRunStatus, isRetryableLedgerError, createLedgerBreaker,
    buildRunStartPayload, buildRunFinishPayload,
} = require("./bridge-logic");

const API_URL = (process.env.EMPEROR_CLAW_API_URL || "http://localhost:3000").replace(/\/+$/, "");
const API_TOKEN = process.env.EMPEROR_CLAW_API_TOKEN || "";
const AGENT_ID = process.env.EMPEROR_CLAW_AGENT_ID || "";
const AGENT_NAME = process.env.EMPEROR_CLAW_AGENT_NAME || "Codex Agent";
const AGENT_ROLE = process.env.EMPEROR_CLAW_AGENT_ROLE || "operator";
const POLL_SECONDS = Math.max(2, parseInt(process.env.EMPEROR_CLAW_POLL_SECONDS || "5", 10));
const TIMEOUT_SECONDS = parseInt(process.env.EMPEROR_CLAW_CODEX_TIMEOUT || "120", 10);
// Bridge release, reported to the run ledger (and in the User-Agent).
const BRIDGE_VERSION = "0.2.0";
// Runtime id, reused by registration and the ledger start payload.
const RUNTIME_ID = `codex-${AGENT_ID.slice(0, 8)}`;

if (!API_TOKEN || !AGENT_ID) {
    console.error("[emperor-codex] EMPEROR_CLAW_API_TOKEN and EMPEROR_CLAW_AGENT_ID are required");
    process.exit(1);
}

const seen = new Set();
const loopCounts = new Map(); // threadId → consecutive agent message count
let lastSeenAt = null;

// The company chart changes rarely; cache GET /organization for this long so
// the per-turn prompt block does not re-fetch it on every message. On a failed
// fetch the last successful value is reused.
const ORG_CACHE_TTL_MS = 10 * 60 * 1000;
let orgCache = { info: null, at: 0 };

// Server capabilities from the last /runtime/register handshake, re-checked
// periodically so a server upgraded after this bridge started is picked up.
// Run-ledger reporting is gated on them: an older server advertises nothing
// and receives zero extra requests.
const CAPABILITY_REFRESH_MS = 10 * 60 * 1000;
let serverCapabilities = [];
let formatGuide = "";
let lastCapabilityRefresh = 0;

// Run-ledger state: a failed finish is retried exactly once on the next loop
// iteration; ledger failures are logged once until a call succeeds.
const LEDGER_TIMEOUT_MS = 5000;
let pendingRunFinish = null;
let ledgerFailureLogged = false;

function log(msg) {
    console.log(`[emperor-codex] ${new Date().toISOString()} ${msg}`);
}

// One breaker for all ledger calls: after 3 consecutive failures, skip the
// ledger for 5 minutes, then try once more.
const ledgerBreaker = createLedgerBreaker({
    onOpen: (failures, cooldownMs) => log(`run ledger circuit breaker open after ${failures} consecutive failures; skipping ledger calls for ${Math.round(cooldownMs / 1000)}s`),
    onClose: () => log("run ledger circuit breaker closed; resuming ledger reporting"),
});

async function api(method, path, body, timeoutMs) {
    const url = `${API_URL}/api/mcp${path}`;
    const headers = {
        "Authorization": `Bearer ${API_TOKEN}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "User-Agent": `emperor-codex-bridge/${BRIDGE_VERSION}`,
    };
    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);
    if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);

    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) {
        const error = new Error(`API ${method} ${path} failed ${res.status}: ${text.slice(0, 500)}`);
        error.status = res.status;
        throw error;
    }
    return text ? JSON.parse(text) : {};
}

/**
 * Learn (or refresh) the server's capability handshake. A failure keeps the
 * last known capabilities — an older or briefly unreachable server simply gets
 * no ledger reporting.
 */
async function refreshCapabilities() {
    try {
        const registered = await api("POST", "/runtime/register", {
            runtimeId: RUNTIME_ID,
            name: `Codex on ${os.hostname()}`,
            hostname: os.hostname(),
            gatewayVersion: "codex-cli",
            capabilitiesJson: ["codex-cli", "thread-reply", "rich-replies"],
        });
        serverCapabilities = parseServerCapabilities(registered);
        formatGuide = replyFormatGuide(registered);
    } catch (e) {
        // Keep the previous values; nothing to report yet.
    }
    lastCapabilityRefresh = Date.now();
}

function noteLedgerFailure(where, e) {
    if (ledgerFailureLogged) return;
    ledgerFailureLogged = true;
    log(`run ledger ${where} failed (best-effort, continuing): ${e.message}`);
}

function noteLedgerOk() {
    ledgerFailureLogged = false;
}

/** POST a run start. Never throws; a failure is not retried. */
async function reportRunStart(payload) {
    if (ledgerBreaker.shouldSkip()) return false;
    try {
        await api("POST", "/agents/runs", payload, LEDGER_TIMEOUT_MS);
        noteLedgerOk();
        ledgerBreaker.recordSuccess();
        return true;
    } catch (e) {
        noteLedgerFailure("start", e);
        ledgerBreaker.recordFailure();
        return false;
    }
}

/** PATCH a run finish. Never throws; a transient failure queues one retry. */
async function reportRunFinish(id, payload) {
    if (ledgerBreaker.shouldSkip()) return;
    try {
        await api("PATCH", `/agents/runs/${id}`, payload, LEDGER_TIMEOUT_MS);
        noteLedgerOk();
        ledgerBreaker.recordSuccess();
        if (pendingRunFinish && pendingRunFinish.id === id) pendingRunFinish = null;
    } catch (e) {
        noteLedgerFailure("finish", e);
        ledgerBreaker.recordFailure();
        // A 4xx is permanent, so it is never queued for retry.
        if (isRetryableLedgerError(e)) pendingRunFinish = { id, payload };
    }
}

/** Flush a finish that failed last iteration — exactly one retry. */
async function retryPendingRunFinish() {
    if (!pendingRunFinish) return;
    const pending = pendingRunFinish;
    pendingRunFinish = null;
    if (ledgerBreaker.shouldSkip()) return;
    try {
        await api("PATCH", `/agents/runs/${pending.id}`, pending.payload, LEDGER_TIMEOUT_MS);
        noteLedgerOk();
        ledgerBreaker.recordSuccess();
    } catch (e) {
        noteLedgerFailure("finish retry", e);
        ledgerBreaker.recordFailure();
    }
}

/** Short, secret-safe ledger error text (no stack). */
function ledgerErrorText(err) {
    if (!err) return null;
    const text = String(err.message || err).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 500) : null;
}

/** Compact org block for this turn, served from the 10-minute cache. */
async function organizationBlock() {
    const now = Date.now();
    if (orgCache.info && now - orgCache.at < ORG_CACHE_TTL_MS) {
        return organizationContext(orgCache.info, AGENT_ID);
    }
    try {
        const info = await api("GET", `/organization?agentId=${encodeURIComponent(AGENT_ID)}`);
        orgCache = { info, at: now };
        return organizationContext(info, AGENT_ID);
    } catch (e) {
        return orgCache.info ? organizationContext(orgCache.info, AGENT_ID) : "";
    }
}

async function heartbeat() {
    try {
        await api("POST", "/agents/heartbeat", { agentId: AGENT_ID, currentLoad: 0 });
    } catch (e) {
        log(`heartbeat failed: ${e.message}`);
    }
}

async function checkBudget() {
    try {
        await flushUsage();
        const payload = await api("GET", `/agents/${AGENT_ID}`);
        const agent = payload.agent || payload;
        const status = agent.budgetStatus || "active";
        const usage = agent.monthlyTokenUsage || 0;
        const budget = agent.monthlyBudgetCents || 0;
        if (agent.executionAllowed !== true || status === "paused") {
            log(`BUDGET PAUSED: ${usage} tokens used of ${budget} cents budget`);
            return false;
        }
        return true;
    } catch (e) {
        log(`budget check failed; dispatch blocked: ${e.message}`);
        return false;
    }
}

// Keep unacknowledged usage in memory and flush it before any subsequent turn.
const pendingUsage = [];
async function flushUsage() {
    while (pendingUsage.length) {
        await api("POST", "/agents/report-usage", pendingUsage[0]);
        pendingUsage.shift();
    }
}

async function reportUsage(inputTokens, outputTokens) {
    pendingUsage.push({
        agentId: AGENT_ID,
        inputTokens: Math.max(0, Math.round(inputTokens) || 0),
        outputTokens: Math.max(0, Math.round(outputTokens) || 0),
    });
    await flushUsage();
}

async function syncMessages() {
    // Pass the bound agent id so the server attaches its per-agent routing
    // verdict (`addressedToYou`) to every message. Without it Codex cannot tell
    // a sibling mention/handoff from a message meant for someone else.
    const query = ["mode=all", `agentId=${encodeURIComponent(AGENT_ID)}`];
    if (lastSeenAt) query.push(`since=${encodeURIComponent(lastSeenAt)}`);
    const payload = await api("GET", `/messages/sync?${query.join("&")}`);
    return Array.isArray(payload.messages) ? payload.messages : [];
}

async function sendReply(message, text) {
    if (!text) return null;
    const body = {
        thread_id: message.threadId || message.thread_id,
        agentId: AGENT_ID,
        text,
        targetAgentId: null,
        replyToMessageId: message.id,
    };
    // Only send thread_type when the server supplied one; forcing "direct"
    // would let a reply land in the sender's own operator DM. replyToMessageId
    // lets the server derive the real thread from the message being answered.
    const threadType = message.threadType || message.thread_type;
    if (threadType) body.thread_type = threadType;
    const response = await api("POST", "/messages/send", body);
    return response && response.message_id ? String(response.message_id) : null;
}

async function updateStatus(message, opts = {}) {
    const threadId = message.threadId || message.thread_id;
    if (!threadId) return;
    await api("POST", "/chat/status", {
        threadId,
        agentId: AGENT_ID,
        ...opts,
    });
}

async function main() {
    log(`starting agent=${AGENT_NAME} id=${AGENT_ID} poll=${POLL_SECONDS}s`);

    // Register runtime. The response carries the server's capability handshake
    // and (when advertised) the rich-reply guide. Older servers return only
    // runtimeNode, so capabilities stay empty and ledger reporting is skipped.
    await refreshCapabilities();

    await heartbeat();

    let lastHeartbeat = Date.now();

    while (true) {
        try {
            if (Date.now() - lastHeartbeat >= 60000) {
                await heartbeat();
                lastHeartbeat = Date.now();
            }
            if (Date.now() - lastCapabilityRefresh >= CAPABILITY_REFRESH_MS) {
                await refreshCapabilities();
            }
            // One retry for a run finish that failed transiently last iteration.
            await retryPendingRunFinish();

            const messages = await syncMessages();
            for (const msg of messages) {
                const msgId = msg.id;
                if (!msgId || seen.has(msgId)) continue;

                // ── SAFETY CHECKS (pure logic in ./bridge-logic.js) ─────
                const threadId = msg.threadId || msg.thread_id || "";
                const text = (msg.text || "").trim();

                const decision = classifyMessage(msg, { agentId: AGENT_ID, agentName: AGENT_NAME });

                // Reset the loop guard whenever a human speaks in the thread.
                if (decision.resetLoop) loopCounts.set(threadId, 0);

                if (decision.action === "skip") {
                    seen.add(msgId);
                    if (msg.createdAt) lastSeenAt = msg.createdAt;
                    continue;
                }

                log(`dispatching message ${msgId}: "${text.slice(0, 80)}..."`);
                
                // Budget check — skip if paused. Check on EVERY message: sampling
                // (every 5th) let a paused agent keep answering 4 of 5 messages.
                // checkBudget() is a single cheap GET and messages are infrequent.
                const budgetOk = await checkBudget();
                if (!budgetOk) {
                    // Leave this and later messages queued for a reset or repaired check.
                    break;
                }

                // Loop guard: cap consecutive non-human replies per thread.
                if (!loopGuardOk(loopCounts, threadId)) {
                    log(`loop guard tripped in thread ${threadId}, pausing`);
                    seen.add(msgId);
                    if (msg.createdAt) lastSeenAt = msg.createdAt;
                    continue;
                }

                await updateStatus(msg, { markRead: true, executionState: "seen" });
                await updateStatus(msg, { typing: true, executionState: "acting" });

                // Operating manual + message prompt
                const orgBlock = await organizationBlock();
                const prompt = [
                    `You are an AI agent running on EmperorClaw, an open-source AI operations platform (github.com/emperorclaw/emperorclaw).`,
                    `Agent: ${AGENT_NAME} | Role: ${AGENT_ROLE} | Runtime: Codex CLI (on-demand)`,
                    ``,
                    `## EmperorClaw Context`,
                    `- You reply to messages via chat. You do NOT have direct access to EmperorClaw tools (projects, tasks, storage).`,
                    `- For operations requiring EmperorClaw API access (listing projects, creating tasks, uploading files), direct the user to a Hermes agent.`,
                    `- Direct chat: private 1-on-1 thread. Reply normally.`,
                    `- Team chat: answer when the message is addressed to you by name — that includes a sibling agent handing you work. Stay silent when it is not.`,
                    `- Group chats: members-only team channels with the same rule. A human's @all in a group is addressed to you; never write @all yourself.`,
                    `- Be concise. One clear answer per response. No walls of text.`,
                    `- Your reply is shown in Emperor Claw's web chat, not a terminal: Markdown renders (tables, code, links).`,
                    ``,
                    ...(orgBlock ? [orgBlock, ``] : []),
                    ...(formatGuide ? [formatGuide, ``] : []),
                    `## Message to answer`,
                    text,
                ].join("\n");

                // Open the run before dispatch, but only on a server that
                // advertises the ledger; an older server gets zero extra calls.
                const runId = crypto.randomUUID();
                const turnStartMs = Date.now();
                const ledgerEnabled = serverSupportsRuns(serverCapabilities);
                if (ledgerEnabled) {
                    await reportRunStart(buildRunStartPayload({
                        id: runId,
                        agentId: AGENT_ID,
                        runtimeId: RUNTIME_ID,
                        bridgeVersion: BRIDGE_VERSION,
                        triggerMessageId: msgId,
                        threadId,
                        taskId: msg.taskId || msg.task_id,
                        startedAt: new Date(turnStartMs).toISOString(),
                    }));
                }

                let finishStatus = "succeeded";
                let finishError = null;
                let replyMessageId = null;
                let usage = null;
                let replyFailure = null;

                // Pipe prompt via stdin (Paperclip pattern)
                // shell:true needed on Windows for .cmd files
                try {
                    const result = await new Promise((resolve, reject) => {
                        const child = spawn("codex", ["exec", "-"], {
                            timeout: TIMEOUT_SECONDS * 1000,
                            stdio: ["pipe", "pipe", "pipe"],
                            shell: process.platform === "win32",
                            env: { ...process.env },
                        });

                        let stdout = "";
                        let stderr = "";
                        child.stdout.on("data", (d) => { stdout += d.toString("utf-8"); });
                        child.stderr.on("data", (d) => { stderr += d.toString("utf-8"); });

                        // Write prompt to stdin and close it
                        child.stdin.write(prompt);
                        child.stdin.end();

                        child.on("close", (code, signal) => {
                            // Strip Codex rollout noise (Paperclip pattern)
                            const clean = stripCodexNoise(stdout);
                            const output = clean || stderr.trim();
                            resolve({ output, code, signal });
                        });
                        child.on("error", reject);
                    });

                    // A non-zero exit is a failed turn; the spawn timeout kills
                    // the child with a signal, which is a timeout.
                    const exitStatus = mapExitToRunStatus(result.code, result.signal);
                    if (exitStatus !== "succeeded") {
                        finishStatus = exitStatus;
                        finishError = result.signal
                            ? `codex exec killed after ${TIMEOUT_SECONDS}s`
                            : `codex exec exited with code ${result.code}`;
                    }

                    if (result.output) {
                        // Estimate and report token usage. Split into input (prompt)
                        // vs output (reply) so the server applies the correct
                        // per-direction price and enforces budget.
                        usage = estimateUsageTokens(prompt, result.output);
                        try {
                            await reportUsage(usage.inputTokens, usage.outputTokens);
                        } catch (error) {
                            log(`usage report pending; future dispatch blocked: ${error.message}`);
                        }
                        replyMessageId = await sendReply(msg, result.output);
                        log(`replied to ${msgId} (${result.output.length} chars)`);
                    }
                } catch (execErr) {
                    log(`codex exec failed: ${execErr.message}`);
                    finishStatus = mapRunFinishStatus(execErr);
                    finishError = ledgerErrorText(execErr);
                    // A failing error reply must still throw into the loop catch
                    // (message not marked seen, retried), exactly as before the
                    // ledger existed. Capture it, attempt the finish best-effort,
                    // then rethrow below.
                    try {
                        await sendReply(msg, `[Codex error: ${execErr.message}]`);
                    } catch (replyErr) {
                        replyFailure = replyErr;
                    }
                }

                // User-visible state first: the ledger report must never delay
                // the resolved status. On a failed reply, skip it exactly as
                // before so the message stays unseen and is retried.
                if (!replyFailure) {
                    await updateStatus(msg, { typing: false, executionState: "resolved" });
                }

                // Always attempt the finish when the ledger is enabled — a lost
                // start is upserted by the server PATCH — subject to the breaker.
                if (ledgerEnabled) {
                    await reportRunFinish(runId, buildRunFinishPayload({
                        status: finishStatus,
                        endedAt: new Date().toISOString(),
                        durationMs: Date.now() - turnStartMs,
                        inputTokens: usage ? usage.inputTokens : undefined,
                        outputTokens: usage ? usage.outputTokens : undefined,
                        replyMessageId,
                        error: finishError,
                    }));
                }

                if (replyFailure) throw replyFailure;

                seen.add(msgId);
                if (msg.createdAt) lastSeenAt = msg.createdAt;

                // Keep seen set and loop counts bounded
                if (seen.size > 500) {
                    const arr = [...seen];
                    arr.splice(0, 250);
                    seen.clear();
                    arr.forEach((id) => seen.add(id));
                }
                if (loopCounts.size > 100) {
                    const entries = [...loopCounts.entries()];
                    entries.splice(0, 50);
                    loopCounts.clear();
                    entries.forEach(([k, v]) => loopCounts.set(k, v));
                }
            }
        } catch (e) {
            log(`loop error: ${e.message}`);
        }

        await new Promise((r) => setTimeout(r, POLL_SECONDS * 1000));
    }
}

main().catch((e) => {
    console.error("[emperor-codex] Fatal:", e.message);
    process.exit(1);
});
