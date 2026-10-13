/**
 * Pure, dependency-free decision logic for the Codex bridge.
 *
 * Extracted so the "should this agent reply, and how much did it cost?" behavior
 * can be unit-tested deterministically WITHOUT spawning a real LLM or hitting the
 * network. The bridge (emperor-codex-bridge.js) requires these and keeps only the
 * I/O (HTTP polling, spawning codex, posting replies) around them.
 */

/**
 * Decide what to do with an inbound message.
 *
 * @param {object} msg   Raw message from /messages/sync.
 * @param {object} ctx   { agentId, agentName }
 * @returns {{ action: "respond"|"skip", reason: string, resetLoop: boolean }}
 *   resetLoop is true for human messages (the caller should reset that thread's
 *   loop counter). Callers apply resetLoop regardless of action.
 */
function classifyMessage(msg, ctx) {
    const senderType = String(msg.senderType || msg.sender_type || "").toLowerCase();
    const senderId = String(msg.senderId || msg.sender_id || msg.fromUserId || "");
    const targetId = msg.targetAgentId || msg.target_agent_id || "";
    const threadType = String(msg.threadType || msg.thread_type || "");
    const text = String(msg.text || "").trim();

    const resetLoop = senderType === "human";

    // Never answer your own message, whatever the server says.
    if (senderType === "agent" && ctx.agentId && senderId === ctx.agentId) {
        return { action: "skip", reason: "self", resetLoop };
    }
    // Ignore empty messages.
    if (!text) return { action: "skip", reason: "empty", resetLoop };
    // The server's authenticated verdict is authoritative for EVERY sender,
    // including agents: it is how a sibling mention/handoff reaches this agent.
    // A loop-paused or not-addressed message arrives as addressedToYou:false,
    // and an agent's @all never marks other agents addressed, so obeying the
    // verdict cannot fan out agent-to-agent.
    if (typeof msg.addressedToYou === "boolean") {
        return msg.addressedToYou
            ? { action: "respond", reason: `server:${msg.routeReason || "addressed"}`, resetLoop }
            : { action: "skip", reason: `server:${msg.routeReason || "not-addressed"}`, resetLoop };
    }
    // No verdict means an older server. Fail closed for agent senders: keep the
    // old "never take a sibling handoff" behavior rather than guessing routing
    // from text. Human messages fall through to the local rules below.
    if (senderType === "agent") return { action: "skip", reason: "agent-no-verdict", resetLoop };
    // Direct message addressed to a different agent.
    if (targetId && targetId !== ctx.agentId) return { action: "skip", reason: "other-target", resetLoop };
    // Team chat and group chats: only respond when @mentioned by name. A group
    // is a members-only team channel; a type the bridge doesn't know is
    // treated the same way, never as a private thread.
    const isTeamChat = threadType === "team" || threadType === "group" || (!targetId && threadType !== "direct");
    // A human's @all in a group addresses every member agent. Agent senders
    // never reach here without a server verdict (they fail closed above).
    const mentioned = text.includes(`@${ctx.agentName}`)
        || (threadType === "group" && /(^|[^\w@])@(all|everyone)(?![\w-])/i.test(text));
    if (isTeamChat && !targetId && !mentioned) return { action: "skip", reason: "team-no-mention", resetLoop };

    return { action: "respond", reason: "ok", resetLoop };
}

/**
 * Loop guard: increment the per-thread reply counter and report whether it is
 * still under the cap. Mutates loopCounts (a Map). Returns true if OK to reply.
 */
function loopGuardOk(loopCounts, threadId, max = 3) {
    const n = (loopCounts.get(threadId) || 0) + 1;
    loopCounts.set(threadId, n);
    return n <= max;
}

/** Rough token estimate for a prompt/reply pair (~4 chars per token). */
function estimateUsageTokens(promptText, replyText) {
    return {
        inputTokens: Math.ceil(String(promptText || "").length / 4),
        outputTokens: Math.ceil(String(replyText || "").length / 4),
    };
}

/** Strip Codex rollout noise lines from stdout (the "Paperclip pattern"). */
function stripCodexNoise(stdout) {
    return String(stdout || "")
        .split(/\r?\n/)
        .filter((l) => !/codex_core::rollout/i.test(l))
        .join("\n")
        .trim();
}

/**
 * Who this agent reports to, from the chart: its first reporting line, else the
 * coordinator of a team it belongs to. Mirrors the Hermes bridge's resolution.
 */
function reportsToName(info, leader, agentId) {
    const reporting = Array.isArray(info.reporting) ? info.reporting : [];
    for (const relation of reporting) {
        if (!relation || typeof relation !== "object") continue;
        const target = relation.reportsTo && typeof relation.reportsTo === "object" ? relation.reportsTo : {};
        return String(target.name || "humans");
    }
    const teams = Array.isArray(info.teams) ? info.teams : [];
    for (const team of teams) {
        if (!team || typeof team !== "object") continue;
        const coordinator = team.coordinator && typeof team.coordinator === "object" ? team.coordinator : {};
        if (coordinator.kind === "agent" && coordinator.id === agentId) {
            if (leader.kind === "agent" && leader.id === agentId) return "humans";
            return String(leader.name || "humans");
        }
        return String(coordinator.name || leader.name || "unassigned");
    }
    return "humans";
}

/**
 * Minimal org chart reminder: the leader and this agent's reporting line, plus
 * one escalation rule. Same wording as the Hermes bridge so both runtimes speak
 * one minimal org vocabulary. Returns "" when the organization is unconfigured
 * or the payload is malformed. Kept well under 400 chars regardless of company
 * size.
 *
 * @param {object} info     GET /organization response.
 * @param {string} agentId  This agent's id.
 */
function organizationContext(info, agentId) {
    if (!info || typeof info !== "object" || !info.configured) return "";
    const leader = info.leader && typeof info.leader === "object" ? info.leader : {};
    const leaderName = String(leader.name || "unassigned").slice(0, 64);
    const reportingLine = leader.kind === "agent" && leader.id === agentId
        ? "you lead the company; report to humans"
        : "you report to " + reportsToName(info, leader, agentId).slice(0, 64);
    return `Org: leader ${leaderName}; ${reportingLine}\n`
        + "Escalate cross-team conflicts to the leader; details: GET /organization.";
}

/**
 * Reply-format guide from the server's /runtime/register handshake, or "".
 * Only a server advertising rich-blocks-v1 sends one; an older server's
 * response has neither field, so the agent keeps writing plain Markdown.
 * EMPEROR_CLAW_RICH_REPLIES=off opts an agent out.
 */
function replyFormatGuide(registerResponse, env = process.env) {
    const optOut = String(env.EMPEROR_CLAW_RICH_REPLIES || "on").trim().toLowerCase();
    if (["0", "off", "false", "no"].includes(optOut)) return "";
    if (!registerResponse || typeof registerResponse !== "object") return "";
    const caps = Array.isArray(registerResponse.serverCapabilities) ? registerResponse.serverCapabilities : [];
    if (!caps.includes("rich-blocks-v1")) return "";
    const guide = registerResponse.replyFormatGuide;
    return typeof guide === "string" ? guide.trim().slice(0, 8000) : "";
}

// ── Run ledger (PR 3) ───────────────────────────────────────────────────────
// Pure builders/mappers for the turn ledger; the bridge keeps only the I/O.

/** The run-ledger capability token (matches the server's SERVER_CAPABILITIES). */
const RUNS_CAPABILITY = "runs: 1";

/**
 * Server capabilities from a /runtime/register response, coerced to strings.
 * An older server sends neither field, so this yields [] and ledger reporting
 * is skipped rather than erroring.
 */
function parseServerCapabilities(registerResponse) {
    if (!registerResponse || typeof registerResponse !== "object") return [];
    const raw = Array.isArray(registerResponse.serverCapabilities) ? registerResponse.serverCapabilities : [];
    return raw.filter((c) => typeof c === "string" || typeof c === "number").map(String);
}

/** Whether a capability list includes the run-ledger capability. */
function serverSupportsRuns(capabilities) {
    return Array.isArray(capabilities) && capabilities.includes(RUNS_CAPABILITY);
}

/**
 * Map a turn outcome to a ledger finish status. `err` is null/undefined for a
 * clean turn; RUN_TIMEOUT / RUN_CANCELLED carry their terminal status; anything
 * else is a failure.
 */
function mapRunFinishStatus(err) {
    if (!err) return "succeeded";
    if (err.code === "RUN_TIMEOUT" || err.timedOut === true) return "timeout";
    if (err.code === "RUN_CANCELLED") return "cancelled";
    return "failed";
}

/**
 * Map a finished `codex exec` child to a ledger status. A signal means the
 * spawn timeout killed the child (a timed-out turn); any other non-zero exit is
 * a failure; only a 0 exit with no signal is a success.
 */
function mapExitToRunStatus(code, signal) {
    if (signal) return "timeout";
    if (code !== 0) return "failed";
    return "succeeded";
}

/** A 4xx (validation/auth) is permanent and never retried; anything else is. */
function isRetryableLedgerError(err) {
    const status = err && err.status;
    if (typeof status === "number" && status >= 400 && status < 500) return false;
    return true;
}

const LEDGER_BREAKER_THRESHOLD = 3;
const LEDGER_BREAKER_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * A circuit breaker for the run ledger. After `threshold` consecutive failures
 * it skips every ledger call for `cooldownMs`, then tries once more. Pure
 * timing logic with an injectable clock so tests can advance time without
 * waiting; `onOpen`/`onClose` fire exactly once per transition for logging.
 */
function createLedgerBreaker({ threshold = LEDGER_BREAKER_THRESHOLD, cooldownMs = LEDGER_BREAKER_COOLDOWN_MS, now = Date.now, onOpen = () => {}, onClose = () => {} } = {}) {
    let failures = 0;
    let openUntil = 0;
    return {
        /** True while the breaker is open, so every ledger call is skipped. */
        shouldSkip() {
            if (!openUntil) return false;
            if (now() >= openUntil) {
                openUntil = 0;
                failures = 0;
                onClose();
                return false;
            }
            return true;
        },
        recordSuccess() {
            failures = 0;
        },
        recordFailure() {
            failures += 1;
            if (!openUntil && failures >= threshold) {
                openUntil = now() + cooldownMs;
                onOpen(failures, cooldownMs);
            }
        },
    };
}

/** POST /agents/runs body for one turn. Unset optional ids are omitted. */
function buildRunStartPayload({ id, agentId, runtimeId, runtimeKind = "codex", bridgeVersion, triggerKind = "message", triggerMessageId, threadId, taskId, startedAt }) {
    const payload = { id, agentId, runtimeId, runtimeKind, bridgeVersion, triggerKind, startedAt };
    if (triggerMessageId) payload.triggerMessageId = triggerMessageId;
    if (threadId) payload.threadId = threadId;
    if (taskId) payload.taskId = taskId;
    return payload;
}

/** PATCH /agents/runs/{id} body for one turn. Unset fields are omitted. */
function buildRunFinishPayload({ status, endedAt, durationMs, inputTokens, outputTokens, toolCalls, replyMessageId, error }) {
    const payload = { status };
    if (endedAt) payload.endedAt = endedAt;
    const optional = { durationMs, inputTokens, outputTokens, toolCalls, replyMessageId, error };
    for (const key of Object.keys(optional)) {
        if (optional[key] !== undefined && optional[key] !== null) payload[key] = optional[key];
    }
    return payload;
}

module.exports = { classifyMessage, loopGuardOk, estimateUsageTokens, stripCodexNoise, replyFormatGuide, organizationContext, RUNS_CAPABILITY, parseServerCapabilities, serverSupportsRuns, mapRunFinishStatus, mapExitToRunStatus, isRetryableLedgerError, createLedgerBreaker, LEDGER_BREAKER_THRESHOLD, LEDGER_BREAKER_COOLDOWN_MS, buildRunStartPayload, buildRunFinishPayload };
