import { db } from "@/db";
import { agents, tasks } from "@/db/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AgentsClient } from "./agents-client";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allAgents = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
    const tasksCompletedByAgent = await db.select({
        agentId: tasks.assignedAgentId,
        count: sql<number>`count(*)`,
    }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, "done"), isNull(tasks.deletedAt))).groupBy(tasks.assignedAgentId);

    const completedMap = tasksCompletedByAgent.reduce((acc, curr) => {
        if (curr.agentId) acc[curr.agentId] = curr.count;
        return acc;
    }, {} as Record<string, number>);

    return (
        <AgentsClient
            agents={allAgents.map((agent) => ({
                id: agent.id,
                name: agent.name,
                avatarUrl: agent.avatarUrl,
                role: agent.role || "Unspecified",
                status: agent.status,
                uptime: "99.9%",
                tasksCompleted: completedMap[agent.id] || 0,
                currentLoad: agent.concurrencyLimit > 0 ? Math.round((agent.currentLoad / agent.concurrencyLimit) * 100) : 0,
            }))}
        />
    );
}
