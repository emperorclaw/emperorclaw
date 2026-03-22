import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { createScopedResource, listScopedResources, resolveResourceScope } from "@/lib/resources";
import { scopedResources } from "@/db/schema";

function sanitizeResource(resource: typeof scopedResources.$inferSelect) {
  return {
    ...resource,
    ...resolveResourceScope(resource),
    secretJson: undefined,
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

    const internalAgentId = agentId ? await resolveAgentId(companyId, agentId) : null;
    const resource = await createScopedResource({
      companyId,
      scopeType: internalAgentId ? "agent" : projectId ? "project" : customerId ? "customer" : "company",
      scopeId: internalAgentId || projectId || customerId || null,
      name,
      displayName: body.displayName || null,
      resourceType,
      provider,
      configJson: configJson || {},
      secretJson: secretJson || {},
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
