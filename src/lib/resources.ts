import { randomUUID } from "crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { resourceAccessLogs, scopedResources } from "@/db/schema";

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

export function normalizeResourceType(input: unknown): ResourceType {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  if (RESOURCE_TYPES.includes(value as ResourceType)) {
    return value as ResourceType;
  }
  return "external_account";
}

export async function listScopedResources(input: {
  companyId: string;
  scopeType?: string | null;
  scopeId?: string | null;
  provider?: string | null;
  resourceType?: string | null;
  status?: string | null;
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
  configJson?: Record<string, unknown> | null;
  secretJson?: Record<string, unknown> | null;
  status?: string | null;
  ownership?: string | null;
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
    configJson: input.configJson || {},
    secretJson: input.secretJson || {},
    status: input.status || "active",
    ownership: input.ownership || "managed",
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
    configJson: Record<string, unknown>;
    secretJson: Record<string, unknown>;
    status: string;
    ownership: string;
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
    configJson: input.patch.configJson ?? existing.configJson,
    secretJson: input.patch.secretJson ?? existing.secretJson,
    status: input.patch.status ?? existing.status,
    ownership: input.patch.ownership ?? existing.ownership,
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
}) {
  const resource = await getScopedResource(input.companyId, input.resourceId);
  if (!resource) {
    throw new Error("Resource not found");
  }

  if (resource.status !== "active") {
    throw new Error("Resource is not active");
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

export function resolveResourceScope(resource: {
  scopeType?: string | null;
  scopeId?: string | null;
}) {
  return {
    scopeType: normalizeScopeType(resource.scopeType),
    scopeId: resource.scopeId || null,
  };
}
