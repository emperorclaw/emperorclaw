import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { requireRole, AuthError } from "@/lib/roles";
import { getApprovalDetail, resolveApprovalOutcome } from "@/lib/approvals";
import { mayProceed } from "@/lib/approval-status";
import { mcpMayUseProject, mcpRouteAccess } from "@/lib/mcp-access";
import { agentDeciders } from "@/lib/approval-routing";
import { alreadyDecidedResponse, approvalDecisionAccess } from "@/lib/approval-access";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id } = await params;
    const detail = await getApprovalDetail(companyId, id);
    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId"));
    if (scoped.response) return scoped.response;
    // An ask-first action approval has no project: only the agent that asked
    // reads it, and the boss agent it was routed to (approval routing).
    const visible = detail && (detail.approval.projectId
        ? mcpMayUseProject(scoped.access, detail.approval.projectId)
        : !scoped.access.agentId || detail.approval.requesterAgentId === scoped.access.agentId || agentDeciders(detail.approval).includes(scoped.access.agentId));
    if (!detail || !visible) {
        return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    // Unambiguous for agents: `mayProceed` is true ONLY for an explicit
    // approval. A dismissed or expired request means DO NOT ACT.
    return NextResponse.json({ ...detail, mayProceed: mayProceed(detail.approval.status) });
}

export async function PATCH(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    // A human decision. This endpoint is MCP-reachable, but an agent must never
    // resolve its own approval (or forge a human audit trail), so it requires a
    // real logged-in user session and ignores any caller-supplied resolver id
    // in favour of the authenticated one. A boss agent decides through the
    // decide_approval MCP tool, which checks its authority.
    let ctx;
    try {
        ctx = await requireRole("member")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }

    try {
        const { id } = await params;
        // The same rule as PATCH /api/approvals/[id] (lib/approval-access.ts):
        // scope, "Can view", and a routed ask's approvers (owners/admins override).
        const { detail: current, denied } = await approvalDecisionAccess(ctx, id);
        if (denied) return denied;
        if (!current) return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        if (current.approval.status !== "pending") return alreadyDecidedResponse(ctx.companyId, current.approval);
        const body = await _req.json();
        const { status, resolutionNote } = body;

        if (status !== "approved" && status !== "rejected" && status !== "dismissed") {
            return NextResponse.json({ error: "status must be approved, rejected, or dismissed" }, { status: 400 });
        }

        const { approval, decided } = await resolveApprovalOutcome({
            companyId: ctx.companyId,
            approvalId: id,
            resolverUserId: ctx.userId,
            status,
            resolutionNote: resolutionNote || null,
        });

        if (!approval) {
            return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        }
        if (!decided) return alreadyDecidedResponse(ctx.companyId, approval);

        return NextResponse.json({ approval });
    } catch (error) {
        console.error("MCP approval resolve error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
