import { NextRequest, NextResponse } from "next/server";
import { createApprovalRequest, listApprovalsForCompany } from "@/lib/approvals";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeApproval, memberMaySeeProjectId, memberVisibleProjectIds } from "@/lib/member-scope";

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

    const approvals = await listApprovalsForCompany(companyId);
    const visibleProjects = await memberVisibleProjectIds(companyId, access.ctx.scope);
    const filtered = approvals.filter((approval) => {
        if (!memberMaySeeApproval(access.ctx.scope, visibleProjects, approval)) return false;
        if (projectId && approval.projectId !== projectId) return false;
        if (status && approval.status !== status) return false;
        return true;
    });

    return NextResponse.json({ approvals: filtered });
}

export async function POST(req: NextRequest) {
    const access = await companyRouteAccess("member");
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
            },
        });

        return NextResponse.json({ approval }, { status: 201 });
    } catch (error: unknown) {
        console.error("Approval create error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
