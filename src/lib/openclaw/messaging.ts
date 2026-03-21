import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { appendThreadMessage, ensureDirectThread, ensureTeamThread } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export async function sendThreadMessageFromMcp(input: {
  companyId: string;
  chatId?: string | null;
  text: string;
  threadId?: string | null;
  fromUserId?: string | null;
  agentId?: string | null;
  targetAgentId?: string | null;
  threadType?: string | null;
}) {
  const senderId = input.fromUserId || input.agentId || "openclaw";
  const resolvedSenderId = await resolveAgentId(input.companyId, senderId);
  const resolvedTargetAgentId = input.targetAgentId
    ? await resolveAgentId(input.companyId, input.targetAgentId)
    : null;

  const defaultThread = resolvedTargetAgentId || input.threadType === "direct"
    ? await ensureDirectThread(input.companyId, resolvedTargetAgentId || resolvedSenderId)
    : await ensureTeamThread(input.companyId);

  let targetThreadId = defaultThread.id;
  let responseThread = defaultThread;

  if (input.threadId && isUuid(input.threadId)) {
    const [existingThread] = await db.select().from(messageThreads).where(and(
      eq(messageThreads.id, input.threadId),
      eq(messageThreads.companyId, input.companyId),
    )).limit(1);

    if (!existingThread) {
      throw new Error("Thread not found");
    }

    targetThreadId = existingThread.id;
    responseThread = existingThread;
  }

  const message = await appendThreadMessage({
    companyId: input.companyId,
    threadId: targetThreadId,
    senderType: "agent",
    senderId: resolvedSenderId,
    targetAgentId: resolvedTargetAgentId,
    text: input.text,
    metadataJson: {
      chatId: input.chatId || null,
      threadType: input.threadType || null,
    },
    mirrorToLegacyChat: !resolvedTargetAgentId,
  });

  await broadcastMcpEvent(input.companyId, { type: "thread_message", thread: responseThread, message });

  return {
    ok: true,
    messageId: message.id,
    threadId: targetThreadId,
  };
}
