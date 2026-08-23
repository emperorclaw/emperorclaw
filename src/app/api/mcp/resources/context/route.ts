import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { resolveCompanyBrainContext } from "@/lib/resources";
import { loadAgentScopeContext, isProjectAllowed, isCustomerAllowed } from "@/lib/agent-scope";

export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const companyId = auth.companyToken!.companyId;
  const { searchParams } = new URL(req.url);
  const agentParam = searchParams.get("agentId");
  const agentId = agentParam ? await resolveAgentId(companyId, agentParam) : null;
  const customerIdParam = searchParams.get("customerId");
  const projectIdParam = searchParams.get("projectId");
  if (agentId && (customerIdParam || projectIdParam)) {
    const { allowedProjectIds, allowedCustomerIds } = await loadAgentScopeContext(companyId, agentId);
    const allowed =
      (!projectIdParam || isProjectAllowed(allowedProjectIds, projectIdParam)) &&
      (!customerIdParam || isCustomerAllowed(allowedCustomerIds, customerIdParam));
    if (!allowed) {
      return NextResponse.json({ error: "Scope not found" }, { status: 404 });
    }
  }
  const resourceIds = searchParams.getAll("resourceId").flatMap((value) => value.split(",").filter(Boolean));
  const tagFilters = searchParams.getAll("tag").flatMap((value) => value.split(",").filter(Boolean));
  const maxChars = Number(searchParams.get("maxChars") || "12000");
  // Optional per-note ceiling. Omitted, it falls back to
  // EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE and then the built-in default.
  const maxCharsPerResource = Number(searchParams.get("maxCharsPerResource") || "");
  const context = await resolveCompanyBrainContext({
    companyId,
    customerId: customerIdParam,
    projectId: projectIdParam,
    agentId,
    resourceIds,
    tagFilters,
    maxChars: Number.isFinite(maxChars) ? maxChars : 12000,
    maxCharsPerResource: Number.isFinite(maxCharsPerResource) && maxCharsPerResource > 0 ? maxCharsPerResource : undefined,
  });
  return NextResponse.json(context);
}
