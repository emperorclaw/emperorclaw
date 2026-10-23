export const dynamic = "force-dynamic";

// Web API for the pipelines registry UI.
import { NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberRecordCondition } from "@/lib/member-scope";
import { db } from "@/db";
import { pipelines, pipelineRuns, agents, projects, customers } from "@/db/schema";
import { eq, desc, and, isNull, inArray } from "drizzle-orm";

export async function GET() {
    try {
        const access = await companyRouteAccess("viewer");
        if (access.response) return access.response;
        const companyId = access.ctx.companyId;

        const pipelineList = await db.select().from(pipelines)
            .where(and(eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt),
                memberRecordCondition(access.ctx.scope, { projectId: pipelines.projectId, customerId: pipelines.customerId })))
            .orderBy(desc(pipelines.updatedAt));

        const pipelineIds = pipelineList.map(p => p.id);
        const recentRuns = pipelineIds.length > 0
            ? await db.select().from(pipelineRuns)
                .where(and(eq(pipelineRuns.companyId, companyId), inArray(pipelineRuns.pipelineId, pipelineIds)))
                .orderBy(desc(pipelineRuns.startedAt))
                .limit(200)
            : [];

        const agentList = await db.select({ id: agents.id, name: agents.name }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
        const projectList = await db.select({ id: projects.id, goal: projects.goal }).from(projects)
            .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt)));
        const customerList = await db.select({ id: customers.id, name: customers.name }).from(customers)
            .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)));

        return NextResponse.json({
            pipelines: pipelineList,
            runs: recentRuns,
            agentsMap: Object.fromEntries(agentList.map(a => [a.id, a.name])),
            projectsMap: Object.fromEntries(projectList.map(p => [p.id, p.goal])),
            customersMap: Object.fromEntries(customerList.map(c => [c.id, c.name])),
        });
    } catch (error) {
        console.error("Error fetching pipelines data:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
