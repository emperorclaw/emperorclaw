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
  // Clamp caller-supplied ceilings: without a cap, ?maxChars=1000000000 makes
  // the resolver emit the entire vault into one prompt on every agent turn.
  const DEFAULT_MAX_CHARS = 12000;
  const MAX_CONTEXT_CHARS = 48000;
  const rawMaxChars = Number(searchParams.get("maxChars") || DEFAULT_MAX_CHARS);
  const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars > 0 ? Math.min(rawMaxChars, MAX_CONTEXT_CHARS) : DEFAULT_MAX_CHARS;
  // Optional per-note ceiling. Omitted, it falls back to
  // EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE and then the built-in default.
  const rawMaxCharsPerResource = Number(searchParams.get("maxCharsPerResource") || "");
  const maxCharsPerResource = Number.isFinite(rawMaxCharsPerResource) && rawMaxCharsPerResource > 0
    ? Math.min(rawMaxCharsPerResource, MAX_CONTEXT_CHARS)
    : undefined;
  const context = await resolveCompanyBrainContext({
    companyId,
    customerId: customerIdParam,
    projectId: projectIdParam,
    agentId,
    resourceIds,
    tagFilters,
    maxChars,
    maxCharsPerResource,
  });
  return NextResponse.json(context);
}
