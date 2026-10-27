import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { archiveScopedResource, getScopedResource, resolveResourceScope, resourceNameError, toPublicResource, updateScopedResource, type PublicResource } from "@/lib/resources";
import { mcpMayUseResource, mcpMayWriteResourceScope, mcpRouteAccess, resolveMcpAgentAccess } from "@/lib/mcp-access";
import { KNOWLEDGE_RESOURCE_TYPE, KnowledgeFolderError, resolveMovedKnowledgeNoteFolder } from "@/lib/knowledge-folders";
import { mcpRequestActor } from "@/lib/audit";

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
    const nameError = resourceNameError(patch);
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });

    const existing = await getScopedResource(companyId, id);
    if (existing && await isResourceOutOfScope(companyId, auth.companyToken!, patch.agentId, existing)) {
      return NextResponse.json({ error: "Resource is outside this agent's scope" }, { status: 403 });
    }
    if (existing) {
      const scoped = await mcpRouteAccess(companyId, auth.companyToken!, patch.agentId);
      if (scoped.response) return scoped.response;
      // Re-scoping a note is a write into the new scope: same rule as creating one.
      if ((patch.scopeType !== undefined || patch.scopeId !== undefined) && !mcpMayWriteResourceScope(
        scoped.access,
        (patch.scopeType as string | undefined) ?? existing.scopeType,
        patch.scopeId === undefined ? existing.scopeId : (patch.scopeId as string | null),
      )) {
        return NextResponse.json({ error: "Scope is outside this agent's scope" }, { status: 403 });
      }
      // `folder` (strict) or the legacy `path` moves a note; both are scope-checked.
      if (existing.resourceType === KNOWLEDGE_RESOURCE_TYPE) {
        const path = await resolveMovedKnowledgeNoteFolder({ companyId, access: scoped.access, folder: patch.folder, legacyPath: patch.path });
        if (path !== undefined) patch.path = path;
      } else if (patch.folder !== undefined) {
        patch.path = patch.folder;
      }
      delete patch.folder;
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
      actor: await mcpRequestActor(companyId, auth.companyToken!, patch.agentId),
    });

    if (!resource) {
      return NextResponse.json({ error: "Resource not found" }, { status: 404 });
    }

    return NextResponse.json({ resource: sanitizeResource(resource) });
  } catch (error) {
    if (error instanceof KnowledgeFolderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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

  const resource = await archiveScopedResource(companyId, id, await mcpRequestActor(companyId, auth.companyToken!, req.nextUrl.searchParams.get("agentId")));

  if (!resource) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }

  return NextResponse.json({ resource: sanitizeResource(resource) });
}
