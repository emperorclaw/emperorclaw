import { DEFAULT_THREAD_POLICY } from "../bridge/contract.js";
function normalizePolicy(policy) {
    return {
        direct: policy?.direct || DEFAULT_THREAD_POLICY.direct,
        team: policy?.team || DEFAULT_THREAD_POLICY.team,
        delegation: policy?.delegation || DEFAULT_THREAD_POLICY.delegation
    };
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
        if (!raw)
            continue;
        refs.push(raw);
        refs.push(raw.split(/\s+/)[0]);
    }
    return refs;
}
function mentionsAgentName(text, agentName) {
    const mentionKeys = new Set(extractMentionRefs(text).map(normalizeAgentMention));
    return agentNameAliases(agentName).some((alias) => mentionKeys.has(normalizeAgentMention(alias)));
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
    const mentionsCurrentAgent = mentionsAgentName(text, ctx.currentAgentName);
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
