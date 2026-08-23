import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { archiveScopedResource, getScopedResource, resolveResourceScope, updateScopedResource } from "@/lib/resources";
import { loadAgentScopeContext, isProjectAllowed, isCustomerAllowed } from "@/lib/agent-scope";

function sanitizeResource(resource: any) {
  return {
    ...resource,
    ...resolveResourceScope(resource),
    secretText: undefined,
  };
}

/** null = ok to proceed. Otherwise a resource in scopeType project/customer that the given agent can't reach. */
async function isResourceOutOfScope(companyId: string, agentIdParam: unknown, resource: { scopeType: string; scopeId: string | null }): Promise<boolean> {
  if (typeof agentIdParam !== "string" || !agentIdParam) return false;
  if (resource.scopeType !== "project" && resource.scopeType !== "customer") return false;
  if (!resource.scopeId) return false;
  let resolvedAgentId: string;
  try {
    resolvedAgentId = await resolveAgentId(companyId, agentIdParam);
  } catch {
    return true; // unknown agent — treat as no access
  }
  const { allowedProjectIds, allowedCustomerIds } = await loadAgentScopeContext(companyId, resolvedAgentId);
  return resource.scopeType === "project"
    ? !isProjectAllowed(allowedProjectIds, resource.scopeId)
    : !isCustomerAllowed(allowedCustomerIds, resource.scopeId);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { id } = await params;
  const resource = await getScopedResource(companyId, id);

  if (!resource) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  const agentIdParam = req.nextUrl.searchParams.get("agentId");
  if (await isResourceOutOfScope(companyId, agentIdParam, resource)) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  return NextResponse.json({ resource: sanitizeResource(resource) });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    const companyId = auth.companyToken!.companyId;
    const { id } = await params;
    const body = await req.json();
    const patch = { ...body } as Record<string, unknown>;

    if (patch.agentId) {
      const existing = await getScopedResource(companyId, id);
      if (existing && await isResourceOutOfScope(companyId, patch.agentId, existing)) {
        return NextResponse.json({ error: "Resource is outside this agent's scope" }, { status: 403 });
      }
      patch.agentId = await resolveAgentId(companyId, patch.agentId as string);
    }

    const resource = await updateScopedResource({
      companyId,
      resourceId: id,
      patch: {
        ...patch,
        configText: (patch.configJson || patch.configText) as string,
        secretText: (patch.secretJson || patch.secretText) as string,
      } as any,
    });

    if (!resource) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    return NextResponse.json({ resource: sanitizeResource(resource) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await verifyMcpToken(req);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  const companyId = auth.companyToken!.companyId;
  const { id } = await params;

  const agentIdParam = req.nextUrl.searchParams.get("agentId");
  if (agentIdParam) {
    const existing = await getScopedResource(companyId, id);
    if (!existing) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }
    if (await isResourceOutOfScope(companyId, agentIdParam, existing)) {
      return NextResponse.json({ error: "Resource is outside this agent's scope" }, { status: 403 });
    }
  }

  const resource = await archiveScopedResource(companyId, id);

  if (!resource) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  return NextResponse.json({ resource: sanitizeResource(resource) });
}
