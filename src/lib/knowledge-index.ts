/**
 * Pure rendering/ordering for the lean knowledge index and the always-block.
 * The DB-backed builder in `resources.ts` calls these so ordering, caps and
 * budget truncation can be unit-tested without a database.
 */
import type { KnowledgeInjectMode } from "@/lib/knowledge-summary";

export const KNOWLEDGE_INDEX_MAX_LINES = 25;
export const KNOWLEDGE_INDEX_MAX_CHARS = 2500;
export const KNOWLEDGE_ALWAYS_MAX_CHARS = 1500;

/** Marker appended when the always-block budget cuts the last note short. */
export const ALWAYS_TRUNCATION_MARKER = "\n\u2026[Emperor: always budget reached]";

export type KnowledgeIndexNote = {
  id: string;
  title: string;
  summary: string;
  scopeType: string;
  scopeId?: string | null;
  inject?: KnowledgeInjectMode | string;
  updatedAt: Date | string | number;
  configText?: string;
};

export type KnowledgeIndexResult = {
  text: string;
  lines: string[];
  ids: string[];
  truncated: boolean;
};

export type AlwaysBlockResult = {
  text: string;
  ids: string[];
  usedChars: number;
  overBudget: boolean;
};

/**
 * Scope specificity: an agent's own note first, then project/customer notes,
 * then company-wide doctrine last.
 */
export function scopeSpecificityRank(scopeType: string): number {
  if (scopeType === "agent") return 0;
  if (scopeType === "project" || scopeType === "customer") return 1;
  return 2;
}

/** Operating/doctrine notes lead within a scope tier. */
export function doctrineRank(note: Pick<KnowledgeIndexNote, "title">): number {
  return /operating|doctrine/i.test(note.title) ? 0 : 1;
}

function recency(note: Pick<KnowledgeIndexNote, "updatedAt">): number {
  const value = new Date(note.updatedAt).getTime();
  return Number.isFinite(value) ? value : 0;
}

/** Order for the index: scope specificity, then doctrine, then recency. */
export function orderKnowledgeNotesForIndex<T extends KnowledgeIndexNote>(notes: T[]): T[] {
  return [...notes].sort(
    (left, right) =>
      scopeSpecificityRank(left.scopeType) - scopeSpecificityRank(right.scopeType) ||
      doctrineRank(left) - doctrineRank(right) ||
      recency(right) - recency(left),
  );
}

/**
 * One line per note: `title — summary — id`. Stops at the first line that would
 * exceed the character budget (so a line is never split) or at maxLines.
 */
export function renderKnowledgeIndex(
  notes: KnowledgeIndexNote[],
  options: { maxLines?: number; maxChars?: number } = {},
): KnowledgeIndexResult {
  const maxLines = options.maxLines ?? KNOWLEDGE_INDEX_MAX_LINES;
  const maxChars = options.maxChars ?? KNOWLEDGE_INDEX_MAX_CHARS;
  const lines: string[] = [];
  const ids: string[] = [];
  let used = 0;

  for (const note of notes) {
    if (lines.length >= maxLines) break;
    const line = `${note.title} \u2014 ${note.summary} \u2014 ${note.id}`;
    const separator = lines.length === 0 ? 0 : 1;
    if (used + separator + line.length > maxChars) break;
    lines.push(line);
    ids.push(note.id);
    used += separator + line.length;
  }

  return { text: lines.join("\n"), lines, ids, truncated: ids.length < notes.length };
}

/**
 * Concatenate the bodies of always-injected notes under a hard character
 * budget. Ordering is the caller's responsibility (index order). The final
 * note that does not fit is cut and marked; nothing after it is included.
 */
export function buildAlwaysBlock(
  notes: KnowledgeIndexNote[],
  options: { maxChars?: number } = {},
): AlwaysBlockResult {
  const maxChars = options.maxChars ?? KNOWLEDGE_ALWAYS_MAX_CHARS;
  const bodies = notes.map((note) => (note.configText ?? "").trim());
  const rawTotal = bodies.reduce((total, body) => total + body.length, 0);

  let text = "";
  let used = 0;
  let truncated = false;
  const ids: string[] = [];

  for (let index = 0; index < notes.length; index += 1) {
    const body = bodies[index];
    if (!body) continue;
    const separator = text ? "\n\n" : "";
    if (used + separator.length + body.length <= maxChars) {
      text += separator + body;
      used += separator.length + body.length;
      ids.push(notes[index].id);
      continue;
    }
    const remaining = maxChars - used - separator.length;
    if (remaining > ALWAYS_TRUNCATION_MARKER.length) {
      text += separator + body.slice(0, remaining - ALWAYS_TRUNCATION_MARKER.length).trimEnd() + ALWAYS_TRUNCATION_MARKER;
      used = maxChars;
      ids.push(notes[index].id);
    }
    truncated = true;
    break;
  }

  return { text, ids, usedChars: text.length, overBudget: truncated || rawTotal > maxChars };
}
