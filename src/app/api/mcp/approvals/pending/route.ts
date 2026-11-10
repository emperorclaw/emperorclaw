import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { APPROVER_TOKEN_REQUIRED, listPendingApprovalsForAgent } from "@/lib/approvals";

/**
 * GET /api/mcp/approvals/pending — the approval requests waiting on this agent
 * as their approver (approval routing; the REST twin of the
 * list_pending_approvals MCP tool). Only a token bound to the agent: a
 * company-wide token is refused (403), whatever agent it names.
 */
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;
    const agentId = auth.companyToken!.agentId ?? null;
    if (!agentId) return NextResponse.json({ error: APPROVER_TOKEN_REQUIRED }, { status: 403 });
    try {
        return NextResponse.json({ approvals: await listPendingApprovalsForAgent(companyId, agentId) });
    } catch (error) {
        console.error("Pending approvals error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
