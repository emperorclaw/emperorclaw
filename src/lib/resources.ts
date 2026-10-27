import { resourceContextPriority } from "@/lib/resource-context-priority";
import { randomUUID } from "crypto";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  resourceAccessLogs,
  resourceLinks,
  resourceProposals,
  resourceTags,
  resourceVersions,
  scopedResources,
} from "@/db/schema";
import { isCustomerAllowed, isProjectAllowed, loadAgentScopeContext } from "@/lib/agent-scope";
import type { McpTaskScopeContext } from "@/lib/mcp";
import {
  buildAlwaysBlock,
  orderKnowledgeNotesForIndex,
  renderKnowledgeIndex,
  KNOWLEDGE_ALWAYS_MAX_CHARS,
  KNOWLEDGE_INDEX_MAX_CHARS,
  KNOWLEDGE_INDEX_MAX_LINES,
  type KnowledgeIndexNote,
} from "@/lib/knowledge-index";
import {
  clampKnowledgeSummary,
  deriveKnowledgeSummary,
  injectModeFromIsShared,
  isSharedFromInjectMode,
  normalizeKnowledgeInjectMode,
  type KnowledgeInjectMode,
} from "@/lib/knowledge-summary";
import {
  buildResourceChildPath,
  buildResourceFolderTree,
  normalizeResourcePath,
  RESOURCE_PATH_MAX_DEPTH,
  RESOURCE_PATH_MAX_SEGMENT,
  resourcePathAncestors,
  type ResourceFolderNode,
} from "@/lib/resource-paths";

// Path helpers live in a db-free module so client components can share them.
export {
  buildResourceChildPath,
  buildResourceFolderTree,
  normalizeResourcePath,
  RESOURCE_PATH_MAX_DEPTH,
  RESOURCE_PATH_MAX_SEGMENT,
  resourcePathAncestors,
};
export type { ResourceFolderNode };

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

/**
 * Every column except the secret material. List queries select exactly this so
 * a secret can never reach an agent through a listing, even if a future route
 * forgets to sanitize its output. Secret material is only returned by the
 * danger-scoped lease endpoint.
 */
export const PUBLIC_RESOURCE_COLUMNS = {
  id: scopedResources.id,
  companyId: scopedResources.companyId,
  scopeType: scopedResources.scopeType,
  scopeId: scopedResources.scopeId,
  provider: scopedResources.provider,
  resourceType: scopedResources.resourceType,
  name: scopedResources.name,
  displayName: scopedResources.displayName,
  path: scopedResources.path,
  configText: scopedResources.configText,
  status: scopedResources.status,
  isShared: scopedResources.isShared,
  inject: scopedResources.inject,
  summary: scopedResources.summary,
  ownership: scopedResources.ownership,
  lastUsedAt: scopedResources.lastUsedAt,
  lastFailureAt: scopedResources.lastFailureAt,
  lastFailureReason: scopedResources.lastFailureReason,
  createdAt: scopedResources.createdAt,
  updatedAt: scopedResources.updatedAt,
  deletedAt: scopedResources.deletedAt,
} as const;

/**
 * The minimal projection the lean index/search needs. It deliberately omits
 * `configText` (and the secret) so building the index never loads note bodies
 * into memory; only the `always` path reads a bounded body prefix.
 */
export const KNOWLEDGE_INDEX_COLUMNS = {
  id: scopedResources.id,
  name: scopedResources.name,
  displayName: scopedResources.displayName,
  summary: scopedResources.summary,
  scopeType: scopedResources.scopeType,
  scopeId: scopedResources.scopeId,
  inject: scopedResources.inject,
  updatedAt: scopedResources.updatedAt,
} as const;

/** Longest body prefix read for an `always` note (its budget is 1,500 chars). */
export const KNOWLEDGE_ALWAYS_BODY_PREFIX_MAX_CHARS = 2000;
/** Bound on the content prefix scanned by search, as before. */
const KNOWLEDGE_SEARCH_BODY_PREFIX_MAX_CHARS = 20000;

type KnowledgeIndexRow = {
  id: string;
  name: string;
  displayName: string | null;
  summary: string | null;
  scopeType: string;
  scopeId: string | null;
  inject: string;
  updatedAt: Date;
};

type KnowledgeAlwaysRow = KnowledgeIndexRow & { configText: string };

/**
 * The one query behind the lean index and search: active, non-deleted rows
 * projected to KNOWLEDGE_INDEX_COLUMNS, optionally filtered by inject mode or a
 * wildcard-escaped search term. Scope filtering happens in memory against the
 * agent's access (see `canAgentReadResource`), so columns stay minimal rather
 * than pushing a join/filter the projection does not need.
 */
async function queryKnowledgeRows(input: {
  companyId: string;
  inject?: KnowledgeInjectMode;
  search?: string | null;
}): Promise<KnowledgeIndexRow[]> {
  const conditions = [
    eq(scopedResources.companyId, input.companyId),
    eq(scopedResources.status, "active"),
    isNull(scopedResources.deletedAt),
  ];
  if (input.inject) conditions.push(eq(scopedResources.inject, input.inject));
  if (input.search) {
    const term = `%${escapeLikePattern(input.search)}%`;
    const condition = or(
      ilike(scopedResources.name, term),
      ilike(scopedResources.displayName, term),
      ilike(scopedResources.summary, term),
      ilike(sql`substring(${scopedResources.configText}, 1, ${KNOWLEDGE_SEARCH_BODY_PREFIX_MAX_CHARS})`, term),
    );
    if (condition) conditions.push(condition);
  }
  return db.select(KNOWLEDGE_INDEX_COLUMNS).from(scopedResources)
    .where(and(...conditions))
    .orderBy(desc(scopedResources.updatedAt));
}

/** `always` notes plus a bounded body prefix; the only path that reads content. */
async function queryKnowledgeAlwaysRows(companyId: string): Promise<KnowledgeAlwaysRow[]> {
  return db.select({
    ...KNOWLEDGE_INDEX_COLUMNS,
    configText: sql<string>`substring(${scopedResources.configText}, 1, ${KNOWLEDGE_ALWAYS_BODY_PREFIX_MAX_CHARS})`,
  }).from(scopedResources)
    .where(and(
      eq(scopedResources.companyId, companyId),
      eq(scopedResources.status, "active"),
      eq(scopedResources.inject, "always"),
      isNull(scopedResources.deletedAt),
    ))
    .orderBy(desc(scopedResources.updatedAt));
}

export type PublicResource = Omit<typeof scopedResources.$inferSelect, "secretText">;

/**
 * The one agent-facing projection of a scoped_resources row. `listScopedResources`
 * already selects `PUBLIC_RESOURCE_COLUMNS`, so this matters for rows returned by
 * create/update `.returning()`, which still carry `secretText`.
 */
export function toPublicResource<T extends object>(resource: T): Omit<T, "secretText"> {
  const safe = { ...resource };
  delete (safe as { secretText?: unknown }).secretText;
  return safe as Omit<T, "secretText">;
}

/**
 * The read access an agent has to scoped resources. `null` means a human or
 * operator session with unrestricted access — the previous behaviour.
 */
export type AgentResourceAccess = {
  callerAgentId: string;
  allowedProjectIds: Set<string> | null;
  allowedCustomerIds: Set<string> | null;
};

/**
 * The single read-access rule for agent-facing knowledge/resources reads, the
 * same scope match the shared-context selection applies (`resourceContextPriority`):
 * an agent may read company-scoped notes, notes scoped to itself, and
 * customer/project notes only for the scopes its `scopeJson` grants (an
 * unrestricted scope grants all). Anything else is not visible.
 */
export function canAgentReadResource(
  resource: { scopeType: string; scopeId: string | null },
  access: AgentResourceAccess | null,
): boolean {
  if (!access) return true;
  const scope = normalizeScopeType(resource.scopeType);
  if (scope === "company") return true;
  if (scope === "agent") return resource.scopeId === access.callerAgentId;
  if (scope === "project") return isProjectAllowed(access.allowedProjectIds, resource.scopeId);
  if (scope === "customer") return isCustomerAllowed(access.allowedCustomerIds, resource.scopeId);
  return false;
}

/**
 * Resolve an agent's read access once per request. Returns null for a
 * human/operator caller (no agent binding) so those sessions keep their access.
 */
export async function loadAgentResourceAccess(
  companyId: string,
  callerAgentId: string | null | undefined,
): Promise<AgentResourceAccess | null> {
  if (!callerAgentId) return null;
  const { allowedProjectIds, allowedCustomerIds } = await loadAgentScopeContext(companyId, callerAgentId);
  return { callerAgentId, allowedProjectIds, allowedCustomerIds };
}

function normalizeBrainKey(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}


function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Escape LIKE/ILIKE wildcards. A folder literally named "50% Done" must not
 * match every sibling folder because of a stray %.
 */
export function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
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

/** Total budget across all resources injected into one agent context. */
export const DEFAULT_CONTEXT_MAX_CHARS = 12000;

/**
 * Per-resource ceiling inside that budget.
 *
 * This used to be hard-coded at 3000, which silently truncated any longer
 * doctrine note mid-document: the agent received the opening sections and
 * never saw the rest, with no error surfaced anywhere. The default is now
 * generous enough for a real operating doctrine, and deployments that want a
 * different trade-off between "one deep note" and "many shallow notes" can
 * tune it without a code change.
 */
export const DEFAULT_CONTEXT_MAX_CHARS_PER_RESOURCE = 8000;

export function resolveMaxCharsPerResource(): number {
  const raw = Number.parseInt(process.env.EMPEROR_BRAIN_MAX_CHARS_PER_RESOURCE || "", 10);
  if (Number.isFinite(raw) && raw > 0) return raw;
  return DEFAULT_CONTEXT_MAX_CHARS_PER_RESOURCE;
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
  /** Exact folder, e.g. "Company/Fundraising". Use "" for the vault root. */
  path?: string | null;
  /** That folder and everything beneath it. */
  pathPrefix?: string | null;
}) {
  const conditions = [
    eq(scopedResources.companyId, input.companyId),
    isNull(scopedResources.deletedAt),
  ];

  // "" is a meaningful value here (the vault root), so check against undefined
  // and null rather than truthiness.
  if (input.path !== undefined && input.path !== null) {
    conditions.push(eq(scopedResources.path, normalizeResourcePath(input.path)));
  }

  if (input.pathPrefix !== undefined && input.pathPrefix !== null) {
    const prefix = normalizeResourcePath(input.pathPrefix);
    // An empty prefix means the whole vault — no filter needed.
    if (prefix) {
      const descendants = or(
        eq(scopedResources.path, prefix),
        ilike(scopedResources.path, `${escapeLikePattern(prefix)}/%`),
      );
      if (descendants) conditions.push(descendants);
    }
  }

  if (input.scopeType) conditions.push(eq(scopedResources.scopeType, normalizeScopeType(input.scopeType)));
  if (input.scopeId) conditions.push(eq(scopedResources.scopeId, input.scopeId));
  if (input.provider) conditions.push(eq(scopedResources.provider, input.provider));
  if (input.resourceType) conditions.push(eq(scopedResources.resourceType, normalizeResourceType(input.resourceType)));
  if (input.status) conditions.push(eq(scopedResources.status, input.status));
  if (input.isShared !== undefined && input.isShared !== null) conditions.push(eq(scopedResources.isShared, input.isShared));
  // Escape LIKE wildcards in user-supplied terms so a literal "%" or "_" is
  // matched as a character, not a wildcard. The term stays a bound parameter.
  if (input.name) conditions.push(ilike(scopedResources.name, `%${escapeLikePattern(input.name)}%`));
  if (input.displayName) conditions.push(ilike(scopedResources.displayName, `%${escapeLikePattern(input.displayName)}%`));
  if (input.search) {
    const term = `%${escapeLikePattern(input.search)}%`;
    // Free-text search spans name, display name and the note body. The body is
    // matched on a bounded prefix so a pathological note cannot force a full
    // scan of multi-megabyte content; the term stays a bound parameter.
    const searchCondition = or(
      ilike(scopedResources.name, term),
      ilike(scopedResources.displayName, term),
      ilike(scopedResources.summary, term),
      ilike(sql`substring(${scopedResources.configText}, 1, 20000)`, term)
    );
    if (searchCondition) conditions.push(searchCondition);
  }

  return db.select(PUBLIC_RESOURCE_COLUMNS).from(scopedResources)
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

/**
 * Rename or move a folder by rewriting the path prefix of everything inside it.
 *
 * Implicit folders have no row of their own, so "renaming a folder" is really
 * "re-filing every note under it". Returns the number of notes moved; 0 means
 * the folder was empty or absent, which is not an error.
 */
export async function moveResourceFolder(input: {
  companyId: string;
  fromPath: string;
  toPath: string;
  /** Restrict to one scope. Folders are per-scope, so omit only for global moves. */
  scopeType?: string | null;
  scopeId?: string | null;
}) {
  const from = normalizeResourcePath(input.fromPath);
  const to = normalizeResourcePath(input.toPath);
  if (!from || from === to) return 0;

  // Refuse to move a folder inside itself — that would build an unreachable
  // path and orphan every note under it.
  if (to === from || to.startsWith(`${from}/`)) {
    throw new Error("Cannot move a folder into its own subtree");
  }

  const affected = await listScopedResources({
    companyId: input.companyId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    pathPrefix: from,
  });

  for (const resource of affected) {
    const suffix = resource.path.slice(from.length).replace(/^\//, "");
    const nextPath = normalizeResourcePath(to && suffix ? `${to}/${suffix}` : to || suffix);
    await db.update(scopedResources)
      .set({ path: nextPath, updatedAt: new Date() })
      .where(eq(scopedResources.id, resource.id));
  }

  return affected.length;
}

/**
 * Delete a folder and every note within it and its subfolders (soft-delete).
 * Scoped so deleting "Fundraising" under Company leaves an Agent's identically
 * named folder untouched. Returns how many notes were deleted.
 */
export async function deleteResourceFolder(input: {
  companyId: string;
  path: string;
  scopeType?: string | null;
  scopeId?: string | null;
}) {
  const path = normalizeResourcePath(input.path);
  if (!path) return 0;

  const affected = await listScopedResources({
    companyId: input.companyId,
    scopeType: input.scopeType,
    scopeId: input.scopeId,
    pathPrefix: path,
  });

  for (const resource of affected) {
    await db.update(scopedResources)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(eq(scopedResources.id, resource.id));
  }

  return affected.length;
}

export async function createScopedResource(input: {
  companyId: string;
  scopeType: string;
  scopeId?: string | null;
  provider: string;
  resourceType: string;
  name: string;
  displayName?: string | null;
  path?: string | null;
  configText?: string | null;
  secretText?: string | null;
  status?: string | null;
  ownership?: string | null;
  isShared?: boolean;
  /** Explicit injection mode; when omitted it is derived from isShared. */
  inject?: string | null;
  /** Explicit summary; when omitted/blank it is derived from the note body. */
  summary?: string | null;
  changeSummary?: string | null;
  createdByType?: string | null;
  createdById?: string | null;
}) {
  const inject: KnowledgeInjectMode = input.inject
    ? normalizeKnowledgeInjectMode(input.inject)
    : injectModeFromIsShared(input.isShared ?? false);
  const providedSummary = typeof input.summary === "string" ? input.summary.trim() : "";
  const summary = providedSummary
    ? clampKnowledgeSummary(providedSummary)
    : deriveKnowledgeSummary(input.configText || "");

  const [resource] = await db.insert(scopedResources).values({
    id: randomUUID(),
    companyId: input.companyId,
    scopeType: normalizeScopeType(input.scopeType),
    scopeId: input.scopeId || null,
    provider: input.provider,
    resourceType: normalizeResourceType(input.resourceType),
    name: input.name,
    displayName: input.displayName || null,
    path: normalizeResourcePath(input.path),
    configText: input.configText || "",
    secretText: input.secretText || "",
    status: input.status || "active",
    ownership: input.ownership || "managed",
    // isShared stays in step with inject for older readers.
    isShared: isSharedFromInjectMode(inject),
    inject,
    summary: summary || null,
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
    path: string | null;
    configText: string;
    secretText: string;
    status: string;
    ownership: string;
    isShared: boolean;
    inject: string;
    summary: string | null;
    changeSummary: string;
    createdByType: string;
    createdById: string | null;
  }>;
}) {
  const existing = await getScopedResource(input.companyId, input.resourceId);
  if (!existing) return null;

  const nextConfigText = input.patch.configText ?? existing.configText;

  // Resolve the injection mode. An explicit `inject` wins; otherwise a legacy
  // `isShared` patch maps onto it without demoting an existing `always` note.
  let inject: KnowledgeInjectMode = existing.inject
    ? normalizeKnowledgeInjectMode(existing.inject)
    : injectModeFromIsShared(existing.isShared);
  if (input.patch.inject !== undefined) {
    inject = normalizeKnowledgeInjectMode(input.patch.inject);
  } else if (input.patch.isShared !== undefined) {
    if (!input.patch.isShared) inject = "on_request";
    else if (inject === "on_request") inject = "index";
  }

  // A blank/omitted summary is re-derived from content; an explicit value is
  // clamped. A summary is only recomputed from content when the body changed.
  let summary = existing.summary;
  if (input.patch.summary !== undefined) {
    const provided = typeof input.patch.summary === "string" ? input.patch.summary.trim() : "";
    summary = provided ? clampKnowledgeSummary(provided) : deriveKnowledgeSummary(nextConfigText);
  } else if (input.patch.configText !== undefined) {
    summary = deriveKnowledgeSummary(nextConfigText);
  }

  const [resource] = await db.update(scopedResources).set({
    scopeType: input.patch.scopeType ? normalizeScopeType(input.patch.scopeType) : existing.scopeType,
    scopeId: input.patch.scopeId === undefined ? existing.scopeId : input.patch.scopeId,
    provider: input.patch.provider ?? existing.provider,
    resourceType: input.patch.resourceType ? normalizeResourceType(input.patch.resourceType) : existing.resourceType,
    name: input.patch.name ?? existing.name,
    displayName: input.patch.displayName === undefined ? existing.displayName : input.patch.displayName,
    // Moving a note between folders is just a path patch. Undefined leaves it
    // where it is; null or "" moves it to the vault root.
    path: input.patch.path === undefined ? existing.path : normalizeResourcePath(input.patch.path),
    configText: nextConfigText,
    secretText: input.patch.secretText ?? existing.secretText,
    status: input.patch.status ?? existing.status,
    ownership: input.patch.ownership ?? existing.ownership,
    isShared: isSharedFromInjectMode(inject),
    inject,
    summary: summary || null,
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
  const lookup = new Map<string, PublicResource>();
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
  /** Folder to file an approved proposal into. Defaults to the vault root. */
  pathOverride?: string | null;
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
        path: input.pathOverride ?? null,
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
  /** The authenticated agent making the call; null for human/operator sessions. */
  callerAgentId?: string | null;
  resourceIds?: string[];
  tagFilters?: string[];
  maxChars?: number;
  maxCharsPerResource?: number;
}) {
  const maxChars = input.maxChars || DEFAULT_CONTEXT_MAX_CHARS;
  const maxCharsPerResource = input.maxCharsPerResource || resolveMaxCharsPerResource();
  const access = await loadAgentResourceAccess(input.companyId, input.callerAgentId ?? null);
  const allResources = (await listScopedResources({ companyId: input.companyId, status: "active" }))
    // An explicit resourceId (or tag/neighbor) must not let an agent read a note
    // outside its scope: apply the shared read rule before scoring or selection.
    .filter((resource) => canAgentReadResource(resource, access));
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

  const scored = allResources.map((resource) => ({
    resource,
    priority: resourceContextPriority(resource, {
      customerId: input.customerId, projectId: input.projectId, agentId: input.agentId,
      selected, matchingTags: resourcesMatchingTags, neighbors: selectedNeighbors,
    }),
  })).filter((item) => item.priority < 99)
    .sort((left, right) => left.priority - right.priority || +new Date(right.resource.updatedAt) - +new Date(left.resource.updatedAt));

  const resources = [];
  let usedChars = 0;
  for (const item of scored) {
    const remaining = maxChars - usedChars;
    if (remaining <= 0) break;
    const content = truncateForContext(item.resource.configText || "", Math.min(remaining, maxCharsPerResource));
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

/**
 * The agent-facing index projection of a note: title, summary and id. The
 * summary falls back to a fresh derivation only when a body is present (the
 * `always` path); index/search rows carry no body, so they rely on the stored
 * summary, which the bounded boot backfill fills in.
 */
function toKnowledgeIndexNote(resource: KnowledgeIndexRow & { configText?: string }): KnowledgeIndexNote {
  return {
    id: resource.id,
    title: resource.displayName || resource.name,
    summary: resource.summary || deriveKnowledgeSummary(resource.configText || ""),
    scopeType: resource.scopeType,
    scopeId: resource.scopeId,
    inject: resource.inject,
    updatedAt: resource.updatedAt,
    configText: resource.configText ?? "",
  };
}

/**
 * Tier 1 of the lean context: one compact line per `inject = 'index'` note the
 * agent may see, plus the bodies of `inject = 'always'` notes under a hard
 * budget. Bodies of on-request notes are never included here.
 */
export async function buildKnowledgeIndex(input: {
  companyId: string;
  agentId?: string | null;
  maxLines?: number;
  maxChars?: number;
}) {
  const access = await loadAgentResourceAccess(input.companyId, input.agentId ?? null);
  // Two minimal queries instead of loading every note (body included): the
  // index only needs its columns, and only `always` notes load a bounded body.
  const [indexRows, alwaysRows] = await Promise.all([
    queryKnowledgeRows({ companyId: input.companyId, inject: "index" }),
    queryKnowledgeAlwaysRows(input.companyId),
  ]);

  // Reuse the phase-0 scope rule: an agent only ever sees notes it may read.
  const indexNotes = orderKnowledgeNotesForIndex(
    indexRows.filter((resource) => canAgentReadResource(resource, access)).map(toKnowledgeIndexNote),
  );
  const alwaysNotes = alwaysRows.filter((resource) => canAgentReadResource(resource, access)).map(toKnowledgeIndexNote);

  const index = renderKnowledgeIndex(indexNotes, {
    maxLines: input.maxLines ?? KNOWLEDGE_INDEX_MAX_LINES,
    maxChars: input.maxChars ?? KNOWLEDGE_INDEX_MAX_CHARS,
  });
  const always = buildAlwaysBlock(alwaysNotes, { maxChars: KNOWLEDGE_ALWAYS_MAX_CHARS });

  return {
    knowledgeIndex: index.text,
    alwaysBlock: always.text,
    indexIds: index.ids,
    alwaysIds: always.ids,
    indexTruncated: index.truncated,
    alwaysOverBudget: always.overBudget,
    alwaysUsedChars: always.usedChars,
  };
}

export type VisibleKnowledgeNote = {
  id: string;
  title: string;
  summary: string;
  scopeType: string;
  scopeId: string | null;
  line: string;
};

/**
 * Bounded, parameterized knowledge search returning index lines (no bodies).
 * Matches name, display name, summary and a bounded prefix of the content, and
 * applies the same scope rule as the index.
 */
export async function searchVisibleKnowledgeNotes(input: {
  companyId: string;
  query: string;
  agentId?: string | null;
  limit?: number;
}): Promise<VisibleKnowledgeNote[]> {
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 20);
  const access = await loadAgentResourceAccess(input.companyId, input.agentId ?? null);
  // Search filters on the body in SQL but never selects it: matching rows are
  // projected to index columns, so no note body is loaded to return a line.
  const rows = await queryKnowledgeRows({ companyId: input.companyId, search: input.query });
  return orderKnowledgeNotesForIndex(rows.filter((resource) => canAgentReadResource(resource, access)).map(toKnowledgeIndexNote))
    .slice(0, limit)
    .map((note) => ({
      id: note.id,
      title: note.title,
      summary: note.summary,
      scopeType: note.scopeType,
      scopeId: note.scopeId ?? null,
      line: `${note.title} \u2014 ${note.summary} \u2014 ${note.id}`,
    }));
}

/** One note the agent may read (scope-checked), or null. Still carries secrets. */
export async function getVisibleKnowledgeNote(input: {
  companyId: string;
  resourceId: string;
  agentId?: string | null;
}) {
  const resource = await getScopedResource(input.companyId, input.resourceId);
  if (!resource) return null;
  const access = await loadAgentResourceAccess(input.companyId, input.agentId ?? null);
  if (!canAgentReadResource(resource, access)) return null;
  return resource;
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
