import { db } from "@/db";
import {
    actionRuns,
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
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";

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
    const candidateThreads = await db.select().from(messageThreads).where(
        and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, "direct"),
            isNull(messageThreads.archivedAt)
        )
    );

    if (candidateThreads.length > 0) {
        const participants = await db.select().from(threadParticipants).where(
            and(
                eq(threadParticipants.companyId, companyId),
                inArray(threadParticipants.threadId, candidateThreads.map(thread => thread.id))
            )
        );

        const participantMap = participants.reduce((acc, participant) => {
            if (!acc[participant.threadId]) acc[participant.threadId] = [];
            acc[participant.threadId].push(participant);
            return acc;
        }, {} as Record<string, typeof threadParticipants.$inferSelect[]>);

        const targetUserRef = userId || "human-manager";
        const existingThread = candidateThreads.find(thread => {
            const threadParticipantList = participantMap[thread.id] || [];
            const hasAgent = threadParticipantList.some(participant =>
                participant.participantType === "agent" && participant.participantId === agentId
            );
            const hasHuman = threadParticipantList.some(participant =>
                participant.participantType === "human" && participant.participantRef === targetUserRef
            );
            return hasAgent && hasHuman;
        });

        if (existingThread) return existingThread;
    }

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
            participantRef: userId || "human-manager",
            role: "member",
        },
    ]);

    return created;
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
}) {
    const [threadMessage] = await db.insert(threadMessages).values({
        threadId: input.threadId,
        companyId: input.companyId,
        senderType: input.senderType,
        senderId: input.senderId || null,
        targetAgentId: input.targetAgentId || null,
        text: input.text,
        metadataJson: input.metadataJson || {},
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

export async function getThreadMessages(companyId: string, threadId: string, limit = 100, since?: Date | null) {
    const conditions = [
        eq(threadMessages.companyId, companyId),
        eq(threadMessages.threadId, threadId),
    ];

    if (since) {
        conditions.push(sql`${threadMessages.createdAt} > ${since}`);
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
