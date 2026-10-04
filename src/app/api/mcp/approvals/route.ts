import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { ApprovalRequestError, listApprovalsForCompany, requestApprovalForTasks } from "@/lib/approvals";

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
        const { taskIds, taskId, requesterAgentId, rationale, confidence = 0, actionType = "task_done" } = body;

        // The token's bound agent is the requester; an operator token may name one.
        const resolvedRequesterAgentId = await resolveBoundAgentId(companyId, auth.companyToken!, requesterAgentId || null);
        const approval = await requestApprovalForTasks({
            companyId,
            taskIds: Array.isArray(taskIds) ? taskIds : taskId ? [taskId] : [],
            requesterAgentId: resolvedRequesterAgentId,
            rationale,
            confidence,
            actionType,
        });

        return NextResponse.json({ approval }, { status: 201 });
    } catch (error) {
        console.error("MCP approval create error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = error instanceof ApprovalRequestError ? error.status : message.startsWith("Agent not found") ? 404 : message.startsWith("Access denied") ? 403 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
