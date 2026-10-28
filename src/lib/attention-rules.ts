/**
 * Pure rules for the "Needs me" inbox (src/lib/attention.ts builds the
 * entries). No database here: grouping, ordering, member-scope filtering and
 * the counts the nav badge shows are unit-tested on their own
 * (tests/unit/attention.test.ts).
 */

import { attentionUrgency, requiresHumanAction, type AttentionEntry, type AttentionKind } from "@/lib/team-scene";

/** The three inbox sections, most urgent first. */
export type AttentionGroup = "decide" | "blocked" | "fyi";

export const ATTENTION_GROUPS: readonly AttentionGroup[] = ["decide", "blocked", "fyi"];

export const ATTENTION_GROUP_LABEL: Record<AttentionGroup, string> = {
    decide: "Needs a decision",
    blocked: "Blocked or failing",
    fyi: "FYI",
};

/** Failure kinds turn the Inbox badge red ("broken", not just "unread"). */
const FAILURE_KINDS: ReadonlySet<AttentionKind> = new Set(["incident", "agent", "run_failed", "task_blocked", "request"]);

/**
 * One definition of "needs you": requiresHumanAction (team-scene.ts), which
 * the dashboard's Action inbox, its "actions required" card, /inbox and the
 * Inbox badge all use. Needs-you items split into decisions and blockers;
 * everything else (slow replies, late or unowned-but-assigned work, mentions)
 * is FYI and never counted as needing you.
 */
export function attentionGroup(entry: AttentionEntry): AttentionGroup {
    if (!requiresHumanAction(entry)) return "fyi";
    return entry.kind === "approval" || entry.kind === "decision" ? "decide" : "blocked";
}

export function needsYou(entry: AttentionEntry): boolean {
    return attentionGroup(entry) !== "fyi";
}

export function isFailure(entry: AttentionEntry): boolean {
    return FAILURE_KINDS.has(entry.kind) || (entry.kind === "message" && entry.actionRequired === true);
}

/**
 * Inbox order: decisions, then blockers, then FYI; inside a group the most
 * urgent kind first and, for the same kind, the oldest first (it has waited
 * longest). Stable for equal keys, so rows do not jump between refreshes.
 */
export function sortAttention(entries: readonly AttentionEntry[]): AttentionEntry[] {
    const groupRank = (e: AttentionEntry) => ATTENTION_GROUPS.indexOf(attentionGroup(e));
    return entries
        .map((entry, index) => ({ entry, index }))
        .sort((a, b) => groupRank(a.entry) - groupRank(b.entry)
            || attentionUrgency(a.entry.kind) - attentionUrgency(b.entry.kind)
            || a.entry.at.localeCompare(b.entry.at)
            || a.index - b.index)
        .map(({ entry }) => entry);
}

/**
 * What a restricted member may see (src/lib/member-scope.ts): undefined = no
 * limit on that axis, an empty list = nothing on that axis (fail closed).
 */
export interface AttentionScope {
    agentIds?: readonly string[];
    customerIds?: readonly string[];
    /** Projects granted directly (0.20 project Access), visible whatever their customer. */
    projectIds?: readonly string[];
}

/** The agent an entry is about, from its explicit agent id or its member key. */
export function entryAgentId(entry: AttentionEntry): string | null {
    if (entry.agentId) return entry.agentId;
    return entry.memberKey?.startsWith("agent:") ? entry.memberKey.slice("agent:".length) : null;
}

/**
 * Drop entries a restricted member must not see: anything about an agent
 * outside their agent list, and anything in a project whose customer is
 * outside their customer list (a project with no customer is outside too),
 * unless the project itself is on their project list.
 * Entries tied to neither an agent nor a project pass.
 */
export function applyAttentionScope(entries: readonly AttentionEntry[], scope: AttentionScope | null | undefined): AttentionEntry[] {
    if (!scope) return [...entries];
    const agents = scope.agentIds ? new Set(scope.agentIds) : null;
    const customers = scope.customerIds ? new Set(scope.customerIds) : null;
    const projects = new Set(scope.projectIds ?? []);
    if (!agents && !customers) return [...entries];
    return entries.filter((entry) => {
        const agentId = entryAgentId(entry);
        if (agents && agentId && !agents.has(agentId)) return false;
        if (customers && entry.projectId && !(entry.customerId && customers.has(entry.customerId)) && !projects.has(entry.projectId)) return false;
        return true;
    });
}

export interface AttentionCounts {
    /** Decisions plus blockers: the inbox header. */
    needsYou: number;
    decide: number;
    blocked: number;
    fyi: number;
    approvals: number;
    hasFailures: boolean;
    /** Needs-you items this person has not read yet (src/lib/inbox-state-rules.ts): the Inbox badge. */
    unread: number;
}

export function attentionCounts(entries: readonly AttentionEntry[]): AttentionCounts {
    const counts: AttentionCounts = { needsYou: 0, decide: 0, blocked: 0, fyi: 0, approvals: 0, hasFailures: false, unread: 0 };
    for (const entry of entries) {
        const group = attentionGroup(entry);
        counts[group] += 1;
        if (group !== "fyi") counts.needsYou += 1;
        if (group !== "fyi" && entry.read !== true) counts.unread += 1;
        if (entry.kind === "approval") counts.approvals += 1;
        if (isFailure(entry)) counts.hasFailures = true;
    }
    return counts;
}

/**
 * The inbox views. "needs" (the default) lists exactly what the header and the
 * badge count; "decide" and "blocked" split it in two (they sum to it); "fyi"
 * is the rest, counted separately and never as needing you.
 */
export type InboxFilter = "needs" | "decide" | "blocked" | "fyi";

export const INBOX_FILTERS: readonly InboxFilter[] = ["needs", "decide", "blocked", "fyi"];

/** Old links (?filter=approvals, ?filter=problems) keep working. */
export function parseInboxFilter(value: string | null | undefined): InboxFilter {
    if (value === "approvals") return "decide";
    if (value === "problems") return "blocked";
    return INBOX_FILTERS.includes(value as InboxFilter) ? value as InboxFilter : "needs";
}

export function matchesInboxFilter(entry: AttentionEntry, filter: InboxFilter): boolean {
    const group = attentionGroup(entry);
    return filter === "needs" ? group !== "fyi" : group === filter;
}

/** The count each view shows: always the number of rows it lists. */
export function inboxFilterCount(counts: Pick<AttentionCounts, "needsYou" | "decide" | "blocked" | "fyi">, filter: InboxFilter): number {
    return filter === "needs" ? counts.needsYou : counts[filter];
}

/**
 * "Working now", the one definition behind the Home badge and the dashboard's
 * "working now" card, mirroring the office scene's Working status: an agent
 * is typing, or its runtime is connected (heartbeat or a fresh open run) and
 * it holds an in-progress task that no open task problem is stopping. An agent
 * reported down is never working.
 */
export function workingNowAgentIds(input: {
    typing: ReadonlySet<string>;
    connected: ReadonlySet<string>;
    down: ReadonlySet<string>;
    inProgress: readonly { agentId: string; taskId: string }[];
    entries: readonly AttentionEntry[];
}): string[] {
    const stuckTasks = new Set<string>();
    const stuckAgents = new Set<string>();
    for (const e of input.entries) {
        if (e.kind !== "incident") continue;
        const agentId = entryAgentId(e);
        if (e.taskId) stuckTasks.add(e.taskId);
        else if (agentId) stuckAgents.add(agentId);
    }
    const out = new Set<string>(input.typing);
    for (const t of input.inProgress) {
        if (input.down.has(t.agentId) || !input.connected.has(t.agentId) || stuckAgents.has(t.agentId) || stuckTasks.has(t.taskId)) continue;
        out.add(t.agentId);
    }
    return [...out].sort();
}

export const FAILED_RUN_STATUSES: ReadonlySet<string> = new Set(["failed", "timeout", "lost"]);

/**
 * Failed runs worth a person's attention: one per agent (its latest finished
 * run), and only while that latest run failed and no newer run has started
 * since. A retry that succeeded, or a run in progress, clears it.
 */
export function latestFailedRuns<R extends { id: string; agentId: string | null; status: string; startedAt: Date }>(runs: readonly R[]): R[] {
    const latest = new Map<string, R>();
    for (const run of runs) {
        if (!run.agentId) continue;
        const current = latest.get(run.agentId);
        if (!current || run.startedAt.getTime() > current.startedAt.getTime()) latest.set(run.agentId, run);
    }
    return [...latest.values()].filter((run) => FAILED_RUN_STATUSES.has(run.status));
}

/** One short line from a run's exit reason or error, never more than `max` characters. */
export function runFailureReason(run: { status: string; exitReason?: string | null; error?: string | null }, max = 90): string {
    const raw = (run.error || run.exitReason || "").replace(/\s+/g, " ").trim();
    const fallback = run.status === "timeout" ? "Timed out" : run.status === "lost" ? "The runtime stopped reporting" : "Failed";
    if (!raw) return fallback;
    return raw.length > max ? `${raw.slice(0, max - 1)}…` : raw;
}

/** Plain words from a chat message: rich blocks (```stats, ```choices) and markdown marks dropped. */
export function plainText(text: string): string {
    // Stored notification bodies may hold a flattened rich block
    // ("stats [{...}]"): keep only the prose before it.
    const block = text.search(/(^|\s)[a-z][\w-]*\s*[[{]\s*[[{"]/i);
    return (block >= 0 ? text.slice(0, block) : text)
        .replace(/(`{3,}|~{3,})[\s\S]*?(\1|$)/g, " ")
        .replace(/[*_#>`]+/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
}
