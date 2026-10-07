import { db } from "@/db";
import {
    agentMemoryEntries,
    agentMemorySnapshots,
    agentSessions,
    agents,
    artifacts,
    chatMessages,
    companies,
    companyMembers,
    credentialAccessLogs,
    integrationSecretVersions,
    messageThreads,
    runtimeNodes,
    taskEvents,
    tasks,
    threadMessageReasoning,
    threadMessages,
    threadParticipants,
    users,
} from "@/db/schema";
import { and, desc, eq, gte, inArray, isNull, lt, ne, notInArray, or, sql } from "drizzle-orm";
import { nextCheckinDeadline } from "./lifecycle";
import { normalizeExecutionState, type ExecutionState } from "./project-workflow";
import { truncateReasoningForStorage } from "./reasoning-history";
import { agentStreakState, agentLoopMaxTurnsFor, AGENT_LOOP_COOLDOWN_MS, isLoopGuardResume, noteProgressResets, type AgentStreakState } from "./message-routing";
import { notifyAgentMessage, notify, companyAdminIds } from "./notifications";
import { isAgentPairThread } from "./groups";

type SenderType = "human" | "agent" | "system";

/** Compact reference to a file attached to a message (stored in metadataJson). */
export type ThreadMessageAttachment = {
    id: string;
    name: string;
    contentType: string;
    sizeBytes: number;
};

const USER_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolves a human sender's display identity for inclusion in message
 * metadata. Only succeeds when senderId is a users.id that belongs to the
 * company — external platform sender ids (e.g. webhook from_user_id) and
 * cross-company ids resolve to null, so the agent falls back to a generic
 * label. Never throws.
 */
async function resolveHumanSender(companyId: string, senderId: string): Promise<{
    senderName: string;
    senderEmail: string | null;
    senderRole: string | null;
} | null> {
    if (!USER_ID_UUID_RE.test(senderId)) return null;
    try {
        const [user] = await db.select({
            name: users.displayName,
            email: users.email,
            role: users.roleTitle,
        }).from(users)
            .innerJoin(companyMembers, eq(companyMembers.userId, users.id))
            .where(and(
                eq(users.id, senderId),
                eq(companyMembers.companyId, companyId),
            ))
            .limit(1);
        if (!user) return null;
        return {
            senderName: user.name || user.email?.split("@")[0] || "User",
            senderEmail: user.email || null,
            senderRole: user.role || null,
        };
    } catch {
        return null;
    }
}

/**
 * Shared-channel membership: every company member gets their own
 * threadParticipants row on a thread, so read state (lastReadAt) and unread
 * counts are per-user even though the conversation itself is shared. Idempotent
 * — only missing members are inserted, and they start "caught up" (lastReadAt =
 * now) so joining a channel does not surface every historical message as unread.
 */
export async function ensureThreadHumanParticipants(companyId: string, threadId: string) {
    const members = await db.select({ userId: companyMembers.userId })
        .from(companyMembers)
        .where(eq(companyMembers.companyId, companyId));
    if (members.length === 0) return;

    const existing = await db.select({ ref: threadParticipants.participantRef })
        .from(threadParticipants)
        .where(and(
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.participantType, "human"),
        ));
    const have = new Set(existing.map((row) => row.ref));

    const missing = members
        .filter((member) => !have.has(member.userId))
        .map((member) => ({
            threadId,
            companyId,
            participantType: "human" as const,
            participantRef: member.userId,
            role: "member" as const,
            // DB now() so it's directly comparable to thread_messages.created_at
            // (also DB now()); a JS Date can skew read state on non-UTC servers.
            lastReadAt: sql`now()`,
        }));
    if (missing.length > 0) {
        await db.insert(threadParticipants).values(missing).onConflictDoNothing();
    }
}

export async function ensureTeamThread(companyId: string) {
    const [existing] = await db.select().from(messageThreads).where(
        and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, "team"),
            isNull(messageThreads.archivedAt)
        )
    ).orderBy(messageThreads.createdAt).limit(1);

    if (existing) {
        await ensureThreadHumanParticipants(companyId, existing.id);
        return existing;
    }

    let created: typeof messageThreads.$inferSelect;
    try {
        [created] = await db.insert(messageThreads).values({
            companyId,
            type: "team",
            title: "Agent Team Chat",
            createdByType: "system",
        }).returning();
    } catch (error) {
        // A partial unique index enforces one team thread per company. If a
        // concurrent caller won the race, adopt its thread instead of 500ing.
        if (!isUniqueViolation(error)) throw error;
        const [winner] = await db.select().from(messageThreads).where(
            and(
                eq(messageThreads.companyId, companyId),
                eq(messageThreads.type, "team"),
                isNull(messageThreads.archivedAt)
            )
        ).orderBy(messageThreads.createdAt).limit(1);
        if (!winner) throw error;
        created = winner;
    }

    await ensureThreadHumanParticipants(companyId, created.id);
    return created;
}

function isUniqueViolation(error: unknown): boolean {
    return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

/**
 * The shared channel for one agent: exactly one "direct" thread per
 * (company, agent), visible to the whole company. Every member is a participant
 * (for per-user read state); the agent is a participant. `userId` is accepted
 * for backward compatibility but no longer affects thread identity — it is NOT
 * used to fork per-user threads, and no participant ref is ever overwritten.
 */
export async function ensureDirectThread(companyId: string, agentId: string, _userId?: string | null) {
    // Serialize creation per (company, agent) with a transaction-scoped advisory
    // lock. Without it, two concurrent callers both see "no thread yet" and each
    // insert one, permanently splitting the agent's DM history across duplicate
    // threads (a message written to the loser thread becomes unreachable).
    const thread = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`direct-thread:${companyId}:${agentId}`}))`);

        const [agentParticipant] = await tx.select({ threadId: threadParticipants.threadId })
            .from(threadParticipants)
            .innerJoin(messageThreads, and(
                eq(messageThreads.id, threadParticipants.threadId),
                eq(messageThreads.companyId, companyId),
                eq(messageThreads.type, "direct"),
                isNull(messageThreads.archivedAt),
            ))
            .where(and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                eq(threadParticipants.participantId, agentId),
            ))
            .orderBy(messageThreads.createdAt)
            .limit(1);

        if (agentParticipant) {
            const [existing] = await tx.select().from(messageThreads)
                .where(eq(messageThreads.id, agentParticipant.threadId)).limit(1);
            if (existing) return existing;
        }

        // None yet — create the agent's shared channel.
        const [created] = await tx.insert(messageThreads).values({
            companyId,
            type: "direct",
            title: "Direct Agent Thread",
            createdByType: "system",
        }).returning();

        await tx.insert(threadParticipants).values({
            threadId: created.id,
            companyId,
            participantType: "agent",
            participantId: agentId,
            role: "member",
        });

        return created;
    });

    await ensureThreadHumanParticipants(companyId, thread.id);
    return thread;
}

/**
 * Marks a thread read for a human user. Direct threads always have a human
 * `threadParticipants` row (created by ensureDirectThread), but the shared
 * team thread does not — ensureTeamThread only creates the thread itself, so
 * a blind UPDATE against threadParticipants would silently affect 0 rows.
 * This finds-or-creates the participant row first.
 */
export async function markThreadRead(companyId: string, threadId: string, userId: string) {
    const [existing] = await db.select({ id: threadParticipants.id })
        .from(threadParticipants)
        .where(and(
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.participantType, "human"),
            eq(threadParticipants.participantRef, userId),
        ))
        .limit(1);

    if (existing) {
        await db.update(threadParticipants).set({ lastReadAt: sql`now()` }).where(eq(threadParticipants.id, existing.id));
    } else {
        // Only threads of this company. Opening a group records a read cursor
        // but doesn't make you a member: that happens when you post or are added.
        const [thread] = await db.select({ type: messageThreads.type, description: messageThreads.description, createdByType: messageThreads.createdByType }).from(messageThreads)
            .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId)))
            .limit(1);
        if (!thread) return;
        // A pair thread is a private two-agent handoff: a human opening it must
        // not gain a reader row (which would look like a third participant).
        if (thread.type === "group" && isAgentPairThread(thread)) return;
        await db.insert(threadParticipants).values({
            threadId,
            companyId,
            participantType: "human",
            participantRef: userId,
            role: thread.type === "group" ? "reader" : "member",
            lastReadAt: sql`now()`,
        }).onConflictDoNothing();
    }
}

/**
 * Applies a status update (typing/read) for an agent participant. Same
 * find-or-create need as markThreadRead: agents only get a threadParticipants
 * row for direct threads via ensureDirectThread — the shared team thread
 * never creates one, so a blind UPDATE from the team channel would silently
 * affect 0 rows and agent typing indicators would never appear there.
 */
export async function updateAgentThreadParticipant(
    companyId: string,
    threadId: string,
    agentId: string,
    updates: { lastReadAt?: Date; typingUntil?: Date | null; currentActivity?: string | null },
) {
    const [existing] = await db.select({ id: threadParticipants.id })
        .from(threadParticipants)
        .where(and(
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.participantType, "agent"),
            eq(threadParticipants.participantId, agentId),
        ))
        .limit(1);

    if (existing) {
        await db.update(threadParticipants).set(updates).where(eq(threadParticipants.id, existing.id));
    } else {
        await db.insert(threadParticipants).values({
            threadId,
            companyId,
            participantType: "agent",
            participantId: agentId,
            role: "member",
            ...updates,
        });
    }
}

/**
 * Persist the reasoning transcript for one agent message.
 *
 * Tenancy is enforced here, not by the caller: the message must exist inside
 * `companyId`, and it must be an agent message authored by `agentId`. Without
 * that second check a runtime token could staple arbitrary text onto a human's
 * message, or onto another agent's reply, inside its own company.
 *
 * Returns false when the target is not a message this agent may annotate.
 */
export async function saveThreadMessageReasoning(input: {
    companyId: string;
    messageId: string;
    agentId: string;
    reasoning: string;
}): Promise<boolean> {
    const reasoning = truncateReasoningForStorage(input.reasoning);
    if (!reasoning) return false;

    const [message] = await db.select({
        id: threadMessages.id,
        senderType: threadMessages.senderType,
        senderId: threadMessages.senderId,
    })
        .from(threadMessages)
        .where(and(
            eq(threadMessages.id, input.messageId),
            eq(threadMessages.companyId, input.companyId),
        ))
        .limit(1);

    if (!message) return false;
    if (message.senderType !== "agent" || message.senderId !== input.agentId) return false;

    // One row per message. A retried write (the bridge posts once per turn, but
    // a network retry can duplicate that post) must replace the transcript
    // rather than fail or accumulate.
    await db.insert(threadMessageReasoning)
        .values({ messageId: input.messageId, companyId: input.companyId, reasoning })
        .onConflictDoUpdate({
            target: threadMessageReasoning.messageId,
            set: { reasoning, createdAt: new Date() },
        });

    // Mark the message so the UI knows a transcript exists WITHOUT fetching it.
    // `metadata_json` already travels with every message in the list payload, so
    // a boolean there costs nothing, while rendering a "Show reasoning" control
    // on every agent message would give most readers a button that resolves to
    // "nothing recorded" — history is off by default. Merged with jsonb `||`
    // rather than read-modify-write so a concurrent metadata update (attachments,
    // delivery state) cannot be clobbered.
    await db.update(threadMessages)
        .set({ metadataJson: sql`coalesce(${threadMessages.metadataJson}, '{}'::jsonb) || '{"hasReasoning":true}'::jsonb` })
        .where(and(
            eq(threadMessages.id, input.messageId),
            eq(threadMessages.companyId, input.companyId),
        ));
    return true;
}

/**
 * Read one message's reasoning transcript, or null when there is none.
 *
 * Company-scoped by joining through the message, so a reasoning id alone is
 * never enough to read across tenants. Called only from the on-demand UI route
 * — never from the message-list query, whose payload must stay small.
 */
export async function getThreadMessageReasoning(companyId: string, messageId: string) {
    const [row] = await db.select({
        messageId: threadMessageReasoning.messageId,
        reasoning: threadMessageReasoning.reasoning,
        createdAt: threadMessageReasoning.createdAt,
    })
        .from(threadMessageReasoning)
        .innerJoin(threadMessages, eq(threadMessages.id, threadMessageReasoning.messageId))
        .where(and(
            eq(threadMessageReasoning.messageId, messageId),
            eq(threadMessageReasoning.companyId, companyId),
            eq(threadMessages.companyId, companyId),
        ))
        .limit(1);
    return row ?? null;
}

/** Task events that are never progress (they neither state nor assign work). */
const NOTE_EVENT_TYPES = ["task_note", "task_handoff"] as const;
const NON_PROGRESS_EVENT_TYPES = ["stall_nudge", "stall_escalation", "task_note", "task_handoff"] as const;

export type ThreadProgressTimestamps = {
    /** Task state/assignee changes, task creation, and delivered artifacts. */
    core: Date[];
    /** Task notes eligible to reset the streak (task linked to the thread, or its assignee is a thread agent). */
    notes: Date[];
};

/**
 * The agent actors whose progress counts for a thread. Team threads have no
 * agent participant rows (agents only get a row for their direct thread), so
 * their actor set is derived from the thread's recent agent senders, falling
 * back to all company agents. Other thread types use participant rows.
 */
async function threadAgentActorIds(companyId: string, threadId: string, threadType: string): Promise<string[]> {
    if (threadType === "team") {
        const recent = await db.select({ senderId: threadMessages.senderId })
            .from(threadMessages)
            .where(and(
                eq(threadMessages.companyId, companyId),
                eq(threadMessages.threadId, threadId),
                eq(threadMessages.senderType, "agent"),
            ))
            .orderBy(desc(threadMessages.createdAt))
            .limit(50);
        const ids = [...new Set(recent.map((r) => r.senderId).filter((id): id is string => Boolean(id)))];
        if (ids.length > 0) return ids;
        const all = await db.select({ id: agents.id }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
        return all.map((a) => a.id);
    }
    const participants = await db.select({ participantId: threadParticipants.participantId })
        .from(threadParticipants)
        .where(and(
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.threadId, threadId),
            eq(threadParticipants.participantType, "agent"),
        ));
    return participants.map((p) => p.participantId).filter((id): id is string => Boolean(id));
}

async function fetchThreadProgress(companyId: string, threadId: string, threadType: string, since: Date): Promise<ThreadProgressTimestamps> {
    const actorIds = await threadAgentActorIds(companyId, threadId, threadType);
    if (actorIds.length === 0) return { core: [], notes: [] };

    const [thread] = await db.select({ taskId: messageThreads.taskId }).from(messageThreads)
        .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))).limit(1);
    const threadTaskId = thread?.taskId ?? null;

    const [coreEvents, noteEvents, artifactRows] = await Promise.all([
        db.select({ at: taskEvents.createdAt })
            .from(taskEvents)
            .where(and(
                eq(taskEvents.companyId, companyId),
                gte(taskEvents.createdAt, since),
                notInArray(taskEvents.eventType, [...NON_PROGRESS_EVENT_TYPES]),
                inArray(taskEvents.actorId, actorIds),
            )),
        db.select({ at: taskEvents.createdAt })
            .from(taskEvents)
            .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
            .where(and(
                eq(taskEvents.companyId, companyId),
                gte(taskEvents.createdAt, since),
                inArray(taskEvents.eventType, [...NOTE_EVENT_TYPES]),
                inArray(taskEvents.actorId, actorIds),
                or(
                    threadTaskId ? eq(tasks.id, threadTaskId) : undefined,
                    inArray(tasks.assignedAgentId, actorIds),
                ),
            )),
        db.select({ at: artifacts.createdAt })
            .from(artifacts)
            .where(and(
                eq(artifacts.companyId, companyId),
                gte(artifacts.createdAt, since),
                eq(artifacts.createdByType, "agent"),
                inArray(artifacts.createdById, actorIds),
            )),
    ]);

    return {
        core: [
            ...coreEvents.map((r) => r.at),
            ...artifactRows.map((r) => r.at),
        ],
        notes: noteEvents.map((r) => r.at),
    };
}

// A short per-thread cache: the progress lookup runs on every agent message
// post and every sync cycle, so a few seconds of reuse avoids a UNION/join on
// every single message. Bounded so it never grows without limit.
const PROGRESS_CACHE_TTL_MS = 3_000;
const PROGRESS_CACHE_MAX_ENTRIES = 1_000;
const progressCache = new Map<string, { at: number; windowStart: number; core: Date[]; notes: Date[] }>();

/**
 * Progress since `since` for a thread, split into core (state/assignee changes,
 * task creation, artifacts) and notes (task notes). Notes are returned raw here
 * — the caller enforces the "at most one note reset per N messages" cap because
 * that needs the message timeline.
 */
export async function progressTimestampsForThread(companyId: string, threadId: string, since: Date): Promise<ThreadProgressTimestamps> {
    try {
        const [threadType] = await db.select({ type: messageThreads.type }).from(messageThreads)
            .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))).limit(1)
            .then((rows) => rows.map((r) => r.type));
        if (!threadType) return { core: [], notes: [] };

        const key = `${companyId}:${threadId}`;
        const now = Date.now();
        const cached = progressCache.get(key);
        if (cached && now - cached.at < PROGRESS_CACHE_TTL_MS && cached.windowStart <= since.getTime()) {
            return {
                core: cached.core.filter((d) => d.getTime() >= since.getTime()),
                notes: cached.notes.filter((d) => d.getTime() >= since.getTime()),
            };
        }

        const result = await fetchThreadProgress(companyId, threadId, threadType, since);
        if (progressCache.size >= PROGRESS_CACHE_MAX_ENTRIES) progressCache.clear();
        progressCache.set(key, { at: now, windowStart: since.getTime(), ...result });
        return result;
    } catch (error) {
        console.warn("[loop-guard] progress lookup failed:", error instanceof Error ? error.message : error);
        return { core: [], notes: [] };
    }
}

/**
 * Consecutive agent-authored messages at the end of a thread with no progress
 * (0 when the last counted message is a human's, a resume marker, or after a
 * task state change / note / artifact). System notices neither count nor reset.
 */
export async function currentAgentStreak(companyId: string, threadId: string, window = 100): Promise<number> {
    return (await currentAgentStreakState(companyId, threadId, window)).streak;
}

/**
 * The current streak and the moment it last reset, for a thread. The reset
 * time is the point the current streak started counting from: a human message,
 * a resume marker, a progress event, or a cooldown gap. It is what lets the
 * loop-guard notice be posted exactly once per pause rather than once per
 * resume marker.
 */
export async function currentAgentStreakState(companyId: string, threadId: string, window = 100): Promise<AgentStreakState> {
    const tail = await db.select({ id: threadMessages.id, senderType: threadMessages.senderType, createdAt: threadMessages.createdAt, metadataJson: threadMessages.metadataJson })
        .from(threadMessages)
        .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.threadId, threadId)))
        .orderBy(desc(threadMessages.createdAt))
        .limit(window);
    if (tail.length === 0) return { streak: 0, resetAt: 0 };
    const ordered = tail.reverse();
    const since = new Date(ordered[0].createdAt.getTime() - AGENT_LOOP_COOLDOWN_MS);
    const { core, notes } = await progressTimestampsForThread(companyId, threadId, since);
    const msgs = ordered.map((m) => ({ id: m.id, senderType: m.senderType, createdAt: m.createdAt, resumes: isLoopGuardResume(m.metadataJson) }));
    return agentStreakState(msgs, [...core, ...noteProgressResets(msgs, notes)]);
}

/**
 * The moment a shared thread's agent streak passes the routing limit, post one
 * visible pause notice. Runtimes stop answering at that point (the server's
 * routing verdict says "loop_paused"), so without it the silence would be
 * unexplained. Posted exactly once per pause: the streak only crosses the
 * threshold on the message that first exceeds it.
 */
async function postLoopGuardNoticeIfNeeded(companyId: string, threadId: string) {
    try {
        const [thread] = await db.select({ id: messageThreads.id, type: messageThreads.type, description: messageThreads.description, createdByType: messageThreads.createdByType, projectId: messageThreads.projectId })
            .from(messageThreads)
            .where(and(eq(messageThreads.id, threadId), eq(messageThreads.companyId, companyId))).limit(1);
        if (!thread || thread.type === "direct") return;
        const isPair = isAgentPairThread(thread);
        const max = agentLoopMaxTurnsFor(isPair);

        // Compute the streak (and when it last reset) BEFORE opening the
        // transaction, so the check-and-insert never holds two pool connections.
        const state = await currentAgentStreakState(companyId, threadId, max + 5);
        if (state.streak !== max + 1) return null;
        const resetAt = new Date(state.resetAt);

        // Post exactly once per pause, even when two agent posts cross the
        // threshold concurrently. The advisory lock serialises check-and-insert;
        // a second caller re-checks and sees the notice (a system message, which
        // neither counts nor resets the streak) already there for THIS pause.
        // "Already noticed" compares against the latest streak reset — a human
        // message, a resume marker, progress, or a cooldown gap — so a streak
        // that resets and re-crosses the threshold gets a fresh notice.
        const notice = await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`loop-guard-notice:${companyId}:${threadId}`}))`);
            const [existing] = await tx.select({ id: threadMessages.id })
                .from(threadMessages)
                .where(and(
                    eq(threadMessages.threadId, threadId),
                    eq(threadMessages.companyId, companyId),
                    sql`${threadMessages.metadataJson}->>'loopGuard' = 'true'`,
                    sql`${threadMessages.createdAt} > ${resetAt}`,
                ))
                .limit(1);
            if (existing) return null;
            const [row] = await tx.insert(threadMessages).values({
                threadId,
                companyId,
                senderType: "system",
                text: `Paused: ${max + 1} agent messages in a row without progress. A human or the lead can resume.`,
                metadataJson: { loopGuard: true, maxAgentTurns: max, resumable: true },
                deliveryState: "resolved",
            }).returning();
            return row;
        });
        if (!notice) return;
        await notifyLoopPaused(companyId, thread, max).catch((error) => {
            console.warn("[loop-guard] notification failed:", error instanceof Error ? error.message : error);
        });
        return notice;
    } catch (error) {
        console.warn("Loop-guard notice failed:", error instanceof Error ? error.message : error);
        return null;
    }
}

/**
 * Tell the people (and, when known, the lead agent) that a thread was paused.
 * Fires once per pause, with a dedupe key so it never spams.
 */
async function notifyLoopPaused(
    companyId: string,
    thread: { id: string; type: string; projectId: string | null },
    max: number,
): Promise<void> {
    const title = thread.type === "group" ? `Agent conversation paused` : `Team chat paused`;
    await notify(companyId, await companyAdminIds(companyId), {
        kind: "loop_paused",
        title,
        body: `${max + 1} agent messages in a row without progress. A human or the lead can resume it.`,
        link: `/messages`,
        sourceType: "message_thread",
        sourceId: thread.id,
        dedupeKey: `loop_paused:${thread.id}`,
    });
}

export async function appendThreadMessage(input: {
    companyId: string;
    threadId: string;
    senderType: SenderType;
    senderId?: string | null;
    targetAgentId?: string | null;
    text: string;
    metadataJson?: Record<string, unknown>;
    attachments?: ThreadMessageAttachment[];
    platformMessageId?: string | null;
    mirrorToLegacyChat?: boolean;
    createdAt?: Date;
    deliveryState?: ExecutionState;
}) {
    const senderIdentity = input.senderType === "human" && input.senderId
        ? await resolveHumanSender(input.companyId, input.senderId)
        : null;
    const [threadMessage] = await db.insert(threadMessages).values({
        threadId: input.threadId,
        companyId: input.companyId,
        senderType: input.senderType,
        senderId: input.senderId || null,
        targetAgentId: input.targetAgentId || null,
        text: input.text,
        metadataJson: {
            ...(input.metadataJson || {}),
            ...(senderIdentity || {}),
            ...(input.attachments && input.attachments.length > 0
                ? { attachments: input.attachments }
                : {}),
        },
        deliveryState: input.deliveryState || (input.senderType === "human" ? "queued" : "resolved"),
        platformMessageId: input.platformMessageId || null,
        createdAt: input.createdAt || new Date(),
    }).returning();

    if (input.senderType === "agent") {
        await postLoopGuardNoticeIfNeeded(input.companyId, input.threadId);
        // Mentions of people and pending decisions (```choices) notify them.
        await notifyAgentMessage(input.companyId, threadMessage);
    }

    if (input.mirrorToLegacyChat) {
        await db.insert(chatMessages).values({
            companyId: input.companyId,
            threadId: input.threadId,
            senderType: input.senderType,
            fromUserId: input.senderId || null,
            text: input.text,
            platformMessageId: input.platformMessageId || null,
            createdAt: input.createdAt || new Date(),
        });
    }

    return threadMessage;
}

export async function updateThreadExecutionState(input: {
    companyId: string;
    threadId: string;
    actorType: "agent" | "human";
    actorId?: string | null;
    targetState: ExecutionState;
    // When given, only this specific message advances instead of every
    // unresolved message in the thread. Required for "resolved": that
    // transition means "a reply now exists for this exact message" —
    // applying it thread-wide would mark still-unprocessed queued messages
    // as done the instant an earlier one finishes, before the agent has
    // even started them. Hermes supplies messageId for every transition,
    // keeping follow-ups queued until their own dispatch starts.
    messageId?: string | null;
}) {
    const targetState = normalizeExecutionState(input.targetState);
    if (!targetState) return [];

    const outstanding = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, input.companyId),
        eq(threadMessages.threadId, input.threadId),
        // People's messages, and work the system hands an agent (daily review,
        // approval decisions, requests from other platforms) — those are
        // created queued; other system notices are created resolved.
        inArray(threadMessages.senderType, ["human", "system"]),
        ne(threadMessages.deliveryState, "resolved"),
        ne(threadMessages.deliveryState, "cancelled"),
        input.messageId ? eq(threadMessages.id, input.messageId) : undefined,
    ));

    const toUpdate = outstanding.filter((m) => m.deliveryState !== targetState);
    if (toUpdate.length === 0) return [];

    const updated = await Promise.all(toUpdate.map(async (m) => {
        const metadata = (m.metadataJson as Record<string, unknown>) || {};
        // A runtime putting an in-flight prompt back in the queue means that
        // attempt failed and it will retry. Count it: agent health reads it.
        const isRetry = input.actorType === "agent" && m.deliveryState === "acting" && targetState === "queued";
        const [row] = await db.update(threadMessages).set({
            deliveryState: targetState,
            metadataJson: {
                ...metadata,
                executionStateUpdatedAt: new Date().toISOString(),
                executionStateUpdatedBy: input.actorType,
                executionActorId: input.actorId || null,
                ...(isRetry ? {
                    failedAttempts: (Number(metadata.failedAttempts) || 0) + 1,
                    lastFailedAt: new Date().toISOString(),
                } : {}),
            },
        }).where(and(eq(threadMessages.id, m.id), ne(threadMessages.deliveryState, "cancelled"))).returning();
        return row;
    }));

    return updated.filter((row): row is typeof threadMessages.$inferSelect => Boolean(row));
}

/**
 * A runtime gave up on a prompt after exhausting its retries. Mark that one
 * human message as failed (cancelled + runtimeFailure) so it is visible in the
 * transcript, agent health, and a notification — instead of sitting "queued"
 * forever. Returns the updated message, or null when nothing applies.
 */
export async function markMessageFailedByRuntime(input: {
    companyId: string;
    threadId: string;
    messageId: string;
    agentId: string;
    reason?: string | null;
}) {
    const [message] = await db.select().from(threadMessages).where(and(
        eq(threadMessages.id, input.messageId),
        eq(threadMessages.companyId, input.companyId),
        eq(threadMessages.threadId, input.threadId),
        inArray(threadMessages.senderType, ["human", "system"]),
    )).limit(1);
    if (!message || message.deliveryState === "resolved" || message.deliveryState === "cancelled") return null;
    const metadata = (message.metadataJson as Record<string, unknown>) || {};
    const [row] = await db.update(threadMessages).set({
        deliveryState: "cancelled",
        metadataJson: {
            ...metadata,
            runtimeFailure: {
                agentId: input.agentId,
                at: new Date().toISOString(),
                attempts: Number(metadata.failedAttempts) || null,
                reason: input.reason ? String(input.reason).slice(0, 300) : null,
            },
            executionStateUpdatedAt: new Date().toISOString(),
            executionStateUpdatedBy: "agent",
            executionActorId: input.agentId,
        },
    }).where(and(eq(threadMessages.id, message.id), ne(threadMessages.deliveryState, "cancelled"))).returning();
    return row ?? null;
}

export async function getThreadMessages(
    companyId: string,
    threadId: string,
    limit = 100,
    since?: Date | null,
    before?: Date | null
) {
    const conditions = [
        eq(threadMessages.companyId, companyId),
        eq(threadMessages.threadId, threadId),
    ];

    if (since) {
        conditions.push(sql`${threadMessages.createdAt} >= ${since}`);
    }
    if (before) {
        conditions.push(lt(threadMessages.createdAt, before));
    }

    const rows = await db.select().from(threadMessages)
        .where(and(...conditions))
        .orderBy(desc(threadMessages.createdAt))
        .limit(limit);

    return rows.reverse();
}

export async function writeAgentMemory(input: {
    companyId: string;
    agentId: string;
    sessionId?: string | null;
    projectId?: string | null;
    taskId?: string | null;
    kind?: string;
    content: string;
    summary?: string | null;
    metadataJson?: Record<string, unknown>;
    snapshot?: string | null;
}) {
    const [entry] = await db.insert(agentMemoryEntries).values({
        companyId: input.companyId,
        agentId: input.agentId,
        sessionId: input.sessionId || null,
        projectId: input.projectId || null,
        taskId: input.taskId || null,
        kind: input.kind || "context",
        content: input.content,
        summary: input.summary || null,
        metadataJson: input.metadataJson || {},
    }).returning();

    const snapshotContent = input.snapshot || input.content;

    const [snapshot] = await db.insert(agentMemorySnapshots).values({
        companyId: input.companyId,
        agentId: input.agentId,
        sessionId: input.sessionId || null,
        content: snapshotContent,
        summary: input.summary || null,
    }).returning();

    await db.update(agents).set({
        memory: snapshotContent,
    }).where(and(eq(agents.id, input.agentId), eq(agents.companyId, input.companyId)));

    return { entry, snapshot };
}

export async function readAgentMemory(companyId: string, agentId: string, limit = 20) {
    const [snapshot] = await db.select().from(agentMemorySnapshots)
        .where(and(eq(agentMemorySnapshots.companyId, companyId), eq(agentMemorySnapshots.agentId, agentId)))
        .orderBy(desc(agentMemorySnapshots.createdAt))
        .limit(1);

    const entries = await db.select().from(agentMemoryEntries)
        .where(and(eq(agentMemoryEntries.companyId, companyId), eq(agentMemoryEntries.agentId, agentId)))
        .orderBy(desc(agentMemoryEntries.createdAt))
        .limit(limit);

    return {
        snapshot: snapshot || null,
        entries: entries.reverse(),
    };
}

export async function registerRuntimeNode(input: {
    companyId: string;
    runtimeId: string;
    name: string;
    hostname?: string | null;
    gatewayVersion?: string | null;
    capabilitiesJson?: unknown[];
    startedAt?: Date | null;
}) {
    const [existing] = await db.select().from(runtimeNodes).where(
        and(eq(runtimeNodes.companyId, input.companyId), eq(runtimeNodes.runtimeId, input.runtimeId))
    ).limit(1);

    if (existing) {
        const [updated] = await db.update(runtimeNodes).set({
            name: input.name,
            hostname: input.hostname || null,
            gatewayVersion: input.gatewayVersion || null,
            capabilitiesJson: input.capabilitiesJson || [],
            status: "active",
            startedAt: input.startedAt || existing.startedAt,
            lastSeenAt: new Date(),
            deletedAt: null,
        }).where(eq(runtimeNodes.id, existing.id)).returning();

        return updated;
    }

    const [created] = await db.insert(runtimeNodes).values({
        companyId: input.companyId,
        runtimeId: input.runtimeId,
        name: input.name,
        hostname: input.hostname || null,
        gatewayVersion: input.gatewayVersion || null,
        capabilitiesJson: input.capabilitiesJson || [],
        startedAt: input.startedAt || null,
        lastSeenAt: new Date(),
    }).returning();

    return created;
}

export async function startAgentSession(input: {
    companyId: string;
    agentId: string;
    runtimeNodeId?: string | null;
    openclawSessionId: string;
    sessionType?: string | null;
    channel?: string | null;
    startedAt?: Date | null;
    checkpointJson?: Record<string, unknown> | null;
}) {
    const [existing] = await db.select().from(agentSessions).where(
        and(
            eq(agentSessions.companyId, input.companyId),
            eq(agentSessions.agentId, input.agentId),
            eq(agentSessions.openclawSessionId, input.openclawSessionId),
            or(eq(agentSessions.status, "starting"), eq(agentSessions.status, "active"), eq(agentSessions.status, "degraded"))
        )
    ).orderBy(desc(agentSessions.createdAt)).limit(1);

    if (existing) {
        const [updated] = await db.update(agentSessions).set({
            runtimeNodeId: input.runtimeNodeId || existing.runtimeNodeId,
            sessionType: input.sessionType || existing.sessionType,
            channel: input.channel || existing.channel,
            checkpointJson: input.checkpointJson || existing.checkpointJson,
            lastWakeAt: new Date(),
            checkinDeadlineAt: nextCheckinDeadline(),
            wakeAttempts: 0,
            lifecycleGeneration: (existing.lifecycleGeneration || 0) + 1,
            lastProvisionError: null,
            status: "active",
        }).where(eq(agentSessions.id, existing.id)).returning();

        return updated;
    }

    const [created] = await db.insert(agentSessions).values({
        companyId: input.companyId,
        agentId: input.agentId,
        runtimeNodeId: input.runtimeNodeId || null,
        openclawSessionId: input.openclawSessionId,
        sessionType: input.sessionType || "main",
        channel: input.channel || null,
        checkpointJson: input.checkpointJson || null,
        startedAt: input.startedAt || new Date(),
        lastWakeAt: new Date(),
        checkinDeadlineAt: nextCheckinDeadline(),
        wakeAttempts: 0,
        lifecycleGeneration: 1,
        status: "active",
    }).returning();

    return created;
}

export async function checkpointAgentSession(input: {
    companyId: string;
    sessionId: string;
    checkpointJson: Record<string, unknown>;
    status?: string;
    syncStatus?: string;
    summary?: string | null;
}) {
    const [updated] = await db.update(agentSessions).set({
        checkpointJson: input.checkpointJson,
        lastCheckpointAt: new Date(),
        status: input.status || "active",
        syncStatus: input.syncStatus || "synced",
        lastProvisionError: null,
        summary: input.summary || undefined,
    }).where(
        and(eq(agentSessions.id, input.sessionId), eq(agentSessions.companyId, input.companyId))
    ).returning();

    return updated;
}

export async function endAgentSession(input: {
    companyId: string;
    sessionId: string;
    status?: string;
    summary?: string | null;
    checkpointJson?: Record<string, unknown> | null;
}) {
    const [updated] = await db.update(agentSessions).set({
        status: input.status || "ended",
        summary: input.summary || null,
        checkpointJson: input.checkpointJson || undefined,
        lastCheckpointAt: input.checkpointJson ? new Date() : undefined,
        checkinDeadlineAt: null,
        endedAt: new Date(),
    }).where(
        and(eq(agentSessions.id, input.sessionId), eq(agentSessions.companyId, input.companyId))
    ).returning();

    return updated;
}

export async function getCompanyContext(companyId: string) {
    const [company] = await db.select({ contextNotes: companies.contextNotes }).from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);

    return company?.contextNotes || null;
}

export async function getLatestManagedSecret(integrationId: string, companyId: string) {
    const [secretVersion] = await db.select().from(integrationSecretVersions)
        .where(and(
            eq(integrationSecretVersions.integrationId, integrationId),
            eq(integrationSecretVersions.companyId, companyId),
            isNull(integrationSecretVersions.revokedAt)
        ))
        .orderBy(desc(integrationSecretVersions.version))
        .limit(1);

    return secretVersion || null;
}

export async function logCredentialAccess(input: {
    companyId: string;
    integrationId: string;
    agentId?: string | null;
    sessionId?: string | null;
    action: string;
    status: string;
    reason?: string | null;
    metadataJson?: Record<string, unknown>;
}) {
    await db.insert(credentialAccessLogs).values({
        companyId: input.companyId,
        integrationId: input.integrationId,
        agentId: input.agentId || null,
        sessionId: input.sessionId || null,
        action: input.action,
        status: input.status,
        reason: input.reason || null,
        metadataJson: input.metadataJson || {},
    });
}
