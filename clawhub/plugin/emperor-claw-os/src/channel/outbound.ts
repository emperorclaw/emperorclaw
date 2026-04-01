import type { EmperorResolvedChannelAccount } from "./config.js";
import { resolveSessionConversation } from "./session-conversation.js";

export type EmperorOutboundTextRequest = {
  account: EmperorResolvedChannelAccount;
  to: string;
  text: string;
  threadId?: string | null;
  threadType?: string | null;
  targetAgentId?: string | null;
};

export type EmperorOutboundTextResult = {
  ok: boolean;
  messageId?: string | null;
  threadId?: string | null;
};

function normalizeThreadType(input: {
  targetAgentId?: string | null;
  threadType?: string | null;
  threadId?: string | null;
}): "team" | "direct" {
  const explicit = String(input.threadType || "").trim().toLowerCase();
  if (explicit === "direct") return "direct";
  if (explicit === "team") return "team";
  return input.targetAgentId || input.threadId ? "direct" : "team";
}

export function buildEmperorSendPayload(input: EmperorOutboundTextRequest): {
  url: string;
  init: RequestInit;
} {
  const conversation = resolveSessionConversation(input.to);
  const threadId = input.threadId ?? conversation.threadId ?? null;
  const chatId = conversation.baseConversationId || input.account.defaultChatId;
  const threadType = normalizeThreadType({
    targetAgentId: input.targetAgentId,
    threadType: input.threadType,
    threadId
  });

  return {
    url: `${input.account.apiUrl}/api/mcp/messages/send`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.account.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        chat_id: chatId,
        text: input.text,
        thread_id: threadId,
        thread_type: threadType,
        targetAgentId: input.targetAgentId || null,
        agentId: input.account.senderAgentId || null
      })
    }
  };
}

export async function sendEmperorOutboundText(input: EmperorOutboundTextRequest): Promise<EmperorOutboundTextResult> {
  const request = buildEmperorSendPayload(input);
  const response = await fetch(request.url, request.init);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`emperor outbound send failed: ${response.status} ${text}`);
  }

  const payload = await response.json() as Record<string, unknown>;
  return {
    ok: Boolean(payload.ok),
    messageId: typeof payload.message_id === "string" ? payload.message_id : null,
    threadId: typeof payload.thread_id === "string" ? payload.thread_id : null
  };
}
