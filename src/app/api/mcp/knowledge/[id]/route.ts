import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { getVisibleKnowledgeNote, resolveResourceScope, toPublicResource } from "@/lib/resources";

/**
 * One full Knowledge note (body included), scope-checked with the phase-0
 * rule and stripped of secret material. Same contract as GET
 * /api/mcp/resources/{id}; provided here so bridges have a name that matches
 * the lean Tier-2 tools.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const companyId = auth.companyToken!.companyId;

  try {
    const { id } = await params;
    const agentParam = auth.companyToken!.agentId ?? req.nextUrl.searchParams.get("agentId");
    const agentId = agentParam ? await resolveAgentId(companyId, agentParam) : null;

    const resource = await getVisibleKnowledgeNote({ companyId, resourceId: id, agentId });
    // Out-of-scope and missing are both 404 so scope is not enumerable.
    if (!resource) return NextResponse.json({ error: "Resource not found" }, { status: 404 });

    return NextResponse.json({
      resource: { ...toPublicResource(resource), ...resolveResourceScope(resource) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
