import { DEFAULT_THREAD_POLICY } from "../bridge/contract.js";
function normalizePolicy(policy) {
    return {
        direct: policy?.direct || DEFAULT_THREAD_POLICY.direct,
        team: policy?.team || DEFAULT_THREAD_POLICY.team,
        delegation: policy?.delegation || DEFAULT_THREAD_POLICY.delegation
    };
}
function extractExplicitAgentMention(text) {
    const match = text.match(/@([a-z0-9_-]+)/i);
    return match ? match[1] : null;
}
export function resolveTargetAgentHint(message) {
    const metadata = message.metadataJson || {};
    return String(message.targetAgentId
        || metadata.targetAgentId
        || metadata.target_agent_id
        || metadata.target_agent
        || "").trim() || null;
}
export function decideThreadRouting(thread, message, ctx) {
    const text = String(message.text || "").trim();
    if (!text) {
        return { shouldProcess: false, reason: "ignored-empty-text", nextThreadOwnerId: ctx.existingThreadOwnerId || null };
    }
    if (message.senderId && message.senderId === ctx.currentAgentId) {
        return { shouldProcess: false, reason: "ignored-own-message", nextThreadOwnerId: ctx.existingThreadOwnerId || null };
    }
    const policy = normalizePolicy(ctx.policy);
    const targetAgentHint = resolveTargetAgentHint(message);
    const explicitMention = extractExplicitAgentMention(text);
    const mentionsCurrentAgent = explicitMention?.toLowerCase() === ctx.currentAgentName.toLowerCase();
    if (String(thread.type).toLowerCase() === "direct") {
        if (targetAgentHint && targetAgentHint !== ctx.currentAgentId) {
            return {
                shouldProcess: false,
                reason: "direct-owner-mismatch",
                nextThreadOwnerId: targetAgentHint
            };
        }
        const nextThreadOwnerId = targetAgentHint || ctx.existingThreadOwnerId || ctx.currentAgentId;
        if (ctx.existingThreadOwnerId && ctx.existingThreadOwnerId !== ctx.currentAgentId && !targetAgentHint) {
            return {
                shouldProcess: false,
                reason: "direct-owner-mismatch",
                nextThreadOwnerId: ctx.existingThreadOwnerId
            };
        }
        return {
            shouldProcess: true,
            reason: targetAgentHint ? "direct-target-match" : "direct-bound",
            nextThreadOwnerId: policy.direct === "bound" ? nextThreadOwnerId : null
        };
    }
    if (policy.team === "mention-required" && !mentionsCurrentAgent) {
        return {
            shouldProcess: false,
            reason: "team-no-explicit-mention",
            nextThreadOwnerId: ctx.existingThreadOwnerId || null
        };
    }
    return {
        shouldProcess: true,
        reason: "team-explicit-mention",
        nextThreadOwnerId: ctx.existingThreadOwnerId || null
    };
}
