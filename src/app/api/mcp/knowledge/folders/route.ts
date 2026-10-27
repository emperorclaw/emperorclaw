import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { mcpRouteAccess } from "@/lib/mcp-access";
import { listKnowledgeFolders } from "@/lib/knowledge-folders";

/**
 * The Knowledge & Rules folder tree the caller may see, with note counts —
 * the REST twin of the list_knowledge_folders MCP tool. Agents read it before
 * filing a note so they reuse the existing folders.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const companyId = auth.companyToken!.companyId;

  try {
    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId"));
    if (scoped.response) return scoped.response;
    return NextResponse.json(await listKnowledgeFolders(companyId, scoped.access));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
