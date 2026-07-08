import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { createResourceProposal } from "@/lib/resources";

export async function POST(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const companyId = auth.companyToken!.companyId;
  const body = await req.json().catch(() => ({}));
  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const proposedByAgentId = body.agentId ? await resolveAgentId(companyId, body.agentId) : null;
  const proposal = await createResourceProposal({
    companyId,
    proposedByAgentId,
    scopeType: body.scopeType || "company",
    scopeId: body.scopeId || null,
    targetResourceId: body.targetResourceId || null,
    action: body.action || "create",
    title: body.title,
    proposedText: body.proposedText || "",
    reason: body.reason || null,
    evidenceJson: body.evidenceJson || {},
  });
  return NextResponse.json({ proposal }, { status: 201 });
}
