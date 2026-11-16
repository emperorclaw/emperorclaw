import { NextRequest, NextResponse } from "next/server";
import { createApprovalRequest, listApprovalsForCompany } from "@/lib/approvals";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeProjectId } from "@/lib/member-scope";
import { approvalForReader, approvalViewsFor } from "@/lib/approval-access";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { recordsWriteDenied } from "@/lib/resource-access";

interface CreateApprovalRequestBody {
    projectId: string;
    taskIds: string[];
    rationale?: string;
    confidence?: number;
}

export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");

    const approvals = (await listApprovalsForCompany(companyId)).filter((approval) =>
        (!projectId || approval.projectId === projectId) && (!status || approval.status === status));
    // One rule per row (lib/approval-access.ts): scope, private chats, and
    // details only for those who may read them.
    const views = await approvalViewsFor(access.ctx, approvals);
    return NextResponse.json({
        approvals: approvals.flatMap((approval) => {
            const view = views.get(approval.id);
            return view?.visible ? [approvalForReader(approval, view)] : [];
        }),
    });
}

export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const userId = access.ctx.userId;

    try {
        const body = (await req.json()) as CreateApprovalRequestBody;
        const { projectId, taskIds, rationale, confidence = 0 } = body;

        if (!projectId || !Array.isArray(taskIds) || taskIds.length === 0) {
            return NextResponse.json({ error: "projectId and taskIds are required" }, { status: 400 });
        }
        if (!(await memberMaySeeProjectId(companyId, access.ctx.scope, projectId))) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }
        // Resource-aware (0.20): "Can edit" or Admin on the project.
        const denied = await recordsWriteDenied(access.ctx, [{ projectId }], "member", "Project");
        if (denied) return denied;

        // Every task must be a live task of this project, each named once: an
        // ask never reaches into another project (or a task the person can't see).
        const requested = [...new Set(taskIds)];
        if (requested.length !== taskIds.length || !requested.every((id): id is string => typeof id === "string" && UUID_RE.test(id))) {
            return NextResponse.json({ error: "taskIds must be distinct task ids" }, { status: 400 });
        }
        const taskRows = await db.select({ id: tasks.id, agentId: tasks.assignedAgentId }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.projectId, projectId), isNull(tasks.deletedAt), inArray(tasks.id, requested)));
        if (taskRows.length !== requested.length) return NextResponse.json({ error: "Task not found in this project" }, { status: 404 });
        // The tasks' one assigned agent: its owner may decide this person's ask
        // (lib/approval-routing.ts approvalAgentId), as for the agent's own asks.
        const agentIds = [...new Set(taskRows.map((row) => row.agentId))];
        const taskAgentId = agentIds.length === 1 ? agentIds[0] : null;

        const approval = await createApprovalRequest({
            companyId,
            projectId,
            taskIds,
            rationale: rationale || "Human approval requested from Emperor UI.",
            confidence,
            actionType: "task_done",
            metadataJson: {
                createdBy: "web",
                requesterUserId: userId,
                ...(taskAgentId ? { taskAgentId } : {}),
            },
        });

        return NextResponse.json({ approval }, { status: 201 });
    } catch (error: unknown) {
        console.error("Approval create error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
