import { NextRequest, NextResponse } from "next/server";
import { normalizeCompanyTokenScope, verifyMcpToken } from "@/lib/mcp";
import { getAgentRequest } from "@/lib/agent-requests";

/** One request: status, the agent's replies, and the task's output. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req, { allowRequestsScope: true });
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const token = auth.companyToken!;
    const { id } = await params;
    const request = await getAgentRequest(token.companyId, id, normalizeCompanyTokenScope(token.scope) === "requests" ? token.id : null);
    if (!request) return NextResponse.json({ error: "Request not found" }, { status: 404 });
    return NextResponse.json({ request });
}
