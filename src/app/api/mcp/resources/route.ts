import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { createScopedResource, listScopedResources, resolveResourceScope } from "@/lib/resources";
import { scopedResources } from "@/db/schema";

function sanitizeResource(resource: typeof scopedResources.$inferSelect) {
  return {
    ...resource,
    ...resolveResourceScope(resource),
    secretText: undefined,
  };
}

export async function GET(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { searchParams } = new URL(req.url);
  const customerId = searchParams.get("customerId");
  const projectId = searchParams.get("projectId");
  const agentId = searchParams.get("agentId");
  const scopeType = searchParams.get("scopeType");
  const scopeId = searchParams.get("scopeId");
  const resourceType = searchParams.get("resourceType");
  const status = searchParams.get("status");

  try {
    const internalAgentId = agentId ? await resolveAgentId(companyId, agentId) : null;
    const resources = await listScopedResources({
      companyId,
      scopeType: internalAgentId ? "agent" : scopeType || (projectId ? "project" : customerId ? "customer" : null),
      scopeId: internalAgentId || projectId || customerId || scopeId,
      resourceType,
      provider: searchParams.get("provider"),
      name: searchParams.get("name"),
      displayName: searchParams.get("displayName"),
      search: searchParams.get("search") || searchParams.get("q"),
      status,
    });

    return NextResponse.json({ resources: resources.map(sanitizeResource) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}

export async function POST(req: NextRequest) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const companyId = auth.companyToken!.companyId;
    const body = await req.json();
    const {
      customerId,
      projectId,
      agentId,
      scopeType,
      scopeId,
      name,
      resourceType,
      provider,
      configJson,
      secretJson,
      status,
      leaseMode,
    } = body;

    if (!name || !resourceType || !provider) {
      return NextResponse.json({ error: "name, resourceType, and provider are required" }, { status: 400 });
    }

    // Determine scope based on explicit scopeType/scopeId or legacy fields
    let finalScopeType: "company" | "customer" | "project" | "agent";
    let finalScopeId: string | null = null;

    if (scopeType && scopeId) {
      // Use explicit scopeType/scopeId if provided
      if (!["company", "customer", "project", "agent"].includes(scopeType)) {
        return NextResponse.json({ error: "scopeType must be one of: company, customer, project, agent" }, { status: 400 });
      }
      finalScopeType = scopeType as "company" | "customer" | "project" | "agent";
      finalScopeId = scopeId;
      
      // Validate agent scope
      if (finalScopeType === "agent") {
        finalScopeId = await resolveAgentId(companyId, finalScopeId);
      }
      // Note: customer/project scope validation would happen in createScopedResource
    } else {
      // Legacy behavior: infer from agentId, projectId, customerId fields
      const internalAgentId = agentId ? await resolveAgentId(companyId, agentId) : null;
      finalScopeType = internalAgentId ? "agent" : projectId ? "project" : customerId ? "customer" : "company";
      finalScopeId = internalAgentId || projectId || customerId || null;
    }

    const resource = await createScopedResource({
      companyId,
      scopeType: finalScopeType,
      scopeId: finalScopeId,
      name,
      displayName: body.displayName || null,
      resourceType,
      provider,
      configText: configJson || body.configText || "",
      secretText: secretJson || body.secretText || "",
      status: status || "active",
      ownership: leaseMode === "local-runtime" ? "local-runtime" : body.ownership || "managed",
    });

    return NextResponse.json({ resource: sanitizeResource(resource) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
