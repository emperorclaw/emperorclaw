import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { buildResourceFolderTree, createScopedResource, listScopedResources, resolveResourceScope, resourceNameError, toPublicResource, type PublicResource } from "@/lib/resources";
import { loadAgentScopeContext, isProjectAllowed, isCustomerAllowed } from "@/lib/agent-scope";
import { mcpAccessForAgent, mcpMayWriteResourceScope, mcpRouteAccess } from "@/lib/mcp-access";
import {
  KNOWLEDGE_RESOURCE_TYPE,
  KnowledgeFolderError,
  agentMayUseKnowledgeFolder,
  filterNotesInUsableFolders,
  parseKnowledgeFolder,
  resolveNewKnowledgeNoteFolder,
} from "@/lib/knowledge-folders";
import { mcpRequestActor } from "@/lib/audit";

function sanitizeResource(resource: PublicResource) {
  return {
    ...toPublicResource(resource),
    ...resolveResourceScope(resource),
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
  // An agent-bound token always acts as its own agent; ?agentId= only applies to company-wide tokens.
  const agentId = auth.companyToken!.agentId ?? searchParams.get("agentId");
  const scopeType = searchParams.get("scopeType");
  const scopeId = searchParams.get("scopeId");
  const resourceType = searchParams.get("resourceType");
  const status = searchParams.get("status");
  const isSharedParam = searchParams.get("isShared");
  const isShared = isSharedParam === null ? undefined : isSharedParam === "true";

  try {
    const internalAgentId = agentId ? await resolveAgentId(companyId, agentId) : null;

    // agentId also doubles as "the acting agent" for restricted-scope checks.
    // Whatever project/customer the caller explicitly asked to see (via projectId/
    // customerId, or explicit scopeType+scopeId) must be within its grants — the
    // agent's own private "agent" scope and the company-wide default are exempt.
    if (internalAgentId) {
      const explicitProjectId = projectId || (scopeType === "project" ? scopeId : null);
      const explicitCustomerId = customerId || (scopeType === "customer" ? scopeId : null);
      if (explicitProjectId || explicitCustomerId) {
        const { allowedProjectIds, allowedCustomerIds } = await loadAgentScopeContext(companyId, internalAgentId);
        const allowed =
          (!explicitProjectId || isProjectAllowed(allowedProjectIds, explicitProjectId)) &&
          (!explicitCustomerId || isCustomerAllowed(allowedCustomerIds, explicitCustomerId));
        if (!allowed) {
          return NextResponse.json({ error: "Scope not found" }, { status: 404 });
        }
      }
    }

    // `path` (exact folder), `pathPrefix` and its agent-facing alias `folder`
    // ("this folder and its subfolders") are all parsed strictly, so traversal
    // or an over-long path is a 400 rather than silently rewritten.
    const rawPath = searchParams.get("path");
    const rawPrefix = searchParams.get("pathPrefix") ?? searchParams.get("folder");
    const path = rawPath === null ? null : parseKnowledgeFolder(rawPath);
    const pathPrefix = rawPrefix === null ? null : parseKnowledgeFolder(rawPrefix);

    // A folder the acting agent may not use matches nothing, exactly like a
    // folder that does not exist.
    const access = internalAgentId && (path || pathPrefix) ? await mcpAccessForAgent(companyId, internalAgentId) : null;
    if (access) {
      for (const folder of [path, pathPrefix]) {
        if (folder && !(await agentMayUseKnowledgeFolder(companyId, access, folder))) {
          return NextResponse.json({ resources: [], folders: [] });
        }
      }
    }

    const matched = await listScopedResources({
      companyId,
      scopeType: internalAgentId ? "agent" : scopeType || (projectId ? "project" : customerId ? "customer" : null),
      scopeId: internalAgentId || projectId || customerId || scopeId,
      resourceType,
      provider: searchParams.get("provider"),
      name: searchParams.get("name"),
      displayName: searchParams.get("displayName"),
      search: searchParams.get("search") || searchParams.get("q"),
      status,
      isShared,
      path,
      pathPrefix,
    });
    const resources = access ? await filterNotesInUsableFolders(companyId, access, matched) : matched;

    // The folder tree is derived from whatever this query matched, so it stays
    // consistent with the filters the caller actually applied.
    return NextResponse.json({
      resources: resources.map(sanitizeResource),
      folders: buildResourceFolderTree(resources),
    });
  } catch (error) {
    if (error instanceof KnowledgeFolderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
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
      isShared,
    } = body;

    if (!name || !resourceType || !provider) {
      return NextResponse.json({ error: "name, resourceType, and provider are required" }, { status: 400 });
    }
    const nameError = resourceNameError(body);
    if (nameError) return NextResponse.json({ error: nameError }, { status: 400 });

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
        if (!finalScopeId) {
          return NextResponse.json({ error: "scopeId is required for agent scope" }, { status: 400 });
        }
        finalScopeId = await resolveAgentId(companyId, finalScopeId);
      }
      // Note: customer/project scope validation would happen in createScopedResource
    } else {
      // Legacy behavior: infer from agentId, projectId, customerId fields
      const internalAgentId = agentId ? await resolveAgentId(companyId, agentId) : null;
      finalScopeType = internalAgentId ? "agent" : projectId ? "project" : customerId ? "customer" : "company";
      finalScopeId = internalAgentId || projectId || customerId || null;
    }

    // Validate agent scope requires a scopeId
    if (finalScopeType === "agent" && !finalScopeId) {
      return NextResponse.json({ error: "scopeId is required for agent scope" }, { status: 400 });
    }

    // The writer's scope comes from the token binding (or the named agent for
    // an operator token): it may only write into projects/customers it can
    // see, and only into its own private agent scope.
    const scoped = await mcpRouteAccess(companyId, auth.companyToken!, agentId);
    if (scoped.response) return scoped.response;
    if (!mcpMayWriteResourceScope(scoped.access, finalScopeType, finalScopeId)) {
      return NextResponse.json({ error: "Scope is outside this agent's scope" }, { status: 403 });
    }

    // Knowledge notes accept `folder` (strict, see list_knowledge_folders) or the
    // legacy `path`, are scope-checked against the folder too, and default into
    // the customer's/project's folder when the vault uses that convention.
    const path = resourceType === KNOWLEDGE_RESOURCE_TYPE
      ? await resolveNewKnowledgeNoteFolder({
        companyId, access: scoped.access, folder: body.folder, legacyPath: body.path,
        scopeType: finalScopeType, scopeId: finalScopeId,
      })
      : (body.folder ?? body.path) || null;

    const resource = await createScopedResource({
      companyId,
      scopeType: finalScopeType,
      scopeId: finalScopeId,
      name,
      displayName: body.displayName || null,
      path,
      resourceType,
      provider,
      configText: configJson || body.configText || "",
      secretText: secretJson || body.secretText || "",
      status: status || "active",
      ownership: leaseMode === "local-runtime" ? "local-runtime" : body.ownership || "managed",
      isShared: typeof isShared === "boolean" ? isShared : undefined,
      actor: await mcpRequestActor(companyId, auth.companyToken!, agentId),
    });

    return NextResponse.json({ resource: sanitizeResource(resource) }, { status: 201 });
  } catch (error) {
    if (error instanceof KnowledgeFolderError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Internal Server Error";
    const statusCode = message.startsWith("Agent not found") ? 404 : 500;
    return NextResponse.json({ error: message }, { status: statusCode });
  }
}
