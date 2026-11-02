export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeRecord } from "@/lib/member-scope";
import { memberMayUseAgent } from "@/lib/agent-access-server";
import { recordsWriteDenied } from "@/lib/resource-access";
import { db } from "@/db";
import { pipelines } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { humanActor } from "@/lib/audit";
import { PipelineRunError, startPipelineRun } from "@/lib/pipeline-runs";
import { resolveAgentId } from "@/lib/mcp";

/**
 * POST /api/pipelines/[id]/run - Run now. Body: { agentId?, force? }.
 *
 * Same access as the status PATCH: the automations module, and "Can edit" on
 * the automation's project/customer (the company role when it has neither).
 * Hands the run to the agent as a task; 409 while it is not active or (unless
 * `force`) while a run is still running, with that run.
 */
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const access = await companyRouteAccess("viewer", { module: "automations" });
        if (access.response) return access.response;
        const membership = access.ctx;
        const { id } = await params;
        const body = await req.json().catch(() => ({})) as { agentId?: unknown; force?: unknown };

        const [pipeline] = await db.select().from(pipelines).where(
            and(eq(pipelines.id, id), eq(pipelines.companyId, membership.companyId), isNull(pipelines.deletedAt))
        ).limit(1);
        if (!pipeline || !(await memberMaySeeRecord(membership.companyId, membership.scope, pipeline))) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }
        const denied = await recordsWriteDenied(membership, [pipeline], "member", "Pipeline");
        if (denied) return denied;

        const agentRef = typeof body.agentId === "string" && body.agentId.trim() ? body.agentId.trim() : null;
        // A restricted member may only hand work to agents they can see.
        const runnerId = agentRef ? await resolveAgentId(membership.companyId, agentRef).catch(() => null) : pipeline.ownerAgentId;
        if (agentRef && !runnerId) return NextResponse.json({ error: `Agent not found: ${agentRef}` }, { status: 404 });
        if (runnerId && !(await memberMayUseAgent(membership, runnerId))) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        const started = await startPipelineRun({
            companyId: membership.companyId,
            pipelineId: pipeline.id,
            agentRef: runnerId,
            force: body.force === true,
            source: "manual",
            triggeredBy: { type: "user", id: membership.userId },
            actor: humanActor(membership.userId),
            // The task goes to the automation's project (else "General"): the person must be able to add work there.
            mayUseProject: async (projectId) => !(await recordsWriteDenied(membership, [projectId ? { projectId } : {}], "member", "Project")),
        });
        return NextResponse.json({ run: started.run, taskId: started.taskId, agentId: started.agentId }, { status: 201 });
    } catch (error) {
        if (error instanceof PipelineRunError) {
            return NextResponse.json({ error: error.message, code: error.code, ...(error.run ? { run: error.run } : {}) }, { status: error.status });
        }
        console.error("Pipeline run POST error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
