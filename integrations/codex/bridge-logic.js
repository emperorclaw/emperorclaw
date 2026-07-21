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
    const targetId = msg.targetAgentId || msg.target_agent_id || "";
    const threadType = String(msg.threadType || msg.thread_type || "");
    const text = String(msg.text || "").trim();

    const resetLoop = senderType === "human";

    // Never respond to other agents' messages (prevents agent↔agent loops).
    if (senderType === "agent") return { action: "skip", reason: "agent-sender", resetLoop };
    // Ignore empty messages.
    if (!text) return { action: "skip", reason: "empty", resetLoop };
    // Direct message addressed to a different agent.
    if (targetId && targetId !== ctx.agentId) return { action: "skip", reason: "other-target", resetLoop };
    // Team chat: only respond when @mentioned by name.
    const isTeamChat = threadType === "team" || (!threadType && !targetId);
    const mentioned = text.includes(`@${ctx.agentName}`);
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

module.exports = { classifyMessage, loopGuardOk, estimateUsageTokens, stripCodexNoise };
