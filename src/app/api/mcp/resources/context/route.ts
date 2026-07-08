import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { resolveCompanyBrainContext } from "@/lib/resources";

export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const companyId = auth.companyToken!.companyId;
  const { searchParams } = new URL(req.url);
  const agentParam = searchParams.get("agentId");
  const agentId = agentParam ? await resolveAgentId(companyId, agentParam) : null;
  const resourceIds = searchParams.getAll("resourceId").flatMap((value) => value.split(",").filter(Boolean));
  const maxChars = Number(searchParams.get("maxChars") || "12000");
  const context = await resolveCompanyBrainContext({
    companyId,
    customerId: searchParams.get("customerId"),
    projectId: searchParams.get("projectId"),
    agentId,
    resourceIds,
    maxChars: Number.isFinite(maxChars) ? maxChars : 12000,
  });
  return NextResponse.json(context);
}
