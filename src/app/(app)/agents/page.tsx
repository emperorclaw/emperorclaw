import { db } from "@/db";
import { agents, tasks } from "@/db/schema";
import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { getMemberScopeForSession, getScopedAgentIds } from "@/lib/member-scope";
import { agentsNotUsableBy, ownerNames, usableAgentCondition } from "@/lib/agent-access-server";
import { requireRole } from "@/lib/roles";
import { canAdmin } from "@/lib/role-matrix";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { AgentsClient } from "./agents-client";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const session = await getValidatedServerSession();
    const scope = session ? await getMemberScopeForSession(session) : null;
    const scopedAgentIds = getScopedAgentIds(scope);

    const agentConditions: any[] = [eq(agents.companyId, companyId), isNull(agents.deletedAt)];
    if (scopedAgentIds) agentConditions.push(inArray(agents.id, scopedAgentIds));

    // Agents limited to other people (0.20): hidden from members, a locked card for owners/admins.
    const guard = await requireRole("viewer")().catch(() => null);
    const { hidden, metadata } = guard ? await agentsNotUsableBy({ ...guard, scope }) : { hidden: new Set<string>(), metadata: new Set<string>() };
    if (!guard || !canAdmin(guard.role)) {
        const condition = usableAgentCondition(hidden, agents.id);
        if (condition) agentConditions.push(condition);
    }

    const allAgents = await db.select().from(agents).where(and(...agentConditions));
    const owners = await ownerNames(allAgents.filter((agent) => agent.access !== "everyone").map((agent) => agent.ownerUserId));
    const tasksCompletedByAgent = await db.select({
        agentId: tasks.assignedAgentId,
        count: sql<number>`count(*)`,
    }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, "done"), isNull(tasks.deletedAt))).groupBy(tasks.assignedAgentId);

    const completedMap = tasksCompletedByAgent.reduce((acc, curr) => {
        if (curr.agentId) acc[curr.agentId] = curr.count;
        return acc;
    }, {} as Record<string, number>);

    // Agent failure stats: dead-lettered + failed tasks per agent
    const failureConditions: any[] = [eq(tasks.companyId, companyId), isNull(tasks.deletedAt)];
    if (scopedAgentIds) failureConditions.push(inArray(tasks.assignedAgentId, scopedAgentIds));
    
    const failuresByAgent = await db.select({
        agentId: tasks.assignedAgentId,
        deadCount: sql<number>`count(*) filter (where ${tasks.state} = 'dead_letter')`,
        failedCount: sql<number>`count(*) filter (where ${tasks.state} = 'failed')`,
    }).from(tasks).where(and(...failureConditions)).groupBy(tasks.assignedAgentId);

    const failureMap = failuresByAgent.reduce((acc, curr) => {
        if (curr.agentId) acc[curr.agentId] = { dead: curr.deadCount, failed: curr.failedCount };
        return acc;
    }, {} as Record<string, { dead: number; failed: number }>);

    return (
        <Suspense>
        <AgentsClient
            agents={allAgents.map((agent) => {
                const failures = failureMap[agent.id];
                return {
                    id: agent.id,
                    name: agent.name,
                    avatarUrl: agent.avatarUrl,
                    role: agent.role || "Unspecified",
                    status: agent.status,
                    uptime: "99.9%",
                    tasksCompleted: completedMap[agent.id] || 0,
                    currentLoad: agent.concurrencyLimit > 0 ? Math.round((agent.currentLoad / agent.concurrencyLimit) * 100) : 0,
                    deadLetterCount: failures?.dead || 0,
                    failedCount: failures?.failed || 0,
                    access: agent.access,
                    ownerName: agent.ownerUserId ? owners.get(agent.ownerUserId) ?? null : null,
                    use: metadata.has(agent.id) ? "metadata" as const : "full" as const,
                };
            })}
        />
        </Suspense>
    );
}
