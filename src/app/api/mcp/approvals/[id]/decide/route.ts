import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { APPROVER_TOKEN_REQUIRED, ApprovalDecisionError, decideApprovalAsAgent } from "@/lib/approvals";

/**
 * POST /api/mcp/approvals/{id}/decide { decision: "approve" | "deny", note? }
 * A boss agent decides an ask routed to it (approval routing; the REST twin
 * of the decide_approval MCP tool). Only a token bound to the deciding agent:
 * a company-wide token is refused (403), whatever agent it names, so legacy
 * bridges on shared tokens fail closed and the ask escalates to a person.
 * Its authority is checked again (lib/approvals.ts decideApprovalAsAgent):
 * 404 when the ask is not routed to it, 403 when it may not decide it now
 * (or it is the requester), 409 when someone already did.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;
    const agentId = auth.companyToken!.agentId ?? null;
    if (!agentId) return NextResponse.json({ error: APPROVER_TOKEN_REQUIRED }, { status: 403 });
    const { id } = await params;
    const body = await req.json().catch(() => null) as { decision?: unknown; note?: unknown } | null;
    if (body?.decision !== "approve" && body?.decision !== "deny") {
        return NextResponse.json({ error: "decision must be approve or deny" }, { status: 400 });
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
        return NextResponse.json({ error: "note must be a string" }, { status: 400 });
    }
    try {
        const approval = await decideApprovalAsAgent({ companyId, approvalId: id, agentId, decision: body.decision, note: typeof body.note === "string" ? body.note : null });
        return NextResponse.json({ approval: { id: approval.id, status: approval.status, resolutionNote: approval.resolutionNote } });
    } catch (error) {
        if (error instanceof ApprovalDecisionError) return NextResponse.json({ error: error.message }, { status: error.status });
        console.error("Approval decide error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
