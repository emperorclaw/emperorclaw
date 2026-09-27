/**
 * Live Emperor records in chat. An agent links a record as
 *
 *   [Q3 churn report](emperor://task/<uuid>)
 *
 * and the chat renders it as a chip (inline) or a card (a line holding only
 * record links) showing the record's CURRENT state, fetched from Emperor —
 * unlike a chart, it never goes stale. Anywhere the link can't render (older
 * UI, exports, another agent reading history) it degrades to its label.
 */

export const ENTITY_KINDS = ["task", "project", "agent"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

export interface EntityRef {
    kind: EntityKind;
    id: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_URL_RE = /^emperor:\/\/(task|project|agent)s?\/([0-9a-f-]{36})\/?$/i;

/** Max refs one lookup may ask for; a message with more renders the rest as plain chips. */
export const MAX_ENTITY_REFS = 50;

export function parseEntityUrl(url: string | null | undefined): EntityRef | null {
    if (!url) return null;
    const match = ENTITY_URL_RE.exec(url.trim());
    if (!match || !UUID_RE.test(match[2])) return null;
    return { kind: match[1].toLowerCase() as EntityKind, id: match[2].toLowerCase() };
}

export function entityKey(ref: EntityRef): string {
    return `${ref.kind}:${ref.id}`;
}

/** Parse a `kind:uuid` key from the lookup query string. */
export function parseEntityKey(key: string): EntityRef | null {
    const [kind, id] = key.split(":");
    if (!kind || !id || !(ENTITY_KINDS as readonly string[]).includes(kind) || !UUID_RE.test(id)) return null;
    return { kind: kind as EntityKind, id: id.toLowerCase() };
}

export interface TaskSummary {
    kind: "task";
    id: string;
    title: string;
    state: string;
    priority: number;
    assignee: string | null;
    project: string | null;
    dueAt: string | null;
    updatedAt: string;
    href: string;
}

export interface ProjectSummary {
    kind: "project";
    id: string;
    title: string;
    status: string;
    lead: string | null;
    openTasks: number;
    doneTasks: number;
    href: string;
}

export interface AgentSummary {
    kind: "agent";
    id: string;
    title: string;
    role: string | null;
    status: string;
    load: number;
    openTasks: number;
    avatarUrl: string | null;
    lastSeenAt: string | null;
    href: string;
}

export type EntitySummary = TaskSummary | ProjectSummary | AgentSummary;

/** Task title as the board shows it: `inputJson.title`, else the task type. */
export function taskTitle(task: { inputJson?: unknown; taskType?: string | null }): string {
    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
    const title = typeof input.title === "string" ? input.title.trim() : "";
    return title || task.taskType || "Untitled task";
}

/** Tone for a record's state, shared by chips and cards. */
export function entityTone(summary: EntitySummary): "positive" | "active" | "warning" | "muted" | "negative" {
    const value = (summary.kind === "task" ? summary.state : summary.status).toLowerCase();
    if (["done", "completed", "complete", "resolved", "online"].includes(value)) return "positive";
    if (["in_progress", "running", "active", "acting", "busy"].includes(value)) return "active";
    if (["review", "blocked", "paused", "waiting", "needs_review"].includes(value)) return "warning";
    if (["failed", "error", "cancelled", "canceled"].includes(value)) return "negative";
    return "muted";
}

export function humanizeState(value: string): string {
    const text = value.replace(/[_-]+/g, " ").trim();
    return text ? text[0].toUpperCase() + text.slice(1) : value;
}
