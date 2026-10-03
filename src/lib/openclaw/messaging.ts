import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { appendThreadMessage, currentAgentStreak, ensureDirectThread, ensureTeamThread } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { GROUP_THREAD_TYPE, isAgentGroupMember } from "@/lib/groups";
import { agentLoopHardCap } from "@/lib/message-routing";

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
  const senderId = input.fromUserId || input.agentId || null;
  const resolvedSenderId = senderId
    ? await resolveAgentId(input.companyId, senderId)
    : null;
  const resolvedTargetAgentId = input.targetAgentId
    ? await resolveAgentId(input.companyId, input.targetAgentId)
    : null;

  if (input.threadType === "direct" && !resolvedTargetAgentId && !resolvedSenderId) {
    throw new Error("Direct messages require targetAgentId or agentId");
  }

  const defaultThread = resolvedTargetAgentId || input.threadType === "direct"
    ? await ensureDirectThread(input.companyId, resolvedTargetAgentId || resolvedSenderId!)
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

    // Only members talk in a group: an outside agent would never see the
    // replies, and the members never asked for it.
    if (existingThread.type === GROUP_THREAD_TYPE) {
      if (existingThread.archivedAt) throw new Error("Access denied: that group is archived");
      if (resolvedSenderId && !(await isAgentGroupMember(input.companyId, existingThread.id, resolvedSenderId))) {
        throw new Error("Access denied: this agent is not a member of that group");
      }
    }
  }
  const isGroup = responseThread.type === GROUP_THREAD_TYPE;

  // Hard backstop for runtimes that ignore the routing verdict: past this many
  // agent messages in a row in a shared thread, agent posts are refused until
  // a person writes. Compliant runtimes stop well before (routeReason "loop_guard").
  if (responseThread.type !== "direct" && (await currentAgentStreak(input.companyId, responseThread.id)) >= agentLoopHardCap()) {
    throw new Error("Loop guard: too many agent messages in a row in this thread; a person must write before agents can post again");
  }

  const message = await appendThreadMessage({
    companyId: input.companyId,
    threadId: targetThreadId,
    senderType: "agent",
    senderId: resolvedSenderId,
    // A group message is addressed by @mention, never to one agent.
    targetAgentId: isGroup ? null : resolvedTargetAgentId,
    text: input.text,
    metadataJson: {
      chatId: input.chatId || null,
      threadType: isGroup ? GROUP_THREAD_TYPE : input.threadType || null,
    },
    mirrorToLegacyChat: !resolvedTargetAgentId && !isGroup,
  });

  await broadcastMcpEvent(input.companyId, { type: "thread_message", thread: responseThread, message });

  return {
    ok: true,
    messageId: message.id,
    threadId: targetThreadId,
  };
}
