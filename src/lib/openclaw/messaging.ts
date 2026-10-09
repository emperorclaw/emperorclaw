import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { appendThreadMessage, currentAgentStreak, ensureDirectThread, ensureTeamThread } from "@/lib/control-plane";
import { resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { ensureAgentPairThread, GROUP_THREAD_TYPE, isAgentGroupMember, isAgentPairThread, pairThreadCounterpart } from "@/lib/groups";
import { agentLoopHardCap, agentPairLoopHardCap, mentionedAgentIds } from "@/lib/message-routing";

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** The thread a message belongs to, company-scoped. Null when unknown. */
async function sourceThreadId(companyId: string, messageId: string): Promise<string | null> {
  if (!isUuid(messageId)) return null;
  const [source] = await db.select({ threadId: threadMessages.threadId }).from(threadMessages).where(and(
    eq(threadMessages.id, messageId),
    eq(threadMessages.companyId, companyId),
  )).limit(1);
  return source?.threadId ?? null;
}

/**
 * Shared group chats (work teams) that BOTH agents belong to, excluding private
 * pair threads and archived groups. Used for team-first peer messaging.
 */
async function commonTeamThreads(companyId: string, agentA: string, agentB: string) {
  const rows = await db.select({
    id: messageThreads.id,
    description: messageThreads.description,
    createdByType: messageThreads.createdByType,
  }).from(messageThreads)
    .innerJoin(threadParticipants, and(
      eq(threadParticipants.threadId, messageThreads.id),
      eq(threadParticipants.companyId, companyId),
      eq(threadParticipants.participantType, "agent"),
      inArray(threadParticipants.participantId, [agentA, agentB]),
    ))
    .where(and(
      eq(messageThreads.companyId, companyId),
      eq(messageThreads.type, GROUP_THREAD_TYPE),
      isNull(messageThreads.archivedAt),
    ))
    .groupBy(messageThreads.id, messageThreads.description, messageThreads.createdByType)
    // Exactly the two agents (both deduped) belong to the thread.
    .having(sql`count(distinct ${threadParticipants.participantId}) = 2`);
  return rows.filter((row) => !isAgentPairThread(row));
}

/**
 * Pick the shared work-team chat for an agent→agent send that named a recipient
 * but no thread. Prefers the unique common team; when several are shared, only a
 * uniquely identified organization work team is used, otherwise the caller must
 * choose (or go private) — an arbitrary team is never picked.
 */
async function pickSharedTeamThread(companyId: string, agentA: string, agentB: string): Promise<string | null> {
  const common = await commonTeamThreads(companyId, agentA, agentB);
  if (common.length === 0) return null;
  if (common.length === 1) return common[0].id;
  const [company] = await db.select({ organizationJson: companies.organizationJson })
    .from(companies).where(eq(companies.id, companyId)).limit(1);
  const orgTeamIds = new Set<string>(company?.organizationJson?.teamIds ?? []);
  const orgCommon = common.filter((thread) => orgTeamIds.has(thread.id));
  if (orgCommon.length === 1) return orgCommon[0].id;
  throw new Error("This agent shares more than one team chat with the recipient; pass threadId to choose one, or private: true");
}

/** Ensure the recipient is @mentioned so only they are woken in a shared room. */
async function ensureTargetMention(companyId: string, text: string, targetAgentId: string): Promise<string> {
  const [agent] = await db.select({ id: agents.id, name: agents.name }).from(agents).where(and(
    eq(agents.id, targetAgentId),
    eq(agents.companyId, companyId),
  )).limit(1);
  if (!agent?.name) return text;
  if (mentionedAgentIds(text, [{ id: agent.id, name: agent.name }]).has(agent.id)) return text;
  return `@${agent.name} ${text}`;
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
  // Explicit opt-out of team-first peer messaging: force the private pair thread.
  private?: boolean;
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

  // Carry explicit thread context: a reply is anchored to the thread of the
  // message it answers. Without this, a runtime that omits (or loses) the
  // thread id falls through to a default thread — which for an agent is its
  // own operator DM. Deriving the thread from `replyToMessageId` keeps a
  // two-agent handoff inside its pair thread across every subsequent turn.
  const explicitThreadId = input.threadId && isUuid(input.threadId)
    ? input.threadId
    : input.replyToMessageId
      ? await sourceThreadId(input.companyId, input.replyToMessageId)
      : null;

  let responseThread: typeof messageThreads.$inferSelect;
  if (explicitThreadId) {
    const [existingThread] = await db.select().from(messageThreads).where(and(
      eq(messageThreads.id, explicitThreadId),
      eq(messageThreads.companyId, input.companyId),
    )).limit(1);

    if (!existingThread) {
      throw new Error("Thread not found");
    }

    responseThread = existingThread;

    // Only members talk in a group: an outside agent would never see the
    // replies, and the members never asked for it.
    if (existingThread.type === GROUP_THREAD_TYPE) {
      if (existingThread.archivedAt) throw new Error("Access denied: that group is archived");
      if (resolvedSenderId && !(await isAgentGroupMember(input.companyId, existingThread.id, resolvedSenderId))) {
        throw new Error("Access denied: this agent is not a member of that group");
      }
      // A peer message names a recipient who must also belong to the group,
      // otherwise the handoff would be invisible to them (or leak to a
      // non-member). Never address someone who is not in the room.
      if (resolvedTargetAgentId && !(await isAgentGroupMember(input.companyId, existingThread.id, resolvedTargetAgentId))) {
        throw new Error("Access denied: the recipient is not a member of that group");
      }
    }
  } else if (isAgentToAgent && !input.private) {
    // Team-first: an agent messaging a peer it shares a work team with posts in
    // the team chat (mentioning the recipient) instead of opening a private pair.
    // With no uniquely safe team, it retains the private pair fallback.
    const teamId = await pickSharedTeamThread(input.companyId, resolvedSenderId!, resolvedTargetAgentId!);
    if (teamId) {
      const [team] = await db.select().from(messageThreads).where(and(
        eq(messageThreads.id, teamId),
        eq(messageThreads.companyId, input.companyId),
      )).limit(1);
      if (!team) throw new Error("Thread not found");
      responseThread = team;
    } else {
      responseThread = await ensureAgentPairThread(input.companyId, resolvedSenderId!, resolvedTargetAgentId!);
    }
  } else if (isAgentToAgent) {
    // Explicit private request (or team-first unavailable): the two-agent pair.
    responseThread = await ensureAgentPairThread(input.companyId, resolvedSenderId!, resolvedTargetAgentId!);
  } else if (resolvedTargetAgentId) {
    responseThread = await ensureDirectThread(input.companyId, resolvedTargetAgentId);
  } else if (input.threadType === "direct") {
    // Refuse to guess: silently defaulting an agent's direct reply to its own
    // thread is exactly the operator-DM leak. Callers must name the thread or
    // the peer, or answer a specific message (replyToMessageId).
    throw new Error("A direct message needs a targetAgentId or threadId");
  } else {
    responseThread = await ensureTeamThread(input.companyId);
  }

  const targetThreadId = responseThread.id;
  const isGroup = responseThread.type === GROUP_THREAD_TYPE;
  const isAgentPair = isGroup && isAgentPairThread(responseThread);

  // In a shared team, address the recipient by name so the routing verdict is
  // "mention" for them and "not_addressed" for everyone else in the room.
  let outboundText = input.text;
  if (isGroup && !isAgentPair && isAgentToAgent && resolvedTargetAgentId) {
    outboundText = await ensureTargetMention(input.companyId, outboundText, resolvedTargetAgentId);
  }

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
    text: outboundText,
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
