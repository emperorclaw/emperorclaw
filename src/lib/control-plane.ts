import { db } from "@/db";
import {
    agentMemoryEntries,
    agentMemorySnapshots,
    agentSessions,
    agents,
    chatMessages,
    companies,
    companyMembers,
    credentialAccessLogs,
    integrationSecretVersions,
    messageThreads,
    runtimeNodes,
    threadMessages,
    threadParticipants,
    users,
} from "@/db/schema";
import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { nextCheckinDeadline } from "./lifecycle";
import { normalizeExecutionState, type ExecutionState } from "./project-workflow";

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

    const [created] = await db.insert(messageThreads).values({
        companyId,
        type: "team",
        title: "Agent Team Chat",
        createdByType: "system",
    }).returning();

    await ensureThreadHumanParticipants(companyId, created.id);
    return created;
}

/**
 * The shared channel for one agent: exactly one "direct" thread per
 * (company, agent), visible to the whole company. Every member is a participant
 * (for per-user read state); the agent is a participant. `userId` is accepted
 * for backward compatibility but no longer affects thread identity — it is NOT
 * used to fork per-user threads, and no participant ref is ever overwritten.
 */
export async function ensureDirectThread(companyId: string, agentId: string, _userId?: string | null) {
    // The canonical thread is the one this agent participates in. A race between
    // two concurrent callers that both see "no thread yet" can still create two
    // — ordering by createdAt makes every caller converge on the same (oldest)
    // thread instead of an arbitrary one, so the resolved thread stops flip-flopping
    // between requests (a real message from a duplicate thread was previously able
    // to "reappear" mid-conversation depending on which row Postgres happened to
    // return first).
    const [agentParticipant] = await db.select({ threadId: threadParticipants.threadId })
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
        const [existing] = await db.select().from(messageThreads)
            .where(eq(messageThreads.id, agentParticipant.threadId)).limit(1);
        if (existing) {
            await ensureThreadHumanParticipants(companyId, existing.id);
            return existing;
        }
    }

    // None yet — create the agent's shared channel.
    const [created] = await db.insert(messageThreads).values({
        companyId,
        type: "direct",
        title: "Direct Agent Thread",
        createdByType: "system",
    }).returning();

    await db.insert(threadParticipants).values({
        threadId: created.id,
        companyId,
        participantType: "agent",
        participantId: agentId,
        role: "member",
    });
    await ensureThreadHumanParticipants(companyId, created.id);

    return created;
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
        await db.insert(threadParticipants).values({
            threadId,
            companyId,
            participantType: "human",
            participantRef: userId,
            lastReadAt: sql`now()`,
        });
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
    updates: { lastReadAt?: Date; typingUntil?: Date | null },
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
}) {
    const targetState = normalizeExecutionState(input.targetState);
    if (!targetState) return [];

    // Advance every unresolved human message, not just the latest one.
    // If a second message arrives while the agent is still working the
    // first, targeting only "the latest" would resolve the wrong message
    // (the unread one) and orphan the one actually being answered —
    // making it look already-handled and never getting surfaced again.
    const outstanding = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, input.companyId),
        eq(threadMessages.threadId, input.threadId),
        eq(threadMessages.senderType, "human"),
        ne(threadMessages.deliveryState, "resolved"),
    ));

    const toUpdate = outstanding.filter((m) => m.deliveryState !== targetState);
    if (toUpdate.length === 0) return [];

    const updated = await Promise.all(toUpdate.map(async (m) => {
        const [row] = await db.update(threadMessages).set({
            deliveryState: targetState,
            metadataJson: {
                ...(m.metadataJson as Record<string, unknown> || {}),
                executionStateUpdatedAt: new Date().toISOString(),
                executionStateUpdatedBy: input.actorType,
                executionActorId: input.actorId || null,
            },
        }).where(eq(threadMessages.id, m.id)).returning();
        return row;
    }));

    return updated.filter((row): row is typeof threadMessages.$inferSelect => Boolean(row));
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
