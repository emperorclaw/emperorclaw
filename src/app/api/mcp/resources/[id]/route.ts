import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { archiveScopedResource, getScopedResource, resolveResourceScope, toPublicResource, updateScopedResource, type PublicResource } from "@/lib/resources";
import { mcpMayUseResource, resolveMcpAgentAccess } from "@/lib/mcp-access";

function sanitizeResource(resource: PublicResource) {
  return {
    ...toPublicResource(resource),
    ...resolveResourceScope(resource),
  };
}

/** true when the resource is outside the caller's scope (token binding or named agent). */
async function isResourceOutOfScope(
  companyId: string,
  token: { agentId?: string | null },
  agentIdParam: unknown,
  resource: { scopeType: string; scopeId: string | null },
): Promise<boolean> {
  try {
    const access = await resolveMcpAgentAccess(companyId, token, agentIdParam);
    return !mcpMayUseResource(access, resource);
  } catch {
    return true; // unknown agent or a bound token naming another agent — no access
  }
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

  if (await isResourceOutOfScope(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId"), resource)) {
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

    const existing = await getScopedResource(companyId, id);
    if (existing && await isResourceOutOfScope(companyId, auth.companyToken!, patch.agentId, existing)) {
      return NextResponse.json({ error: "Resource is outside this agent's scope" }, { status: 403 });
    }
    if (patch.agentId) {
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

  const existing = await getScopedResource(companyId, id);
  if (!existing) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }
  if (await isResourceOutOfScope(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId"), existing)) {
    return NextResponse.json({ error: "Resource is outside this agent's scope" }, { status: 403 });
  }

  const resource = await archiveScopedResource(companyId, id);

  if (!resource) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  return NextResponse.json({ resource: sanitizeResource(resource) });
}
