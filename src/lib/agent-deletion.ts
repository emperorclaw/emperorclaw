import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
    actionRuns,
    agentIntegrations,
    agentMemoryEntries,
    agentMemorySnapshots,
    agents,
    agentSessions,
    approvals,
    artifactFolders,
    artifacts,
    credentialAccessLogs,
    messageThreads,
    pipelineRuns,
    pipelines,
    projectAgentProfiles,
    projectMemory,
    projects,
    recurringTaskDefinitions,
    resourceAccessLogs,
    scopedResources,
    tasks,
    threadMessages,
    threadParticipants,
} from "@/db/schema";
import { logAudit } from "@/lib/mcp";

export async function deleteAgentAndData(input: {
    companyId: string;
    agentId: string;
    actorType: "human" | "agent" | "system";
    actorId: string | null;
    confirmName?: string;
}) {
    const { companyId, agentId, actorType, actorId, confirmName } = input;
    const now = new Date();

    const [existing] = await db.select().from(agents).where(
        and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).limit(1);

    if (!existing) {
        return null;
    }

    if (confirmName !== undefined && confirmName !== existing.name) {
        const error = new Error("Confirmation name does not match the agent name.");
        error.name = "ConfirmationMismatchError";
        throw error;
    }

    await db.transaction(async (tx) => {
        const agentParticipants = await tx.select({
            threadId: threadParticipants.threadId,
        }).from(threadParticipants).where(
            and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                eq(threadParticipants.participantId, agentId)
            )
        );

        const threadIds = agentParticipants.map((participant) => participant.threadId);
        const directThreads = threadIds.length > 0
            ? await tx.select({ id: messageThreads.id }).from(messageThreads).where(
                and(
                    eq(messageThreads.companyId, companyId),
                    eq(messageThreads.type, "direct"),
                    inArray(messageThreads.id, threadIds)
                )
            )
            : [];
        const directThreadIds = directThreads.map((thread) => thread.id);

        await tx.delete(agentMemoryEntries).where(and(eq(agentMemoryEntries.companyId, companyId), eq(agentMemoryEntries.agentId, agentId)));
        await tx.delete(agentMemorySnapshots).where(and(eq(agentMemorySnapshots.companyId, companyId), eq(agentMemorySnapshots.agentId, agentId)));
        await tx.delete(agentSessions).where(and(eq(agentSessions.companyId, companyId), eq(agentSessions.agentId, agentId)));
        await tx.delete(actionRuns).where(and(eq(actionRuns.companyId, companyId), eq(actionRuns.agentId, agentId)));
        await tx.delete(agentIntegrations).where(and(eq(agentIntegrations.companyId, companyId), eq(agentIntegrations.agentId, agentId)));
        await tx.delete(credentialAccessLogs).where(and(eq(credentialAccessLogs.companyId, companyId), eq(credentialAccessLogs.agentId, agentId)));
        await tx.delete(resourceAccessLogs).where(and(eq(resourceAccessLogs.companyId, companyId), eq(resourceAccessLogs.agentId, agentId)));

        if (directThreadIds.length > 0) {
            await tx.delete(messageThreads).where(and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, directThreadIds)));
        }

        await tx.delete(threadParticipants).where(
            and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                eq(threadParticipants.participantId, agentId)
            )
        );
        await tx.update(threadMessages).set({ targetAgentId: null }).where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.targetAgentId, agentId)));

        await tx.update(tasks).set({
            assignedAgentId: null,
            leaseOwner: null,
            leaseUntil: null,
            processingStartedAt: null,
            updatedAt: now,
        }).where(and(eq(tasks.companyId, companyId), eq(tasks.assignedAgentId, agentId)));
        await tx.update(projects).set({ leadAgentId: null, updatedAt: now }).where(and(eq(projects.companyId, companyId), eq(projects.leadAgentId, agentId)));
        await tx.update(projectAgentProfiles).set({ deletedAt: now, updatedAt: now }).where(
            and(eq(projectAgentProfiles.companyId, companyId), eq(projectAgentProfiles.agentId, agentId), isNull(projectAgentProfiles.deletedAt))
        );
        await tx.update(projectMemory).set({ createdByAgentId: null }).where(and(eq(projectMemory.companyId, companyId), eq(projectMemory.createdByAgentId, agentId)));
        await tx.update(approvals).set({ requesterAgentId: null }).where(and(eq(approvals.companyId, companyId), eq(approvals.requesterAgentId, agentId)));
        await tx.update(artifacts).set({ agentId: null, updatedAt: now }).where(and(eq(artifacts.companyId, companyId), eq(artifacts.agentId, agentId)));
        await tx.update(artifactFolders).set({ agentId: null, updatedAt: now }).where(and(eq(artifactFolders.companyId, companyId), eq(artifactFolders.agentId, agentId)));
        await tx.update(pipelines).set({ ownerAgentId: null, updatedAt: now }).where(and(eq(pipelines.companyId, companyId), eq(pipelines.ownerAgentId, agentId)));
        await tx.update(pipelineRuns).set({ agentId: null }).where(and(eq(pipelineRuns.companyId, companyId), eq(pipelineRuns.agentId, agentId)));
        await tx.update(recurringTaskDefinitions).set({ createdByAgentId: null, updatedAt: now }).where(
            and(eq(recurringTaskDefinitions.companyId, companyId), eq(recurringTaskDefinitions.createdByAgentId, agentId))
        );
        await tx.update(scopedResources).set({ status: "archived", deletedAt: now, updatedAt: now }).where(
            and(eq(scopedResources.companyId, companyId), eq(scopedResources.scopeType, "agent"), eq(scopedResources.scopeId, agentId), isNull(scopedResources.deletedAt))
        );

        await tx.update(agents).set({
            deletedAt: now,
            status: "offline",
            currentLoad: 0,
            memory: null,
            skillsJson: [],
            modelPolicyJson: {},
            lastSeenAt: null,
        }).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    });

    await logAudit(companyId, actorType, actorId, "delete_agent", "agent", agentId, {
        name: existing.name,
        role: existing.role,
    });

    return existing;
}
