import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { mcpActor } from "@/lib/audit";
import { mcpRouteAccess } from "@/lib/mcp-access";
import type { ViewCaller } from "@/lib/views";

/**
 * The caller of a /api/mcp/views request: the token's bound agent (or, for a
 * company-wide token, the agent it names with ?agentId=) with that agent's
 * scope. The REST twin of the view MCP tools, used by the Hermes plugin.
 *
 * The audit actor and the created_by / updated_by stamps come from the SAME
 * resolution as the scope (resolveMcpAgentAccess), so the agent a view is
 * recorded as built by is exactly the agent later writes are checked against.
 */
export async function viewMcpCaller(req: NextRequest): Promise<{ companyId: string; caller: ViewCaller; tokenId: string; response?: undefined } | { response: NextResponse }> {
    const auth = await verifyMcpToken(req);
    if (auth.error) return { response: NextResponse.json({ error: auth.error }, { status: auth.status }) };
    const token = auth.companyToken!;
    const scoped = await mcpRouteAccess(token.companyId, token, req.nextUrl.searchParams.get("agentId"));
    if (scoped.response) return { response: scoped.response };
    const actor = mcpActor(scoped.access.agentId, token.id);
    return { companyId: token.companyId, caller: { kind: "agent", access: scoped.access, actor }, tokenId: token.id };
}

export async function readJson(req: NextRequest): Promise<Record<string, unknown> | null> {
    const body = await req.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : null;
}
