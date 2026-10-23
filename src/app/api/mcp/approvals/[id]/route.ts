import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { requireRole, AuthError } from "@/lib/roles";
import { getApprovalDetail, resolveApproval } from "@/lib/approvals";
import { mayProceed } from "@/lib/approval-status";
import { memberMaySeeProjectId } from "@/lib/member-scope";
import { mcpMayUseProject, mcpRouteAccess } from "@/lib/mcp-access";

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
    if (!detail || !mcpMayUseProject(scoped.access, detail.approval.projectId)) {
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
    // Approvals are a human gate. This endpoint is MCP-reachable, but an agent
    // must never resolve its own approval (or forge a human audit trail), so it
    // requires a real logged-in user session and ignores any caller-supplied
    // resolver id in favour of the authenticated one.
    let ctx;
    try {
        ctx = await requireRole("member")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }

    try {
        const { id } = await params;
        // A restricted member decides only approvals on projects they can see.
        const current = await getApprovalDetail(ctx.companyId, id);
        if (!current || !(await memberMaySeeProjectId(ctx.companyId, ctx.scope, current.approval.projectId))) {
            return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        }
        const body = await _req.json();
        const { status, resolutionNote } = body;

        if (status !== "approved" && status !== "rejected" && status !== "dismissed") {
            return NextResponse.json({ error: "status must be approved, rejected, or dismissed" }, { status: 400 });
        }

        const approval = await resolveApproval({
            companyId: ctx.companyId,
            approvalId: id,
            resolverUserId: ctx.userId,
            status,
            resolutionNote: resolutionNote || null,
        });

        if (!approval) {
            return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        }

        return NextResponse.json({ approval });
    } catch (error) {
        console.error("MCP approval resolve error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
