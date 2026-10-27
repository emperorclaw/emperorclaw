/**
 * Pure helpers for Obsidian-style Knowledge & Rules folder paths.
 *
 * Deliberately free of database and server imports so the Knowledge & Rules
 * client component can build the same folder tree the server does.
 * `@/lib/resources` re-exports everything here, so server code keeps importing
 * from one place.
 */

/** Hard limits so a malformed path can never blow up the folder tree. */
export const RESOURCE_PATH_MAX_DEPTH = 10;
export const RESOURCE_PATH_MAX_SEGMENT = 80;

/**
 * Normalize a folder path.
 *
 * Accepts the shapes people actually type — "/Ferrari/XXX", "Company/Fundraising/",
 * "Company // Fundraising" — and returns a canonical "Company/Fundraising".
 * Returns "" for the vault root.
 *
 * Traversal segments ("." / "..") are dropped rather than resolved: these paths
 * are display/grouping keys, but they also flow into prefix queries, so letting
 * ".." through would let a note claim membership of a folder above its own.
 */
export function normalizeResourcePath(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .split("/")
    .map((segment) => segment.trim().replace(/\s+/g, " "))
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .slice(0, RESOURCE_PATH_MAX_DEPTH)
    .map((segment) => segment.slice(0, RESOURCE_PATH_MAX_SEGMENT))
    .join("/");
}

/**
 * Build a folder path from navigation context plus a single folder name.
 *
 * The parent is controlled by the folder the operator invoked the action from;
 * it should never need to be typed into the name field again.
 */
export function buildResourceChildPath(parentPath: string, folderName: string): string {
  const parent = normalizeResourcePath(parentPath);
  const name = normalizeResourcePath(folderName);
  if (!name || name.includes("/")) return "";
  return normalizeResourcePath(parent ? `${parent}/${name}` : name);
}

/** Ancestor paths of a folder, excluding itself. "A/B/C" -> ["A", "A/B"]. */
export function resourcePathAncestors(path: string): string[] {
  const segments = normalizeResourcePath(path).split("/").filter(Boolean);
  return segments.slice(0, -1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

export type ResourceFolderNode = {
  /** Full path from the root, e.g. "Company/Fundraising". */
  path: string;
  /** Last segment only, e.g. "Fundraising". */
  name: string;
  /** Notes filed directly in this folder, excluding descendants. */
  directCount: number;
  /** Notes in this folder and everything beneath it. */
  totalCount: number;
  children: ResourceFolderNode[];
};

/**
 * Derive the folder tree from the distinct paths of a set of resources.
 *
 * Folders are implicit, so an intermediate folder exists purely because
 * something below it does — "A/B/C" materializes "A" and "A/B" even when
 * neither holds a note directly.
 *
 * `extraPaths` materializes folders that hold no note yet. The UI uses it for a
 * folder the operator just created but has not filed anything into, which would
 * otherwise vanish on the next render.
 */
export function buildResourceFolderTree(
  resources: Array<{ path?: string | null }>,
  extraPaths: string[] = [],
): ResourceFolderNode[] {
  const byPath = new Map<string, ResourceFolderNode>();
  const roots: ResourceFolderNode[] = [];

  const ensure = (path: string): ResourceFolderNode => {
    const existing = byPath.get(path);
    if (existing) return existing;

    const segments = path.split("/");
    const node: ResourceFolderNode = {
      path,
      name: segments[segments.length - 1],
      directCount: 0,
      totalCount: 0,
      children: [],
    };
    byPath.set(path, node);

    if (segments.length === 1) {
      roots.push(node);
    } else {
      ensure(segments.slice(0, -1).join("/")).children.push(node);
    }
    return node;
  };

  for (const extra of extraPaths) {
    const path = normalizeResourcePath(extra);
    if (path) ensure(path);
  }

  for (const resource of resources) {
    const path = normalizeResourcePath(resource.path);
    if (!path) continue;

    ensure(path).directCount += 1;

    // Every ancestor counts this note in its rollup.
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index += 1) {
      ensure(segments.slice(0, index).join("/")).totalCount += 1;
    }
  }

  const sortTree = (nodes: ResourceFolderNode[]): ResourceFolderNode[] => {
    nodes.sort((a, b) => a.name.localeCompare(b.name));
    nodes.forEach((node) => sortTree(node.children));
    return nodes;
  };

  return sortTree(roots);
}

/**
 * Longest folder path an agent may send (canonical form). The depth and segment
 * caps alone would allow ~800 characters, which no sensible folder needs.
 */
export const RESOURCE_PATH_MAX_LENGTH = 255;

/** Raw input longer than this is rejected before any parsing work. */
const RESOURCE_PATH_MAX_RAW_LENGTH = 1024;

export type ParsedResourcePath = { ok: true; path: string } | { ok: false; error: string };

/**
 * Strictly parse a folder path an agent supplied ("Clients/Harbor Dental/Meetings").
 *
 * `normalizeResourcePath` is forgiving on purpose — it silently drops traversal
 * segments and truncates — which is right for stored data but wrong for an
 * agent choosing where to file a note: a note silently landing somewhere other
 * than where the agent asked is exactly the bug this guards against. So the
 * cosmetic fixes still apply (trim, collapse slashes and whitespace, "" or "/"
 * for the root), but anything that would change the meaning is an error the
 * agent can act on.
 */
export function parseResourceFolderPath(input: unknown): ParsedResourcePath {
  if (typeof input !== "string") {
    return { ok: false, error: 'folder must be a path string such as "Customers/Harbor Dental/Meetings"' };
  }
  if (input.length > RESOURCE_PATH_MAX_RAW_LENGTH) {
    return { ok: false, error: `folder is too long (max ${RESOURCE_PATH_MAX_LENGTH} characters)` };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(input)) {
    return { ok: false, error: "folder must not contain control characters" };
  }
  if (input.includes("\\")) {
    return { ok: false, error: 'folder must use "/" to separate folders, not "\\"' };
  }

  const segments = input
    .split("/")
    .map((segment) => segment.trim().replace(/\s+/g, " "))
    .filter((segment) => segment.length > 0);

  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, error: 'folder must not contain "." or ".." segments' };
  }
  if (segments.length > RESOURCE_PATH_MAX_DEPTH) {
    return { ok: false, error: `folder is too deep (max ${RESOURCE_PATH_MAX_DEPTH} levels)` };
  }
  const longSegment = segments.find((segment) => segment.length > RESOURCE_PATH_MAX_SEGMENT);
  if (longSegment) {
    return { ok: false, error: `folder name "${longSegment.slice(0, 20)}…" is too long (max ${RESOURCE_PATH_MAX_SEGMENT} characters per folder)` };
  }

  const path = segments.join("/");
  if (path.length > RESOURCE_PATH_MAX_LENGTH) {
    return { ok: false, error: `folder is too long (max ${RESOURCE_PATH_MAX_LENGTH} characters)` };
  }
  return { ok: true, path };
}

/**
 * Turn a record name (a customer, a project goal) into one folder segment:
 * slashes become dashes so a name like "Acme / EU" stays one folder.
 * Returns null when nothing usable is left.
 */
export function resourceFolderSegment(name: unknown): string | null {
  if (typeof name !== "string") return null;
  const segment = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/[/\\]+/g, "-")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, RESOURCE_PATH_MAX_SEGMENT)
    .trim();
  if (!segment || segment === "." || segment === "..") return null;
  return segment;
}

/**
 * Top-level folders that, by convention, hold one subfolder per customer or
 * project. "Customers" and "Projects" are the starter vault's folders;
 * "Clients" is the common alternative some companies use instead.
 */
export const CUSTOMER_FOLDER_ROOTS = ["Customers", "Clients"] as const;
export const PROJECT_FOLDER_ROOTS = ["Projects"] as const;

export type ResourceFolderOwner = { kind: "customer" | "project"; name: string };

/**
 * The key two folder segments are compared by: Unicode-compatibility folded
 * (NFKC, so a full-width "Ｃｕｓｔｏｍｅｒｓ" or a ligature matches its plain
 * spelling) and lowercased. Use it on both sides of every convention match.
 */
export function resourceFolderMatchKey(segment: string): string {
  return segment.normalize("NFKC").toLowerCase();
}

/**
 * Which customer or project a folder belongs to by convention:
 * "Customers/Harbor Dental/Meetings" -> customer "Harbor Dental".
 * Folders outside the convention belong to nobody in particular (null).
 */
export function resourceFolderOwner(path: string): ResourceFolderOwner | null {
  const segments = normalizeResourcePath(path).split("/").filter(Boolean);
  if (segments.length < 2) return null;
  const top = resourceFolderMatchKey(segments[0]);
  if (CUSTOMER_FOLDER_ROOTS.some((root) => resourceFolderMatchKey(root) === top)) return { kind: "customer", name: segments[1] };
  if (PROJECT_FOLDER_ROOTS.some((root) => resourceFolderMatchKey(root) === top)) return { kind: "project", name: segments[1] };
  return null;
}

/**
 * The conventional folder for a customer- or project-scoped note when the
 * writer did not choose one, or null to keep today's behaviour (vault root).
 *
 * The convention only applies when the company already uses it — a
 * "Customers" (or "Clients") / "Projects" top-level folder exists — so a vault
 * organised some other way is never given a competing tree. An existing
 * subfolder for the same customer/project is reused with its exact casing.
 */
export function defaultResourceFolderFor(input: {
  scopeType: string | null | undefined;
  /** Customer name or project goal. */
  ownerName: string | null | undefined;
  /** Every folder path currently in use in the company's vault. */
  existingPaths: Array<string | null | undefined>;
}): string | null {
  const roots: readonly string[] = input.scopeType === "customer"
    ? CUSTOMER_FOLDER_ROOTS
    : input.scopeType === "project"
      ? PROJECT_FOLDER_ROOTS
      : [];
  if (roots.length === 0) return null;
  const segment = resourceFolderSegment(input.ownerName);
  if (!segment) return null;

  const paths = input.existingPaths.map((path) => normalizeResourcePath(path)).filter(Boolean);
  const firstSegments = paths.map((path) => path.split("/")[0]);
  let root: string | null = null;
  for (const candidate of roots) {
    const existing = firstSegments.find((first) => resourceFolderMatchKey(first) === resourceFolderMatchKey(candidate));
    if (existing) {
      root = existing;
      break;
    }
  }
  if (!root) return null;

  const wanted = resourceFolderMatchKey(`${root}/${segment}`);
  for (const path of paths) {
    const ownerFolder = path.split("/").slice(0, 2).join("/");
    if (resourceFolderMatchKey(ownerFolder) === wanted) return ownerFolder;
  }
  return normalizeResourcePath(`${root}/${segment}`);
}
