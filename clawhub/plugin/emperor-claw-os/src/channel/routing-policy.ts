import type { EmperorThreadPolicy } from "../bridge/contract.js";
import { DEFAULT_THREAD_POLICY } from "../bridge/contract.js";

export type EmperorChannelThread = {
  id: string;
  type: "direct" | "team" | "project" | string;
};

export type EmperorChannelMessage = {
  senderId?: string | null;
  senderType?: "human" | "agent" | "system" | string | null;
  text?: string | null;
  targetAgentId?: string | null;
  metadataJson?: Record<string, unknown> | null;
};

export type EmperorRoutingContext = {
  currentAgentId: string;
  currentAgentName: string;
  profile: "operator" | "manager";
  existingThreadOwnerId?: string | null;
  policy?: Partial<EmperorThreadPolicy> | null;
};

export type EmperorRoutingDecision = {
  shouldProcess: boolean;
  reason:
    | "direct-bound"
    | "direct-target-match"
    | "direct-owner-mismatch"
    | "team-explicit-mention"
    | "team-no-explicit-mention"
    | "ignored-own-message"
    | "ignored-empty-text";
  nextThreadOwnerId?: string | null;
};

function normalizePolicy(policy?: Partial<EmperorThreadPolicy> | null): EmperorThreadPolicy {
  return {
    direct: policy?.direct || DEFAULT_THREAD_POLICY.direct,
    team: policy?.team || DEFAULT_THREAD_POLICY.team,
    delegation: policy?.delegation || DEFAULT_THREAD_POLICY.delegation
  };
}

function normalizeAgentMention(value: string): string {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function agentNameAliases(name: string): string[] {
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

function extractMentionRefs(text: string): string[] {
  const refs: string[] = [];
  const pattern = /@([^\s,.;:!?]+(?:\s+[^\s,.;:!?]+)?)/g;
  for (const match of String(text || "").matchAll(pattern)) {
    const raw = String(match[1] || "").trim();
    if (!raw) continue;
    refs.push(raw);
    refs.push(raw.split(/\s+/)[0]);
  }
  return refs;
}

function mentionsAgentName(text: string, agentName: string): boolean {
  const mentionKeys = new Set(extractMentionRefs(text).map(normalizeAgentMention));
  return agentNameAliases(agentName).some((alias) => mentionKeys.has(normalizeAgentMention(alias)));
}

export function resolveTargetAgentHint(message: EmperorChannelMessage): string | null {
  const metadata = message.metadataJson || {};
  return String(
    message.targetAgentId
      || metadata.targetAgentId
      || metadata.target_agent_id
      || metadata.target_agent
      || ""
  ).trim() || null;
}

export function decideThreadRouting(
  thread: EmperorChannelThread,
  message: EmperorChannelMessage,
  ctx: EmperorRoutingContext
): EmperorRoutingDecision {
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
