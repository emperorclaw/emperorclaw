import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { appendThreadMessage, currentAgentStreak, ensureDirectThread, ensureTeamThread } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { ensureAgentPairThread, GROUP_THREAD_TYPE, isAgentGroupMember, isAgentPairThread, pairThreadCounterpart } from "@/lib/groups";
import { agentLoopHardCap, agentPairLoopHardCap } from "@/lib/message-routing";

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
  // The message this one answers (runtimes send it); lets a request find its reply.
  replyToMessageId?: string | null;
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

  // An agent messaging another agent goes to a dedicated two-way pair thread
  // (both are participants), not into the target's human↔agent direct thread —
  // otherwise the target's reply would stay out of the sender's reach and the
  // handoff would pollute a human DM session.
  const isAgentToAgent = Boolean(resolvedSenderId && resolvedTargetAgentId && resolvedSenderId !== resolvedTargetAgentId && !input.fromUserId);

  const defaultThread = isAgentToAgent
    ? await ensureAgentPairThread(input.companyId, resolvedSenderId!, resolvedTargetAgentId!)
    : resolvedTargetAgentId || input.threadType === "direct"
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
  const isAgentPair = isGroup && isAgentPairThread(responseThread);

  // In a pair thread the counterpart is addressed without a targetAgentId, but
  // old runtimes only understand `targeted`. Infer the other agent so they
  // still route the reply, without letting a caller forge a target elsewhere.
  const effectiveTargetAgentId = isAgentPair && !resolvedTargetAgentId && resolvedSenderId
    ? await pairThreadCounterpart(input.companyId, responseThread.id, resolvedSenderId)
    : resolvedTargetAgentId;

  // Hard backstop for runtimes that ignore the routing verdict: past this many
  // agent messages in a row in a shared thread, agent posts are refused until
  // a person writes. Compliant runtimes stop well before (routeReason "loop_paused").
  const hardCap = isAgentPair ? agentPairLoopHardCap() : agentLoopHardCap();
  if (responseThread.type !== "direct" && (await currentAgentStreak(input.companyId, responseThread.id)) >= hardCap) {
    throw new Error("Loop guard: too many agent messages in a row in this thread; retry after five minutes of inactivity or ask a person to write");
  }

  const message = await appendThreadMessage({
    companyId: input.companyId,
    threadId: targetThreadId,
    senderType: "agent",
    senderId: resolvedSenderId,
    // A group message is addressed by @mention, never to one agent — EXCEPT a
    // pair thread, which is a two-agent handoff: keep targetAgentId set there so
    // runtimes that only understand `targeted` still route it to the counterpart.
    targetAgentId: isGroup && !isAgentPair ? null : effectiveTargetAgentId,
    text: input.text,
    metadataJson: {
      chatId: input.chatId || null,
      threadType: isGroup ? GROUP_THREAD_TYPE : input.threadType || null,
      ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
    },
    mirrorToLegacyChat: !effectiveTargetAgentId && !isGroup,
  });

  await broadcastMcpEvent(input.companyId, { type: "thread_message", thread: responseThread, message });

  return {
    ok: true,
    messageId: message.id,
    threadId: targetThreadId,
  };
}
