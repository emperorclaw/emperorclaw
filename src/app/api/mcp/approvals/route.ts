import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { ApprovalRequestError, listApprovalsForCompany, requestApprovalForTasks } from "@/lib/approvals";
import { mcpMayUseProject, mcpMayUseTask, mcpRouteAccess } from "@/lib/mcp-access";
import { mcpApprovalView, redactApproval } from "@/lib/approval-access";
import { approvalThreadPrivacy } from "@/lib/approval-routing-server";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const projectId = searchParams.get("projectId");
    const status = searchParams.get("status");

    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, searchParams.get("agentId"));
    if (scoped.response) return scoped.response;
    const approvals = (await listApprovalsForCompany(companyId)).filter((approval) =>
        mcpMayUseProject(scoped.access, approval.projectId)
        && (!projectId || approval.projectId === projectId) && (!status || approval.status === status));
    // Per row: private-chat asks stay with their agents; details only for those involved.
    const threads = await approvalThreadPrivacy(companyId, approvals.map((approval) => approval.threadId));
    return NextResponse.json({
        approvals: approvals.flatMap((approval) => {
            const view = mcpApprovalView(scoped.access, approval, approval.threadId ? threads.get(approval.threadId) ?? null : null);
            return view.visible ? [view.mayReadDetails ? approval : redactApproval(approval)] : [];
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
        // threadId / replyToMessageId: where the ask was made; its approval card goes there (lib/approval-card.ts).
        const { taskIds, taskId, requesterAgentId, rationale, confidence = 0, actionType = "task_done", threadId, replyToMessageId } = body;

        // The token's bound agent is the requester; an operator token may name one.
        const resolvedRequesterAgentId = await resolveBoundAgentId(companyId, auth.companyToken!, requesterAgentId || null);
        const scoped = await mcpRouteAccess(companyId, auth.companyToken!, resolvedRequesterAgentId);
        if (scoped.response) return scoped.response;
        const requestedTaskIds: unknown[] = Array.isArray(taskIds) ? taskIds : taskId ? [taskId] : [];
        for (const id of requestedTaskIds) {
            if (typeof id === "string" && !(await mcpMayUseTask(companyId, scoped.access, id))) {
                return NextResponse.json({ error: "Task not found" }, { status: 404 });
            }
        }
        const approval = await requestApprovalForTasks({
            companyId,
            taskIds: Array.isArray(taskIds) ? taskIds : taskId ? [taskId] : [],
            requesterAgentId: resolvedRequesterAgentId,
            rationale,
            confidence,
            actionType,
            threadId,
            replyToMessageId,
        });

        return NextResponse.json({ approval }, { status: 201 });
    } catch (error) {
        console.error("MCP approval create error:", error);
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = error instanceof ApprovalRequestError ? error.status : message.startsWith("Agent not found") ? 404 : message.startsWith("Access denied") ? 403 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
