import { db } from "@/db";
import {
    agentMemoryEntries,
    agentMemorySnapshots,
    agentSessions,
    agents,
    chatMessages,
    companies,
    credentialAccessLogs,
    integrationSecretVersions,
    messageThreads,
    runtimeNodes,
    threadMessages,
    threadParticipants,
} from "@/db/schema";
import { and, desc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { nextCheckinDeadline } from "./lifecycle";
import { normalizeExecutionState, type ExecutionState } from "./project-workflow";

type SenderType = "human" | "agent" | "system";

export async function ensureTeamThread(companyId: string) {
    const [existing] = await db.select().from(messageThreads).where(
        and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, "team"),
            isNull(messageThreads.archivedAt)
        )
    ).limit(1);

    if (existing) return existing;

    const [created] = await db.insert(messageThreads).values({
        companyId,
        type: "team",
        title: "Agent Team Chat",
        createdByType: "system",
    }).returning();

    return created;
}

export async function ensureDirectThread(companyId: string, agentId: string, userId?: string | null) {
    // Find ALL direct threads where this agent participates
    const agentParticipants = await db.select({ threadId: threadParticipants.threadId })
        .from(threadParticipants)
        .where(
            and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                eq(threadParticipants.participantId, agentId)
            )
        );
    const agentThreadIds = agentParticipants.map(p => p.threadId);

    if (agentThreadIds.length > 0) {
        // Try exact userId match first
        if (userId) {
            const [exact] = await db.select({ threadId: threadParticipants.threadId })
                .from(threadParticipants)
                .where(
                    and(
                        eq(threadParticipants.companyId, companyId),
                        inArray(threadParticipants.threadId, agentThreadIds),
                        eq(threadParticipants.participantType, "human"),
                        eq(threadParticipants.participantRef, userId)
                    )
                ).limit(1);
            if (exact) {
                const [t] = await db.select().from(messageThreads).where(
                    and(eq(messageThreads.id, exact.threadId), eq(messageThreads.companyId, companyId), eq(messageThreads.type, "direct"), isNull(messageThreads.archivedAt))
                ).limit(1);
                if (t) return t;
            }
        }

        // Fallback: any direct thread with this agent (bridge-created, wrong participantRef, etc.)
        const [anyHuman] = await db.select({ threadId: threadParticipants.threadId })
            .from(threadParticipants)
            .where(
                and(
                    eq(threadParticipants.companyId, companyId),
                    inArray(threadParticipants.threadId, agentThreadIds),
                    eq(threadParticipants.participantType, "human")
                )
            ).limit(1);

        if (anyHuman) {
            // If userId is provided and differs, fix the participantRef so next lookup is exact
            if (userId) {
                await db.update(threadParticipants)
                    .set({ participantRef: userId })
                    .where(
                        and(
                            eq(threadParticipants.threadId, anyHuman.threadId),
                            eq(threadParticipants.participantType, "human")
                        )
                    );
            }

            const [t] = await db.select().from(messageThreads).where(
                and(eq(messageThreads.id, anyHuman.threadId), eq(messageThreads.companyId, companyId), eq(messageThreads.type, "direct"), isNull(messageThreads.archivedAt))
            ).limit(1);
            if (t) return t;
        }
    }

    // No existing thread — create one with the best participantRef we have
    const targetUserRef = userId || "human-manager";

    const [created] = await db.insert(messageThreads).values({
        companyId,
        type: "direct",
        title: "Direct Agent Thread",
        createdByType: userId ? "human" : "system",
    }).returning();

    await db.insert(threadParticipants).values([
        {
            threadId: created.id,
            companyId,
            participantType: "agent",
            participantId: agentId,
            role: "member",
        },
        {
            threadId: created.id,
            companyId,
            participantType: "human",
            participantRef: targetUserRef,
            role: "member",
        },
    ]);

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
        await db.update(threadParticipants).set({ lastReadAt: new Date() }).where(eq(threadParticipants.id, existing.id));
    } else {
        await db.insert(threadParticipants).values({
            threadId,
            companyId,
            participantType: "human",
            participantRef: userId,
            lastReadAt: new Date(),
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
    platformMessageId?: string | null;
    mirrorToLegacyChat?: boolean;
    createdAt?: Date;
    deliveryState?: ExecutionState;
}) {
    const [threadMessage] = await db.insert(threadMessages).values({
        threadId: input.threadId,
        companyId: input.companyId,
        senderType: input.senderType,
        senderId: input.senderId || null,
        targetAgentId: input.targetAgentId || null,
        text: input.text,
        metadataJson: input.metadataJson || {},
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
    if (!targetState) return null;

    const [latestHumanMessage] = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, input.companyId),
        eq(threadMessages.threadId, input.threadId),
        eq(threadMessages.senderType, "human"),
    )).orderBy(desc(threadMessages.createdAt)).limit(1);

    if (!latestHumanMessage) return null;
    if (latestHumanMessage.deliveryState === targetState) return null;

    const [updated] = await db.update(threadMessages).set({
        deliveryState: targetState,
        metadataJson: {
            ...(latestHumanMessage.metadataJson as Record<string, unknown> || {}),
            executionStateUpdatedAt: new Date().toISOString(),
            executionStateUpdatedBy: input.actorType,
            executionActorId: input.actorId || null,
        },
    }).where(eq(threadMessages.id, latestHumanMessage.id)).returning();

    return updated || null;
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
