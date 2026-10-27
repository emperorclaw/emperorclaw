/**
 * Agent-facing Knowledge & Rules folders: choosing, validating and listing the
 * folder (`scopedResources.path`) an agent files a note in.
 *
 * Folders are implicit (see lib/resource-paths.ts): filing a note at
 * "Customers/Harbor Dental/Meetings" is all it takes to create every missing
 * level. Scope still decides who may read a note; folders add two rules on top
 * so a restricted agent cannot use the folder tree to reach a customer or
 * project it has no access to:
 *
 *   - a folder that by convention belongs to a customer or project
 *     ("Customers/<name>/…", "Clients/<name>/…", "Projects/<goal>/…") is only
 *     usable when <name> is a customer/project the agent may use. Whether some
 *     other customer/project of that name exists plays no part, so the answer
 *     never tells the agent which names exist;
 *   - a folder whose notes are all scoped to customers/projects the agent
 *     cannot read is off limits too, wherever it sits.
 *
 * Off-limits folders are hidden from the folder tree; as a filter they match
 * nothing (exactly like a folder that does not exist), and as a write target
 * they are refused with one generic message.
 */
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { customers, projects, scopedResources } from "@/db/schema";
import { isCustomerAllowed, isProjectAllowed } from "@/lib/agent-scope";
import { isMcpAccessRestricted, type McpAgentAccess } from "@/lib/mcp-access";
import { canAgentReadResource, escapeLikePattern, type AgentResourceAccess } from "@/lib/resources";
import {
  buildResourceFolderTree,
  defaultResourceFolderFor,
  normalizeResourcePath,
  parseResourceFolderPath,
  resourceFolderMatchKey,
  resourceFolderOwner,
  resourceFolderSegment,
  type ResourceFolderNode,
} from "@/lib/resource-paths";

export const KNOWLEDGE_RESOURCE_TYPE = "knowledge_base";

/** A folder the caller may not use. `status` is what a REST route should answer. */
export class KnowledgeFolderError extends Error {
  readonly status: 400 | 404;
  constructor(message: string, status: 400 | 404) {
    super(message);
    this.name = "KnowledgeFolderError";
    this.status = status;
  }
}

/**
 * The one refusal for a folder a restricted agent may not write into. It is
 * the same whether the folder is out of scope or names a customer/project that
 * does not exist, so a refusal reveals nothing about which names exist.
 */
export const KNOWLEDGE_FOLDER_REFUSED_MESSAGE = "Choose a folder you can use: list_knowledge_folders shows them";

/** Row caps so a huge vault can never turn one agent call into an unbounded scan. */
export const KNOWLEDGE_FOLDER_ROW_LIMIT = 5000;
const FOLDER_OWNER_ROW_LIMIT = 5000;

function readAccessOf(access: McpAgentAccess): AgentResourceAccess | null {
  if (!access.agentId) return null;
  return {
    callerAgentId: access.agentId,
    allowedProjectIds: access.allowedProjectIds,
    allowedCustomerIds: access.allowedCustomerIds,
  };
}

/** Parse an agent-supplied folder or throw a 400 KnowledgeFolderError. */
export function parseKnowledgeFolder(input: unknown): string {
  const parsed = parseResourceFolderPath(input);
  if (!parsed.ok) throw new KnowledgeFolderError(parsed.error, 400);
  return parsed.path;
}

/** Match keys (see resourceFolderMatchKey) of the customers / projects the agent may use. */
type FolderOwnerIndex = {
  customers: Set<string>;
  projects: Set<string>;
};

/**
 * Per-request cache. An access object is resolved once per request / tool call,
 * so keying on it scopes the cache to that request.
 */
const ownerIndexCache = new WeakMap<McpAgentAccess, Map<string, Promise<FolderOwnerIndex>>>();

/**
 * Folder keys of the customers / projects a restricted agent may use. Only the
 * allowed rows are read (id + name, capped), never the whole company.
 */
function loadFolderOwnerIndex(companyId: string, access: McpAgentAccess): Promise<FolderOwnerIndex> {
  let byCompany = ownerIndexCache.get(access);
  if (!byCompany) {
    byCompany = new Map();
    ownerIndexCache.set(access, byCompany);
  }
  const cached = byCompany.get(companyId);
  if (cached) return cached;

  const keysOf = (rows: Array<{ name: string }>) => {
    const keys = new Set<string>();
    for (const row of rows) {
      const segment = resourceFolderSegment(row.name);
      if (segment) keys.add(resourceFolderMatchKey(segment));
    }
    return keys;
  };
  const allowedCustomers = access.allowedCustomerIds ? [...access.allowedCustomerIds] : [];
  const allowedProjects = access.allowedProjectIds ? [...access.allowedProjectIds] : [];
  const cache = byCompany;
  const loading = Promise.all([
    allowedCustomers.length === 0 ? [] : db.select({ id: customers.id, name: customers.name }).from(customers)
      .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt), inArray(customers.id, allowedCustomers)))
      .limit(FOLDER_OWNER_ROW_LIMIT),
    allowedProjects.length === 0 ? [] : db.select({ id: projects.id, name: projects.goal }).from(projects)
      .where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt), inArray(projects.id, allowedProjects)))
      .limit(FOLDER_OWNER_ROW_LIMIT),
  ]).then(([customerRows, projectRows]) => ({ customers: keysOf(customerRows), projects: keysOf(projectRows) }));
  // A failed load must not poison the rest of the request.
  loading.catch(() => cache.delete(companyId));
  cache.set(companyId, loading);
  return loading;
}

/**
 * True when a restricted agent may use the folder as far as the
 * Customers/Clients/Projects convention goes: folders outside the convention
 * always pass, and a dimension the agent is not restricted on passes whole.
 * Otherwise the named customer/project must be one the agent may use.
 */
function conventionOwnerAllowed(path: string, owners: FolderOwnerIndex, access: McpAgentAccess): boolean {
  const owner = resourceFolderOwner(path);
  if (!owner) return true;
  const segment = resourceFolderSegment(owner.name);
  const key = segment ? resourceFolderMatchKey(segment) : "";
  if (owner.kind === "customer") return access.allowedCustomerIds === null || owners.customers.has(key);
  return access.allowedProjectIds === null || owners.projects.has(key);
}

/** Knowledge notes in a folder and beneath it (case-insensitive), scope columns only. */
async function notesInFolderTree(companyId: string, path: string) {
  return db.select({ scopeType: scopedResources.scopeType, scopeId: scopedResources.scopeId })
    .from(scopedResources)
    .where(and(
      eq(scopedResources.companyId, companyId),
      eq(scopedResources.resourceType, KNOWLEDGE_RESOURCE_TYPE),
      isNull(scopedResources.deletedAt),
      or(
        sql`lower(${scopedResources.path}) = lower(${path})`,
        sql`${scopedResources.path} ilike ${`${escapeLikePattern(path)}/%`}`,
      ),
    ));
}

/**
 * May this agent use the folder (file in it, or filter by it)? The vault root
 * and unrestricted callers always may.
 */
export async function agentMayUseKnowledgeFolder(companyId: string, access: McpAgentAccess, path: string): Promise<boolean> {
  if (!path || !isMcpAccessRestricted(access)) return true;

  const owners = await loadFolderOwnerIndex(companyId, access);
  if (!conventionOwnerAllowed(path, owners, access)) return false;

  const notes = await notesInFolderTree(companyId, path);
  const readAccess = readAccessOf(access);
  const ownedByOthers = notes.length > 0
    && notes.every((note) => !canAgentReadResource(note, readAccess))
    && notes.some((note) => note.scopeType === "customer" || note.scopeType === "project");
  return !ownedByOthers;
}

/**
 * Throw (404, generic message) when a restricted agent may not file in this
 * folder. For filters use agentMayUseKnowledgeFolder and return an empty
 * result instead, so an off-limits folder looks exactly like a missing one.
 */
export async function assertAgentMayUseKnowledgeFolder(companyId: string, access: McpAgentAccess, path: string): Promise<void> {
  if (!(await agentMayUseKnowledgeFolder(companyId, access, path))) {
    throw new KnowledgeFolderError(KNOWLEDGE_FOLDER_REFUSED_MESSAGE, 404);
  }
}

/**
 * Drop notes filed in folders the agent may not use (by convention). A folder
 * filter such as "Customers" would otherwise reach into an off-limits
 * "Customers/<other>" subfolder the tree hides.
 */
export async function filterNotesInUsableFolders<T extends { path?: string | null }>(
  companyId: string,
  access: McpAgentAccess,
  notes: T[],
): Promise<T[]> {
  if (!isMcpAccessRestricted(access)) return notes;
  const owners = await loadFolderOwnerIndex(companyId, access);
  return notes.filter((note) => conventionOwnerAllowed(note.path ?? "", owners, access));
}

/** Customer name / project goal for a scoped note, company-checked. */
async function scopeOwnerName(companyId: string, scopeType: string, scopeId: string): Promise<string | null> {
  if (scopeType === "customer") {
    const [row] = await db.select({ name: customers.name }).from(customers)
      .where(and(eq(customers.companyId, companyId), eq(customers.id, scopeId), isNull(customers.deletedAt))).limit(1);
    return row?.name ?? null;
  }
  if (scopeType === "project") {
    const [row] = await db.select({ name: projects.goal }).from(projects)
      .where(and(eq(projects.companyId, companyId), eq(projects.id, scopeId), isNull(projects.deletedAt))).limit(1);
    return row?.name ?? null;
  }
  return null;
}

/**
 * The folder a new note is filed in.
 *
 * - `folder` given: strictly parsed, then scope-checked ("" / "/" = vault root).
 * - legacy `path` given (REST): normalized leniently as before, then scope-checked.
 * - neither: a customer/project-scoped note goes to that customer's/project's
 *   conventional folder when the vault uses the convention; otherwise the
 *   root, as before.
 */
export async function resolveNewKnowledgeNoteFolder(input: {
  companyId: string;
  access: McpAgentAccess;
  folder?: unknown;
  legacyPath?: unknown;
  scopeType: string;
  scopeId?: string | null;
}): Promise<string> {
  if (input.folder !== undefined && input.folder !== null) {
    const path = parseKnowledgeFolder(input.folder);
    await assertAgentMayUseKnowledgeFolder(input.companyId, input.access, path);
    return path;
  }
  if (typeof input.legacyPath === "string" && input.legacyPath.trim()) {
    const path = normalizeResourcePath(input.legacyPath);
    await assertAgentMayUseKnowledgeFolder(input.companyId, input.access, path);
    return path;
  }
  if (!input.scopeId || (input.scopeType !== "customer" && input.scopeType !== "project")) return "";

  const ownerName = await scopeOwnerName(input.companyId, input.scopeType, input.scopeId);
  if (!ownerName) return "";
  // Only the first two levels matter (the convention root and the owner
  // folder whose casing is reused), so read those, distinct and capped.
  const ownerFolder = sql<string>`array_to_string((string_to_array(${scopedResources.path}, '/'))[1:2], '/')`;
  const existing = await db.selectDistinct({ path: ownerFolder }).from(scopedResources)
    .where(and(
      eq(scopedResources.companyId, input.companyId),
      eq(scopedResources.resourceType, KNOWLEDGE_RESOURCE_TYPE),
      isNull(scopedResources.deletedAt),
    ))
    .limit(KNOWLEDGE_FOLDER_ROW_LIMIT);
  return defaultResourceFolderFor({
    scopeType: input.scopeType,
    ownerName,
    existingPaths: existing.map((row) => row.path),
  }) ?? "";
}

/**
 * The folder an existing note moves to. undefined = leave it where it is.
 * `folder` wins over the legacy `path`; null, "" or "/" move it to the root.
 */
export async function resolveMovedKnowledgeNoteFolder(input: {
  companyId: string;
  access: McpAgentAccess;
  folder?: unknown;
  legacyPath?: unknown;
}): Promise<string | undefined> {
  let path: string;
  if (input.folder !== undefined) {
    path = input.folder === null ? "" : parseKnowledgeFolder(input.folder);
  } else if (input.legacyPath !== undefined) {
    path = normalizeResourcePath(input.legacyPath);
  } else {
    return undefined;
  }
  await assertAgentMayUseKnowledgeFolder(input.companyId, input.access, path);
  return path;
}

export type KnowledgeFolderTree = {
  /** Knowledge notes the caller can see in total. */
  totalNotes: number;
  /** Of those, notes filed at the vault root (no folder). */
  rootNotes: number;
  folders: ResourceFolderNode[];
  /** True when the vault holds more notes than one listing reads; counts are then partial. */
  truncated: boolean;
};

/**
 * The Knowledge & Rules folder tree as the caller sees it: built only from
 * notes it may read, with folders that belong to an out-of-scope customer or
 * project left out. Counts are per folder (`directCount`) and per subtree
 * (`totalCount`).
 */
export async function listKnowledgeFolders(companyId: string, access: McpAgentAccess): Promise<KnowledgeFolderTree> {
  const rows = await db.select({ scopeType: scopedResources.scopeType, scopeId: scopedResources.scopeId, path: scopedResources.path })
    .from(scopedResources)
    .where(and(
      eq(scopedResources.companyId, companyId),
      eq(scopedResources.resourceType, KNOWLEDGE_RESOURCE_TYPE),
      isNull(scopedResources.deletedAt),
    ))
    .orderBy(asc(scopedResources.path), asc(scopedResources.id))
    .limit(KNOWLEDGE_FOLDER_ROW_LIMIT + 1);
  const truncated = rows.length > KNOWLEDGE_FOLDER_ROW_LIMIT;
  if (truncated) rows.length = KNOWLEDGE_FOLDER_ROW_LIMIT;

  const readAccess = readAccessOf(access);
  const readable = rows.filter((row) => canAgentReadResource(row, readAccess));
  const visible = await filterNotesInUsableFolders(companyId, access, readable);

  return {
    totalNotes: visible.length,
    rootNotes: visible.filter((row) => !normalizeResourcePath(row.path)).length,
    folders: buildResourceFolderTree(visible),
    truncated,
  };
}
