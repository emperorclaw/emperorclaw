import { randomUUID } from "crypto";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { resourceAccessLogs, scopedResources } from "@/db/schema";
import type { McpTaskScopeContext } from "@/lib/mcp";

export const RESOURCE_SCOPE_TYPES = ["company", "customer", "project", "agent"] as const;
export const RESOURCE_TYPES = [
  "mailbox",
  "identity",
  "template",
  "billing_profile",
  "external_account",
  "knowledge_base",
] as const;

export type ResourceScopeType = (typeof RESOURCE_SCOPE_TYPES)[number];
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export function normalizeScopeType(input: unknown): ResourceScopeType {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (RESOURCE_SCOPE_TYPES.includes(value as ResourceScopeType)) {
    return value as ResourceScopeType;
  }
  return "company";
}

export function normalizeResourceType(input: unknown): string {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  return value || "external_account";
}

export async function listScopedResources(input: {
  companyId: string;
  scopeType?: string | null;
  scopeId?: string | null;
  provider?: string | null;
  resourceType?: string | null;
  status?: string | null;
  name?: string | null;
  displayName?: string | null;
  search?: string | null;
  isShared?: boolean | null;
}) {
  const conditions = [
    eq(scopedResources.companyId, input.companyId),
    isNull(scopedResources.deletedAt),
  ];

  if (input.scopeType) conditions.push(eq(scopedResources.scopeType, normalizeScopeType(input.scopeType)));
  if (input.scopeId) conditions.push(eq(scopedResources.scopeId, input.scopeId));
  if (input.provider) conditions.push(eq(scopedResources.provider, input.provider));
  if (input.resourceType) conditions.push(eq(scopedResources.resourceType, normalizeResourceType(input.resourceType)));
  if (input.status) conditions.push(eq(scopedResources.status, input.status));
  if (input.isShared !== undefined && input.isShared !== null) conditions.push(eq(scopedResources.isShared, input.isShared));
  if (input.name) conditions.push(ilike(scopedResources.name, `%${input.name}%`));
  if (input.displayName) conditions.push(ilike(scopedResources.displayName, `%${input.displayName}%`));
  if (input.search) {
    conditions.push(or(
      ilike(scopedResources.name, `%${input.search}%`),
      ilike(scopedResources.displayName, `%${input.search}%`)
    ) as any);
  }

  return db.select().from(scopedResources)
    .where(and(...conditions))
    .orderBy(desc(scopedResources.updatedAt));
}

export async function getScopedResource(companyId: string, resourceId: string) {
  const [resource] = await db.select().from(scopedResources).where(and(
    eq(scopedResources.companyId, companyId),
    eq(scopedResources.id, resourceId),
    isNull(scopedResources.deletedAt),
  )).limit(1);

  return resource || null;
}

export async function createScopedResource(input: {
  companyId: string;
  scopeType: string;
  scopeId?: string | null;
  provider: string;
  resourceType: string;
  name: string;
  displayName?: string | null;
  configText?: string | null;
  secretText?: string | null;
  status?: string | null;
  ownership?: string | null;
  isShared?: boolean;
}) {
  const [resource] = await db.insert(scopedResources).values({
    id: randomUUID(),
    companyId: input.companyId,
    scopeType: normalizeScopeType(input.scopeType),
    scopeId: input.scopeId || null,
    provider: input.provider,
    resourceType: normalizeResourceType(input.resourceType),
    name: input.name,
    displayName: input.displayName || null,
    configText: input.configText || "",
    secretText: input.secretText || "",
    status: input.status || "active",
    ownership: input.ownership || "managed",
    isShared: input.isShared ?? false,
  }).returning();

  return resource;
}

export async function updateScopedResource(input: {
  companyId: string;
  resourceId: string;
  patch: Partial<{
    scopeType: string;
    scopeId: string | null;
    provider: string;
    resourceType: string;
    name: string;
    displayName: string | null;
    configText: string;
    secretText: string;
    status: string;
    ownership: string;
    isShared: boolean;
  }>;
}) {
  const existing = await getScopedResource(input.companyId, input.resourceId);
  if (!existing) return null;

  const [resource] = await db.update(scopedResources).set({
    scopeType: input.patch.scopeType ? normalizeScopeType(input.patch.scopeType) : existing.scopeType,
    scopeId: input.patch.scopeId === undefined ? existing.scopeId : input.patch.scopeId,
    provider: input.patch.provider ?? existing.provider,
    resourceType: input.patch.resourceType ? normalizeResourceType(input.patch.resourceType) : existing.resourceType,
    name: input.patch.name ?? existing.name,
    displayName: input.patch.displayName === undefined ? existing.displayName : input.patch.displayName,
    configText: input.patch.configText ?? existing.configText,
    secretText: input.patch.secretText ?? existing.secretText,
    status: input.patch.status ?? existing.status,
    ownership: input.patch.ownership ?? existing.ownership,
    isShared: input.patch.isShared ?? existing.isShared,
    updatedAt: new Date(),
  }).where(eq(scopedResources.id, existing.id)).returning();

  return resource;
}

export async function archiveScopedResource(companyId: string, resourceId: string) {
  const existing = await getScopedResource(companyId, resourceId);
  if (!existing) return null;

  const [resource] = await db.update(scopedResources).set({
    status: "archived",
    deletedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(scopedResources.id, existing.id)).returning();

  return resource;
}

export async function leaseScopedResource(input: {
  companyId: string;
  resourceId: string;
  agentId?: string | null;
  sessionId?: string | null;
  taskId?: string | null;
  reason?: string | null;
  task?: McpTaskScopeContext | null;
}) {
  const resource = await getScopedResource(input.companyId, input.resourceId);
  if (!resource) {
    throw new Error("Resource not found");
  }

  if (resource.status !== "active") {
    throw new Error("Resource is not active");
  }

  const accessViolation = getResourceLeaseAccessViolation(resource, {
    callerAgentId: input.agentId || null,
    task: input.task || null,
  });

  if (accessViolation) {
    await db.insert(resourceAccessLogs).values({
      companyId: input.companyId,
      resourceId: resource.id,
      agentId: input.agentId || null,
      sessionId: input.sessionId || null,
      taskId: input.taskId || null,
      action: "lease",
      status: "forbidden",
      reason: accessViolation,
      metadataJson: {
        provider: resource.provider,
        resourceType: resource.resourceType,
        scopeType: resource.scopeType,
        scopeId: resource.scopeId,
        ownership: resource.ownership,
      },
    });

    throw new Error(`Access denied: ${accessViolation}`);
  }

  await db.insert(resourceAccessLogs).values({
    companyId: input.companyId,
    resourceId: resource.id,
    agentId: input.agentId || null,
    sessionId: input.sessionId || null,
    taskId: input.taskId || null,
    action: "lease",
    status: "success",
    reason: input.reason || null,
    metadataJson: {
      provider: resource.provider,
      resourceType: resource.resourceType,
      scopeType: resource.scopeType,
      scopeId: resource.scopeId,
      ownership: resource.ownership,
    },
  });

  const [updated] = await db.update(scopedResources).set({
    lastUsedAt: new Date(),
    lastFailureAt: null,
    lastFailureReason: null,
    updatedAt: new Date(),
  }).where(eq(scopedResources.id, resource.id)).returning();

  return updated;
}

function getResourceLeaseAccessViolation(
  resource: typeof scopedResources.$inferSelect,
  context: {
    callerAgentId: string | null;
    task: McpTaskScopeContext | null;
  }
) {
  const scope = normalizeScopeType(resource.scopeType);
  const scopeId = resource.scopeId || null;

  if (scope === "company") {
    return null;
  }

  if (scope === "agent") {
    if (!context.callerAgentId) {
      return "agent-scoped resources require an authenticated runtime agent";
    }
    if (!scopeId || scopeId !== context.callerAgentId) {
      return "resource is scoped to a different agent";
    }
    return null;
  }

  if (!context.task) {
    return `${scope}-scoped resources require matching task context`;
  }

  if (scope === "project") {
    return context.task.projectId === scopeId ? null : "resource is outside the active task project scope";
  }

  if (scope === "customer") {
    return context.task.customerId === scopeId ? null : "resource is outside the active task customer scope";
  }

  return "resource scope is not leasable";
}

export function resolveResourceScope(resource: {
  scopeType?: string | null;
  scopeId?: string | null;
}) {
  return {
    scopeType: normalizeScopeType(resource.scopeType),
    scopeId: resource.scopeId || null,
  };
}
