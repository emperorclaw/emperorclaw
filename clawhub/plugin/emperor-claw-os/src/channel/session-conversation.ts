import { EMPEROR_CHANNEL_ID } from "./config.js";

export type EmperorResolvedSessionConversation = {
  rawId: string;
  baseConversationId: string;
  threadId?: string | null;
  parentConversationCandidates: string[];
};

type ParsedConversationParts = {
  baseConversationId: string;
  threadId?: string | null;
};

function parseStructuredConversation(rawId: string): ParsedConversationParts | null {
  const channelPrefix = `${EMPEROR_CHANNEL_ID}:`;
  if (!rawId.startsWith(channelPrefix)) {
    return null;
  }

  const body = rawId.slice(channelPrefix.length);
  const scopedThread = body.match(/^([^:]+):thread:(.+)$/);
  if (scopedThread) {
    return {
      baseConversationId: scopedThread[1],
      threadId: scopedThread[2]
    };
  }

  const directThread = body.match(/^thread:(.+)$/);
  if (directThread) {
    return {
      baseConversationId: "team",
      threadId: directThread[1]
    };
  }

  const chatOnly = body.match(/^chat:(.+)$/);
  if (chatOnly) {
    return {
      baseConversationId: chatOnly[1]
    };
  }

  return {
    baseConversationId: body || "team"
  };
}

export function resolveSessionConversation(rawId: string): EmperorResolvedSessionConversation {
  const normalized = String(rawId || "").trim();
  const parsed = parseStructuredConversation(normalized);
  const baseConversationId = parsed?.baseConversationId || normalized || "team";
  const threadId = parsed?.threadId || null;
  const parentConversationCandidates = threadId
    ? [baseConversationId, "team"].filter((value, index, values) => value && values.indexOf(value) === index)
    : [];

  return {
    rawId: normalized,
    baseConversationId,
    threadId,
    parentConversationCandidates
  };
}
