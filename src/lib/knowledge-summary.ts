/**
 * Derivation and bounds for a Knowledge note's one-line summary, plus the
 * injection-mode mapping. Deliberately db-free so it can run in the migration
 * backfill, on the server, and in unit tests without a database.
 */

/** Stored ceiling for `scoped_resources.summary` (enforced in app code). */
export const KNOWLEDGE_SUMMARY_MAX_CHARS = 200;

/** Ceiling for an auto-derived summary (frontmatter or first sentence). */
export const DERIVED_SUMMARY_MAX_CHARS = 140;

export const KNOWLEDGE_INJECT_MODES = ["always", "index", "on_request"] as const;
export type KnowledgeInjectMode = (typeof KNOWLEDGE_INJECT_MODES)[number];

export function isKnowledgeInjectMode(value: unknown): value is KnowledgeInjectMode {
  return typeof value === "string" && (KNOWLEDGE_INJECT_MODES as readonly string[]).includes(value);
}

/**
 * Unknown application input falls back to `index`. (The DB column default is
 * `on_request`, which only matters for writers that bypass this normalizer and
 * omit the column entirely — see the 0060 migration.)
 */
export function normalizeKnowledgeInjectMode(input: unknown): KnowledgeInjectMode {
  const value = typeof input === "string" ? input.trim().toLowerCase() : "";
  return isKnowledgeInjectMode(value) ? value : "index";
}

/** Legacy mapping: a shared note is `index`; an unshared one is `on_request`. */
export function injectModeFromIsShared(isShared: boolean): KnowledgeInjectMode {
  return isShared ? "index" : "on_request";
}

/** The kept-in-step boolean: only `on_request` is not shared. */
export function isSharedFromInjectMode(inject: KnowledgeInjectMode): boolean {
  return inject !== "on_request";
}

/** Trim and clamp a summary to the stored ceiling. */
export function clampKnowledgeSummary(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= KNOWLEDGE_SUMMARY_MAX_CHARS) return trimmed;
  return trimmed.slice(0, KNOWLEDGE_SUMMARY_MAX_CHARS).trimEnd();
}

function frontmatterBlock(markdown: string): string | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  return match?.[1] ?? null;
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
}

/** Read `summary:` from Obsidian-style frontmatter, including a YAML block scalar. */
function frontmatterSummary(markdown: string): string | null {
  const block = frontmatterBlock(markdown);
  if (!block) return null;
  const lines = block.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^\s*summary\s*:\s*(.*)$/i);
    if (!match) continue;
    let raw = match[1].trim();
    if (!raw || raw === "|" || raw === ">") {
      const parts: string[] = [];
      for (let child = index + 1; child < lines.length; child += 1) {
        if (!/^\s+\S/.test(lines[child])) break;
        parts.push(lines[child].trim());
      }
      raw = parts.join(" ");
    }
    raw = raw.replace(/^['"]|['"]$/g, "").trim();
    return raw || null;
  }
  return null;
}

/** Reduce markdown to readable prose so the auto-summary is not full of syntax. */
function stripMarkdown(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}[^\n]*$/gm, " ")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/[*_~]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, maxChars: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}\u2026`;
}

/**
 * The note summary: frontmatter `summary:` when present, otherwise the first
 * sentence of the body with markdown stripped, bounded to 140 chars.
 */
export function deriveKnowledgeSummary(configText: string, maxChars = DERIVED_SUMMARY_MAX_CHARS): string {
  const configured = frontmatterSummary(configText);
  if (configured) return truncate(configured, maxChars);

  const body = stripMarkdown(stripFrontmatter(configText));
  if (!body) return "";
  const sentence = body.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? body;
  return truncate(sentence, maxChars);
}
