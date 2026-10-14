import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { searchVisibleKnowledgeNotes } from "@/lib/resources";

/**
 * Bounded knowledge search returning index lines (never bodies), matching
 * name/display name/summary/content. Parameterized ILIKE, capped at 20 results.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const companyId = auth.companyToken!.companyId;

  try {
    const { searchParams } = new URL(req.url);
    const query = (searchParams.get("q") || "").trim();
    const agentParam = auth.companyToken!.agentId ?? searchParams.get("agentId");
    const agentId = agentParam ? await resolveAgentId(companyId, agentParam) : null;
    const rawLimit = Number.parseInt(searchParams.get("limit") || "10", 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 10;

    if (!query) return NextResponse.json({ query, count: 0, results: [] });

    const results = await searchVisibleKnowledgeNotes({ companyId, query, agentId, limit });
    return NextResponse.json({ query, count: results.length, results });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
