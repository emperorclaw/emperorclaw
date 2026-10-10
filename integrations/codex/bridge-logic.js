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

module.exports = { classifyMessage, loopGuardOk, estimateUsageTokens, stripCodexNoise, replyFormatGuide };
