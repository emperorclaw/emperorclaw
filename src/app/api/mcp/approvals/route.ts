import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { createApprovalRequest, listApprovalsForCompany } from "@/lib/approvals";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");

    const approvals = await listApprovalsForCompany(companyId);
    return NextResponse.json({
        approvals: approvals.filter((approval) => {
            if (projectId && approval.projectId !== projectId) return false;
            if (status && approval.status !== status) return false;
            return true;
        }),
    });
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    try {
        const companyId = auth.companyToken!.companyId;
        const body = await req.json();
        const { projectId, taskIds, requesterAgentId, rationale, confidence = 0, actionType = "task_done" } = body;

        if (!projectId || !Array.isArray(taskIds) || taskIds.length === 0) {
            return NextResponse.json({ error: "projectId and taskIds are required" }, { status: 400 });
        }

        const resolvedRequesterAgentId = requesterAgentId
            ? await resolveAgentId(companyId, requesterAgentId)
            : null;

        const approval = await createApprovalRequest({
            companyId,
            projectId,
            taskIds,
            requesterAgentId: resolvedRequesterAgentId,
            rationale: rationale || null,
            confidence,
            actionType,
            metadataJson: {
                createdBy: "mcp",
            },
        });

        return NextResponse.json({ approval }, { status: 201 });
    } catch (error) {
        console.error("MCP approval create error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
