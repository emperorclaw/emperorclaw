// The task page "story" (docs/roadmap/product-decisions.md §4, slices 10.4 and
// 10.5): one merged, newest-first list of everything that happened to a task,
// task events, approvals, files, linked messages and agent runs, grouped by
// day. Everything here is pure and client-safe; the database read lives in
// task-story-reads.ts.

import type { MemberScope } from "@/lib/member-scope";
import { copy, type CodedCopy, type CopyValue } from "@/lib/coded-copy";

/** Where the task timeline's event lines live in messages/en.json. */
const EVENT_COPY = "tasks.timeline.events";

/** Entries per page; older ones load with "Load older". */
export const TASK_STORY_PAGE_SIZE = 50;

/** Where a task's full page lives. Deep links (notifications, inbox, Right now) point here. */
export function taskHref(taskId: string, runId?: string | null): string {
    return `/projects/tasks/${encodeURIComponent(taskId)}${runId ? `#run-${runId}` : ""}`;
}

// ─── Run outcome (10.5) ─────────────────────────────────────────────────────

/**
 * What a run meant for the task, computed on read from existing rows:
 *
 * | agent_runs.status          | extra signal                                   | outcome   |
 * |----------------------------|------------------------------------------------|-----------|
 * | running                    |                                                | running   |
 * | succeeded                  | approval it requested is still pending, or an  | needs_you |
 * |                            | exit reason asking for a human (approval,      |           |
 * |                            | clarification, input)                          |           |
 * | succeeded                  | otherwise                                      | done      |
 * | blocked                    |                                                | needs_you |
 * | failed / timeout / lost    |                                                | failed    |
 * | cancelled                  |                                                | stopped   |
 * | anything else              | (unknown status from a newer runtime)          | stopped   |
 */
export type RunOutcome = "running" | "done" | "needs_you" | "failed" | "stopped";

export const RUN_OUTCOME_LABEL: Record<RunOutcome, string> = {
    running: "Running",
    done: "Done",
    needs_you: "Needs you",
    failed: "Failed",
    stopped: "Stopped",
};

const NEEDS_HUMAN_EXIT_RE = /approval|clarif|human|input[_ ]required|needs?[_ ]input|ask[_ ]user/i;

export function runOutcome(
    run: { status: string; exitReason?: string | null },
    context: { pendingApproval?: boolean } = {},
): RunOutcome {
    switch (run.status) {
        case "running":
            return "running";
        case "failed":
        case "timeout":
        case "lost":
            return "failed";
        case "cancelled":
            return "stopped";
        case "blocked":
            return "needs_you";
        case "succeeded":
            if (context.pendingApproval) return "needs_you";
            if (run.exitReason && NEEDS_HUMAN_EXIT_RE.test(run.exitReason)) return "needs_you";
            return "done";
        default:
            return "stopped";
    }
}

/** An approval belongs to a run when it was requested while the run was open (plus a short grace for the finish to land). */
export const RUN_APPROVAL_GRACE_MS = 2 * 60 * 1000;

export function approvalInRun(
    approvalRequestedAtMs: number,
    run: { startedAtMs: number; endedAtMs: number | null },
    graceMs = RUN_APPROVAL_GRACE_MS,
): boolean {
    if (approvalRequestedAtMs < run.startedAtMs) return false;
    if (run.endedAtMs == null) return true;
    return approvalRequestedAtMs <= run.endedAtMs + graceMs;
}

// ─── Entries ────────────────────────────────────────────────────────────────

export type StoryActor = { type: "agent" | "human" | "system"; name: string | null };

export type EventTone = "note" | "state" | "assign" | "created" | "system" | "problem";

export interface StoryEventEntry {
    kind: "event";
    id: string;
    at: string;
    actor: StoryActor;
    tone: EventTone;
    /** One line ("Moved to Review", "Assigned to Atlas"). */
    text: string;
    /** The line as coded copy for the viewer's language; null for an event type this build has no line for. */
    textCopy: CodedCopy | null;
    /** Full note text for notes and handoffs, shown expanded. */
    note: string | null;
}

export interface StoryApprovalEntry {
    kind: "approval";
    id: string;
    at: string;
    phase: "requested" | "decided";
    approvalId: string;
    status: string;
    actionType: string;
    requesterName: string | null;
    resolverName: string | null;
    /** Rationale on a request, the decision note on a decision. */
    note: string | null;
}

export interface StoryArtifactEntry {
    kind: "artifact";
    id: string;
    at: string;
    title: string;
    contentType: string;
    artifactClass: string;
    agentName: string | null;
    sizeBytes: number;
}

export interface StoryMessageEntry {
    kind: "message";
    id: string;
    at: string;
    senderLabel: string;
    threadLabel: string;
    /** Null when the thread is private to someone else: the entry stays, the text does not. */
    text: string | null;
    href: string | null;
}

export interface StoryRun {
    id: string;
    agentId: string | null;
    agentName: string | null;
    status: string;
    outcome: RunOutcome;
    triggerKind: string;
    startedAt: string;
    endedAt: string | null;
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costCents: number | null;
    toolCalls: number | null;
    model: string | null;
    exitReason: string | null;
    error: string | null;
    /** The run happened in a private chat the viewer is not part of: no thread, no reply text, steps redacted by the timeline API. */
    private: boolean;
    threadHref: string | null;
    threadLabel: string | null;
    reply: { messageId: string; excerpt: string | null; at: string | null } | null;
}

export interface StoryRunEntry {
    kind: "run";
    id: string;
    at: string;
    run: StoryRun;
}

export type StoryEntry = StoryEventEntry | StoryApprovalEntry | StoryArtifactEntry | StoryMessageEntry | StoryRunEntry;

// ─── Task events → lines ────────────────────────────────────────────────────

const STATE_LABEL: Record<string, string> = {
    inbox: "Inbox",
    queued: "Queued",
    in_progress: "In progress",
    review: "Review",
    blocked: "Blocked",
    done: "Done",
    failed: "Failed",
    dead_letter: "Dead letter",
};

export function taskStateLabel(state: string): string {
    return STATE_LABEL[state] ?? state.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string | null {
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface TaskEventInput {
    id: string;
    eventType: string;
    payloadJson: unknown;
    actorType: string;
    actorId: string | null;
    createdAt: string;
}

/** Name lookups for agents (by id) and members (by company_members id or user id). */
export interface StoryNames {
    agent: (id: string | null | undefined) => string | null;
    member: (id: string | null | undefined) => string | null;
}

/** A name for a line: the known name, or "an agent" / "a person" (with its message key). */
type StoryWho = { text: string; value: CopyValue };

const SOMEONE: Record<"agent" | "person", StoryWho> = {
    agent: { text: "an agent", value: copy(`${EVENT_COPY}.anAgent`) },
    person: { text: "a person", value: copy(`${EVENT_COPY}.aPerson`) },
};

function knownOr(name: string | null, fallback: "agent" | "person"): StoryWho {
    return name ? { text: name, value: name } : SOMEONE[fallback];
}

function assigneeName(value: unknown, names: StoryNames): StoryWho | null {
    const assignee = record(value);
    const id = str(assignee.id);
    if (assignee.type === "agent") return knownOr(names.agent(id), "agent");
    if (assignee.type === "human" || assignee.type === "member") return knownOr(names.member(id), "person");
    return null;
}

/** A task state as a message value: tasks.states.<state> (an unknown state falls back to the English line). */
const stateCopy = (state: string) => copy(`tasks.states.${state}`);
const line = (key: string, values?: Record<string, CopyValue>) => copy(`${EVENT_COPY}.${key}`, values);

/** One task_events row as a timeline line. Unknown event types still read sensibly. */
export function describeTaskEvent(event: TaskEventInput, names: StoryNames): Omit<StoryEventEntry, "kind" | "id" | "at"> {
    const payload = record(event.payloadJson);
    const actor: StoryActor = {
        type: event.actorType === "agent" ? "agent" : event.actorType === "human" ? "human" : "system",
        name: event.actorType === "agent" ? names.agent(event.actorId) : event.actorType === "human" ? names.member(event.actorId) : null,
    };
    const type = event.eventType;
    if (type === "task_note" || type === "task_handoff") {
        const handoff = record(payload.handoff);
        const kind = str(payload.kind);
        const from = str(handoff.fromRole);
        const to = str(handoff.toRole);
        const text = type === "task_handoff"
            ? `Handoff${from && to ? ` from ${from} to ${to}` : ""}`
            : kind === "blocker" ? "Blocker noted" : "Note";
        const textCopy = type === "task_handoff"
            ? (from && to ? line("handoffFromTo", { from, to }) : line("handoff"))
            : line(kind === "blocker" ? "blockerNoted" : "note");
        return { actor, tone: kind === "blocker" ? "problem" : "note", text, textCopy, note: str(payload.note) };
    }
    if (type === "task_generated") {
        const assignee = assigneeName(payload.assignee, names);
        return {
            actor, tone: "created", text: assignee ? `Created and assigned to ${assignee.text}` : "Created",
            textCopy: assignee ? line("createdAndAssigned", { who: assignee.value }) : line("created"), note: null,
        };
    }
    if (type === "task_assigned" || type === "task_claimed") {
        const who = knownOr(actor.name, "agent");
        return {
            actor, tone: "assign", text: type === "task_claimed" ? `Claimed by ${who.text}` : `Assigned to ${who.text}`,
            textCopy: line(type === "task_claimed" ? "claimedBy" : "assignedTo", { who: who.value }), note: null,
        };
    }
    if (type === "task_reassigned") {
        const next = assigneeName(payload.assignee, names);
        return { actor, tone: "assign", text: next ? `Reassigned to ${next.text}` : "Unassigned", textCopy: next ? line("reassignedTo", { who: next.value }) : line("unassigned"), note: null };
    }
    if (type === "task_updated") {
        const state = str(payload.state);
        return { actor, tone: "system", text: state ? `Updated · ${taskStateLabel(state)}` : "Details updated", textCopy: state ? line("updatedState", { state: stateCopy(state) }) : line("detailsUpdated"), note: null };
    }
    if (type === "lease_expired_retry") return { actor, tone: "problem", text: "Lease expired, queued for retry", textCopy: line("leaseExpired"), note: null };
    if (type === "dead_lettered") return { actor, tone: "problem", text: "Moved to dead letter after too many retries", textCopy: line("deadLettered"), note: null };
    if (type.startsWith("stall_")) {
        const escalated = type === "stall_escalation";
        return { actor, tone: "problem", text: escalated ? "Stall escalated to a person" : "Nudged after no progress", textCopy: line(escalated ? "stallEscalated" : "stallNudged"), note: null };
    }
    if (type.startsWith("task_")) {
        const state = type.slice("task_".length);
        const comment = str(payload.comment);
        const blockedReason = str(payload.blockedReason) ?? str(record(payload.inputJson).blockedReason);
        return {
            actor,
            tone: state === "failed" || state === "blocked" || state === "dead_letter" ? "problem" : "state",
            text: `Moved to ${taskStateLabel(state)}`,
            textCopy: line("movedTo", { state: stateCopy(state) }),
            note: comment ?? blockedReason,
        };
    }
    return { actor, tone: "system", text: type.replace(/_/g, " "), textCopy: null, note: null };
}

// ─── Merge, cap and group ───────────────────────────────────────────────────

function atMs(entry: { at: string }): number {
    const t = Date.parse(entry.at);
    return Number.isFinite(t) ? t : 0;
}

/**
 * Merge entries newest first. Ties keep a stable, meaningful order: a run
 * sorts above the events it caused at the same instant, then by id.
 */
export function mergeStory(...lists: readonly (readonly StoryEntry[])[]): StoryEntry[] {
    const rank: Record<StoryEntry["kind"], number> = { run: 0, approval: 1, artifact: 2, message: 3, event: 4 };
    return lists.flat().sort((a, b) => atMs(b) - atMs(a) || rank[a.kind] - rank[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The newest `limit` entries strictly older than `before` (ISO), plus whether more remain. */
export function pageStory(merged: readonly StoryEntry[], options: { limit?: number; before?: string | null } = {}): { entries: StoryEntry[]; hasMore: boolean; nextBefore: string | null } {
    const limit = Math.max(1, options.limit ?? TASK_STORY_PAGE_SIZE);
    const beforeMs = options.before ? Date.parse(options.before) : NaN;
    const eligible = Number.isFinite(beforeMs) ? merged.filter((entry) => atMs(entry) < beforeMs) : [...merged];
    const entries = eligible.slice(0, limit);
    const hasMore = eligible.length > limit;
    const last = entries[entries.length - 1];
    return { entries, hasMore, nextBefore: hasMore && last ? last.at : null };
}

/** YYYY-MM-DD of an instant in a time zone (en-CA formats as ISO dates). */
export function dayKey(iso: string, timeZone: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "unknown";
    try {
        return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
    } catch {
        return date.toISOString().slice(0, 10);
    }
}

function shiftDay(key: string, days: number): string {
    const [y, m, d] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** "Today", "Yesterday", "Mon, Oct 20" or, in another year, "Oct 20, 2025". */
export function dayLabel(key: string, now: Date, timeZone: string): string {
    const today = dayKey(now.toISOString(), timeZone);
    if (key === today) return "Today";
    if (key === shiftDay(today, -1)) return "Yesterday";
    const [y, m, d] = key.split("-").map(Number);
    if (!y || !m || !d) return key;
    const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
    const sameYear = today.slice(0, 4) === key.slice(0, 4);
    return new Intl.DateTimeFormat("en-US", sameYear
        ? { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }
        : { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(noonUtc);
}

/**
 * dayLabel's parts, for rendering in the viewer's language: today, yesterday,
 * or the day (noon UTC of that local date, formatted in UTC) with or without
 * its year. "raw" only for a key that is not a date.
 */
export function dayHeading(key: string, now: Date, timeZone: string):
    | { kind: "today" }
    | { kind: "yesterday" }
    | { kind: "raw" }
    | { kind: "date"; date: Date; sameYear: boolean } {
    const today = dayKey(now.toISOString(), timeZone);
    if (key === today) return { kind: "today" };
    if (key === shiftDay(today, -1)) return { kind: "yesterday" };
    const [y, m, d] = key.split("-").map(Number);
    if (!y || !m || !d) return { kind: "raw" };
    return { kind: "date", date: new Date(Date.UTC(y, m - 1, d, 12)), sameYear: today.slice(0, 4) === key.slice(0, 4) };
}

export interface StoryDay<T extends { at: string } = StoryEntry> {
    key: string;
    label: string;
    entries: T[];
}

/** Group newest-first entries by local day, keeping their order. */
export function groupStoryByDay<T extends { at: string }>(entries: readonly T[], options: { now: Date; timeZone: string }): StoryDay<T>[] {
    const days: StoryDay<T>[] = [];
    for (const entry of entries) {
        const key = dayKey(entry.at, options.timeZone);
        const last = days[days.length - 1];
        if (last && last.key === key) last.entries.push(entry);
        else days.push({ key, label: dayLabel(key, options.now, options.timeZone), entries: [entry] });
    }
    return days;
}

// ─── Member scope ───────────────────────────────────────────────────────────

/**
 * Whether a member may open a task. Mirrors member-scope.ts
 * (memberMaySeeProject / memberMaySeeTaskId), kept here without its database
 * imports so client code can use it: unrestricted viewers (null scope, which
 * includes owners and admins) see every task of their company; a restricted
 * member sees a task when its project's customer, or the project itself, is in
 * their scope. Internal projects without a customer are hidden from them
 * unless granted directly, as everywhere else.
 */
export function taskVisibleToScope(task: { customerId: string | null; projectId?: string | null }, scope: MemberScope | null): boolean {
    if (!scope || scope.mode !== "restricted") return true;
    if (task.customerId && (scope.customerIds ?? []).includes(task.customerId)) return true;
    return Boolean(task.projectId) && (scope.projectIds ?? []).includes(task.projectId as string);
}

/** Agent ids a scoped viewer may see runs of; null = unrestricted, [] = none. */
export function scopedAgentIds(scope: MemberScope | null): string[] | null {
    if (!scope || scope.mode !== "restricted") return null;
    return scope.agentIds ?? [];
}

// ─── Copy ───────────────────────────────────────────────────────────────────

/** "$0.21", or "<$0.01" for a fraction of a cent. */
export function formatCost(costCents: number | null | undefined): string | null {
    if (costCents == null || !Number.isFinite(costCents)) return null;
    if (costCents > 0 && costCents < 1) return "<$0.01";
    return `$${(costCents / 100).toFixed(2)}`;
}

/** Clip a message to a one-paragraph excerpt. */
export function excerpt(text: string | null | undefined, max = 280): string | null {
    if (typeof text !== "string") return null;
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return null;
    return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}
