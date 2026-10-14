import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { buildLeanContext } from "@/lib/lean-context";

/**
 * The lean per-session context for a bridge: the versioned kernel, the
 * company knowledge index, the always-block, and the roster. The response
 * carries an ETag (a content hash) so a bridge can send If-None-Match and get
 * a 304 instead of re-sending identical context every turn.
 */
export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const companyId = auth.companyToken!.companyId;

  try {
    const { searchParams } = new URL(req.url);
    // An agent-bound token always acts as its own agent; ?agentId= only applies
    // to company-wide tokens.
    const agentParam = auth.companyToken!.agentId ?? searchParams.get("agentId");
    const agentId = agentParam ? await resolveAgentId(companyId, agentParam) : null;

    const context = await buildLeanContext({ companyId, agentId });
    const etag = `"${context.hash}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers: { ETag: etag } });
    }

    return NextResponse.json(
      {
        version: context.version,
        kernel: context.kernel,
        knowledgeIndex: context.knowledgeIndex,
        alwaysBlock: context.alwaysBlock,
        roster: context.roster,
        alwaysOverBudget: context.alwaysOverBudget,
        alwaysUsedChars: context.alwaysUsedChars,
      },
      { headers: { ETag: etag, "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
