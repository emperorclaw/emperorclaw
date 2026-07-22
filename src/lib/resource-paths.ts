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
