import { randomUUID } from "crypto";
import { and, desc, eq, ilike, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import {
  resourceAccessLogs,
  resourceLinks,
  resourceProposals,
  resourceTags,
  resourceVersions,
  scopedResources,
} from "@/db/schema";
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

function normalizeBrainKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionsResourceTitle(content: string, title: string) {
  const normalizedTitle = title.trim();
  if (normalizedTitle.length < 6) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(normalizedTitle)}([^A-Za-z0-9]|$)`, "i").test(content);
}

function truncateForContext(value: string, maxChars: number) {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 24)).trimEnd()}\n...[trimmed by Emperor]`;
}

export function parseResourceMarkdownMetadata(markdown: string) {
  const wikilinks = new Set<string>();
  const tags = new Set<string>();
  const linkPattern = /\[\[([^\]\n]+)\]\]/g;
  const tagPattern = /(^|[\s(])#([A-Za-z0-9][A-Za-z0-9/_-]*)/g;
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);

  for (const match of markdown.matchAll(linkPattern)) {
    const raw = match[1]?.split("|")[0]?.trim();
    if (raw) wikilinks.add(raw);
  }

  for (const match of markdown.matchAll(tagPattern)) {
    const raw = match[2]?.trim().toLowerCase();
    if (raw) tags.add(raw);
  }

  if (frontmatter?.[1]) {
    const lines = frontmatter[1].split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const inlineTags = line.match(/^\s*tags\s*:\s*\[(.*)\]\s*$/i);
      if (inlineTags?.[1]) {
        inlineTags[1]
          .split(",")
          .map((tag) => tag.trim().replace(/^['"]|['"]$/g, "").replace(/^#/, "").toLowerCase())
          .filter(Boolean)
          .forEach((tag) => tags.add(tag));
      }

      if (/^\s*tags\s*:\s*$/i.test(line)) {
        for (let childIndex = index + 1; childIndex < lines.length; childIndex += 1) {
          const child = lines[childIndex];
          if (!/^\s+-\s+/.test(child)) break;
          const tag = child.replace(/^\s+-\s+/, "").trim().replace(/^['"]|['"]$/g, "").replace(/^#/, "").toLowerCase();
          if (tag) tags.add(tag);
          index = childIndex;
        }
      }
    }
  }

  return {
    wikilinks: Array.from(wikilinks),
    tags: Array.from(tags),
  };
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
    const searchCondition = or(
      ilike(scopedResources.name, `%${input.search}%`),
      ilike(scopedResources.displayName, `%${input.search}%`)
    );
    if (searchCondition) conditions.push(searchCondition);
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
  changeSummary?: string | null;
  createdByType?: string | null;
  createdById?: string | null;
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

  await createResourceVersion({
    companyId: input.companyId,
    resourceId: resource.id,
    configText: resource.configText,
    changeSummary: input.changeSummary || "Initial Company Brain version",
    createdByType: input.createdByType || "system",
    createdById: input.createdById || null,
  });
  await syncResourceBrainMetadata(input.companyId, resource);

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
    changeSummary: string;
    createdByType: string;
    createdById: string | null;
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

  if (resource.configText !== existing.configText) {
    await createResourceVersion({
      companyId: input.companyId,
      resourceId: resource.id,
      configText: resource.configText,
      changeSummary: input.patch.changeSummary || "Updated Company Brain note",
      createdByType: input.patch.createdByType || "system",
      createdById: input.patch.createdById || null,
    });
  }
  await syncResourceBrainMetadata(input.companyId, resource);

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

export async function createResourceVersion(input: {
  companyId: string;
  resourceId: string;
  configText: string;
  changeSummary?: string | null;
  createdByType?: string | null;
  createdById?: string | null;
}) {
  const [version] = await db.insert(resourceVersions).values({
    companyId: input.companyId,
    resourceId: input.resourceId,
    configText: input.configText || "",
    changeSummary: input.changeSummary || null,
    createdByType: input.createdByType || "system",
    createdById: input.createdById || null,
  }).returning();

  return version;
}

export async function syncResourceBrainMetadata(
  companyId: string,
  resource: typeof scopedResources.$inferSelect,
) {
  const metadata = parseResourceMarkdownMetadata(resource.configText || "");
  await db.delete(resourceLinks).where(eq(resourceLinks.sourceResourceId, resource.id));
  await db.delete(resourceTags).where(eq(resourceTags.resourceId, resource.id));

  if (metadata.tags.length > 0) {
    await db.insert(resourceTags).values(metadata.tags.map((tag) => ({
      companyId,
      resourceId: resource.id,
      tag,
    })));
  }

  const resources = await listScopedResources({ companyId });
  const lookup = new Map<string, typeof scopedResources.$inferSelect>();
  for (const candidate of resources) {
    lookup.set(normalizeBrainKey(candidate.displayName || candidate.name), candidate);
    lookup.set(normalizeBrainKey(candidate.name), candidate);
  }

  const explicitLinks = metadata.wikilinks.map((linkText) => {
    const target = lookup.get(normalizeBrainKey(linkText));
    return {
      companyId,
      sourceResourceId: resource.id,
      targetResourceId: target?.id || null,
      linkText,
      linkType: "wikilink",
    };
  });

  const explicitTargetIds = new Set(explicitLinks.map((link) => link.targetResourceId).filter(Boolean));
  const explicitTexts = new Set(metadata.wikilinks.map((linkText) => normalizeBrainKey(linkText)));
  const inferredLinks = resources
    .filter((candidate) => candidate.id !== resource.id)
    .filter((candidate) => !explicitTargetIds.has(candidate.id))
    .map((candidate) => ({ candidate, title: candidate.displayName || candidate.name }))
    .filter(({ title }) => !explicitTexts.has(normalizeBrainKey(title)))
    .filter(({ title }) => mentionsResourceTitle(resource.configText || "", title))
    .map(({ candidate, title }) => ({
      companyId,
      sourceResourceId: resource.id,
      targetResourceId: candidate.id,
      linkText: title,
      linkType: "inferred",
    }));

  const links = [...explicitLinks, ...inferredLinks];
  if (links.length > 0) {
    await db.insert(resourceLinks).values(links);
  }

  return metadata;
}

export async function listResourceBacklinks(companyId: string, resourceId: string) {
  const [resource, outgoing, backlinks, tags, versions] = await Promise.all([
    getScopedResource(companyId, resourceId),
    db.select().from(resourceLinks).where(and(
      eq(resourceLinks.companyId, companyId),
      eq(resourceLinks.sourceResourceId, resourceId),
    )).orderBy(desc(resourceLinks.createdAt)),
    db.select().from(resourceLinks).where(and(
      eq(resourceLinks.companyId, companyId),
      eq(resourceLinks.targetResourceId, resourceId),
    )).orderBy(desc(resourceLinks.createdAt)),
    db.select().from(resourceTags).where(and(
      eq(resourceTags.companyId, companyId),
      eq(resourceTags.resourceId, resourceId),
    )),
    listResourceVersions(companyId, resourceId),
  ]);

  return { resource, outgoing, backlinks, tags, versions };
}

export async function listResourceVersions(companyId: string, resourceId: string) {
  return db.select().from(resourceVersions).where(and(
    eq(resourceVersions.companyId, companyId),
    eq(resourceVersions.resourceId, resourceId),
  )).orderBy(desc(resourceVersions.createdAt));
}

export async function restoreResourceVersion(input: {
  companyId: string;
  resourceId: string;
  versionId: string;
  userId?: string | null;
}) {
  const [version] = await db.select().from(resourceVersions).where(and(
    eq(resourceVersions.companyId, input.companyId),
    eq(resourceVersions.id, input.versionId),
    eq(resourceVersions.resourceId, input.resourceId),
  )).limit(1);
  if (!version) return null;

  return updateScopedResource({
    companyId: input.companyId,
    resourceId: input.resourceId,
    patch: {
      configText: version.configText,
      changeSummary: `Restored Company Brain version ${version.id}`,
      createdByType: "user",
      createdById: input.userId || null,
    },
  });
}

export async function listResourceGraph(companyId: string, resourceId?: string | null) {
  const resources = await listScopedResources({ companyId });
  const links = await db.select().from(resourceLinks).where(eq(resourceLinks.companyId, companyId));
  const tags = await db.select().from(resourceTags).where(eq(resourceTags.companyId, companyId));
  const resourceIds = new Set<string>();

  if (resourceId) {
    resourceIds.add(resourceId);
    for (const link of links) {
      if (link.sourceResourceId === resourceId) {
        if (link.targetResourceId) resourceIds.add(link.targetResourceId);
      }
      if (link.targetResourceId === resourceId) {
        resourceIds.add(link.sourceResourceId);
      }
    }
  } else {
    resources.forEach((resource) => resourceIds.add(resource.id));
  }

  const nodes = resources
    .filter((resource) => resourceIds.has(resource.id))
    .map((resource) => ({
      id: resource.id,
      label: resource.displayName || resource.name,
      scopeType: resource.scopeType,
      scopeId: resource.scopeId,
      resourceType: resource.resourceType,
      isShared: resource.isShared,
      tags: tags.filter((tag) => tag.resourceId === resource.id).map((tag) => tag.tag),
    }));

  const edges = links
    .filter((link) => resourceIds.has(link.sourceResourceId) && (!link.targetResourceId || resourceIds.has(link.targetResourceId)))
    .map((link) => ({
      id: link.id,
      source: link.sourceResourceId,
      target: link.targetResourceId,
      label: link.linkText,
      type: link.linkType,
      unresolved: !link.targetResourceId,
    }));

  return { nodes, edges };
}

export async function createResourceProposal(input: {
  companyId: string;
  proposedByAgentId?: string | null;
  proposedByUserId?: string | null;
  scopeType: string;
  scopeId?: string | null;
  targetResourceId?: string | null;
  action?: string | null;
  title: string;
  proposedText?: string | null;
  reason?: string | null;
  evidenceJson?: unknown;
}) {
  const [proposal] = await db.insert(resourceProposals).values({
    companyId: input.companyId,
    proposedByAgentId: input.proposedByAgentId || null,
    proposedByUserId: input.proposedByUserId || null,
    scopeType: normalizeScopeType(input.scopeType),
    scopeId: input.scopeId || null,
    targetResourceId: input.targetResourceId || null,
    action: input.action || "create",
    title: input.title,
    proposedText: input.proposedText || "",
    reason: input.reason || null,
    evidenceJson: input.evidenceJson || {},
    status: "pending",
  }).returning();

  return proposal;
}

export async function listResourceProposals(companyId: string, status?: string | null) {
  const conditions = [eq(resourceProposals.companyId, companyId)];
  if (status) conditions.push(eq(resourceProposals.status, status));
  return db.select().from(resourceProposals)
    .where(and(...conditions))
    .orderBy(desc(resourceProposals.createdAt));
}

export async function reviewResourceProposal(input: {
  companyId: string;
  proposalId: string;
  status: "approved" | "rejected" | "merged";
  resolutionNote?: string | null;
  reviewedByUserId?: string | null;
  proposedTextOverride?: string | null;
}) {
  const [proposal] = await db.select().from(resourceProposals).where(and(
    eq(resourceProposals.companyId, input.companyId),
    eq(resourceProposals.id, input.proposalId),
  )).limit(1);
  if (!proposal) return null;

  let resultingResource: typeof scopedResources.$inferSelect | null = null;
  const proposedText = input.proposedTextOverride ?? proposal.proposedText;

  if (input.status === "approved" || input.status === "merged") {
    if (proposal.action === "create") {
      resultingResource = await createScopedResource({
        companyId: input.companyId,
        scopeType: proposal.scopeType,
        scopeId: proposal.scopeId,
        provider: "knowledge",
        resourceType: "knowledge_base",
        name: normalizeBrainKey(proposal.title).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""),
        displayName: proposal.title,
        configText: proposedText,
        status: "active",
        ownership: "managed",
        isShared: false,
        changeSummary: `Approved proposal ${proposal.id}`,
        createdByType: "user",
        createdById: input.reviewedByUserId || null,
      });
    } else if (proposal.targetResourceId && (proposal.action === "update" || proposal.action === "merge")) {
      resultingResource = await updateScopedResource({
        companyId: input.companyId,
        resourceId: proposal.targetResourceId,
        patch: {
          configText: proposedText,
          changeSummary: `Applied proposal ${proposal.id}`,
          createdByType: "user",
          createdById: input.reviewedByUserId || null,
        },
      });
    } else if (proposal.targetResourceId && proposal.action === "archive") {
      resultingResource = await archiveScopedResource(input.companyId, proposal.targetResourceId);
    }
  }

  const [reviewed] = await db.update(resourceProposals).set({
    status: input.status,
    resolutionNote: input.resolutionNote || null,
    reviewedByUserId: input.reviewedByUserId || null,
    reviewedAt: new Date(),
    updatedAt: new Date(),
  }).where(eq(resourceProposals.id, proposal.id)).returning();

  return { proposal: reviewed, resource: resultingResource };
}

export async function resolveCompanyBrainContext(input: {
  companyId: string;
  customerId?: string | null;
  projectId?: string | null;
  agentId?: string | null;
  resourceIds?: string[];
  tagFilters?: string[];
  maxChars?: number;
}) {
  const maxChars = input.maxChars || 12000;
  const allResources = await listScopedResources({ companyId: input.companyId, status: "active" });
  const links = await db.select().from(resourceLinks).where(eq(resourceLinks.companyId, input.companyId));
  const requestedTags = new Set((input.tagFilters || []).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean));
  const tagRows = requestedTags.size > 0
    ? await db.select().from(resourceTags).where(eq(resourceTags.companyId, input.companyId))
    : [];
  const resourcesMatchingTags = new Set(
    tagRows
      .filter((row) => requestedTags.has(row.tag))
      .map((row) => row.resourceId)
  );
  const selected = new Set(input.resourceIds || []);
  const selectedNeighbors = new Set<string>();

  for (const link of links) {
    if (selected.has(link.sourceResourceId) && link.targetResourceId) selectedNeighbors.add(link.targetResourceId);
    if (link.targetResourceId && selected.has(link.targetResourceId)) selectedNeighbors.add(link.sourceResourceId);
  }

  const scored = allResources.map((resource) => {
    let priority = 99;
    if (resource.scopeType === "company" && resource.isShared && /operating|doctrine/i.test(`${resource.name} ${resource.displayName || ""}`)) priority = 1;
    else if (resource.isShared && (
      resource.scopeType === "company" ||
      (resource.scopeType === "customer" && resource.scopeId === input.customerId) ||
      (resource.scopeType === "project" && resource.scopeId === input.projectId) ||
      (resource.scopeType === "agent" && resource.scopeId === input.agentId)
    )) priority = 2;
    else if (selected.has(resource.id)) priority = 3;
    else if (resourcesMatchingTags.has(resource.id)) priority = 3;
    else if (selectedNeighbors.has(resource.id)) priority = 4;
    else if (
      resource.scopeType === "company" ||
      (resource.scopeType === "customer" && resource.scopeId === input.customerId) ||
      (resource.scopeType === "project" && resource.scopeId === input.projectId) ||
      (resource.scopeType === "agent" && resource.scopeId === input.agentId)
    ) priority = 5;

    return { resource, priority };
  }).filter((item) => item.priority < 99)
    .sort((left, right) => left.priority - right.priority || +new Date(right.resource.updatedAt) - +new Date(left.resource.updatedAt));

  const resources = [];
  let usedChars = 0;
  for (const item of scored) {
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    const content = truncateForContext(item.resource.configText || "", Math.min(remaining, 3000));
    usedChars += content.length;
    resources.push({
      id: item.resource.id,
      name: item.resource.displayName || item.resource.name,
      scopeType: item.resource.scopeType,
      scopeId: item.resource.scopeId,
      priority: item.priority,
      isShared: item.resource.isShared,
      content,
    });
  }

  return {
    resources,
    sources: resources,
    totalResources: resources.length,
    usedChars,
    maxChars,
    tagFilters: Array.from(requestedTags),
  };
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
