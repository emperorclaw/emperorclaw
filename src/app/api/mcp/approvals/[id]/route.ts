import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { requireRole, AuthError } from "@/lib/roles";
import { getApprovalDetail, resolveApproval } from "@/lib/approvals";

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
    if (!detail) {
        return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    return NextResponse.json(detail);
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
        const body = await _req.json();
        const { status, resolutionNote } = body;

        if (status !== "approved" && status !== "rejected") {
            return NextResponse.json({ error: "status must be approved or rejected" }, { status: 400 });
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
