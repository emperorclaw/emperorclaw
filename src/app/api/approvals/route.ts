import { NextRequest, NextResponse } from "next/server";
import { getCompanyId, getUserId } from "@/lib/auth";
import { createApprovalRequest, listApprovalsForCompany } from "@/lib/approvals";

interface CreateApprovalRequestBody {
    projectId: string;
    taskIds: string[];
    rationale?: string;
    confidence?: number;
}

export async function GET(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");

    const approvals = await listApprovalsForCompany(companyId);
    const filtered = approvals.filter((approval) => {
        if (projectId && approval.projectId !== projectId) return false;
        if (status && approval.status !== status) return false;
        return true;
    });

    return NextResponse.json({ approvals: filtered });
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = (await req.json()) as CreateApprovalRequestBody;
        const { projectId, taskIds, rationale, confidence = 0 } = body;

        if (!projectId || !Array.isArray(taskIds) || taskIds.length === 0) {
            return NextResponse.json({ error: "projectId and taskIds are required" }, { status: 400 });
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
