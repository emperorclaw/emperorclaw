// Which task a run worked on, when the runtime did not say. Most runs are
// triggered by a system message ("New task assigned to you: [...]") and carry
// no task id, so the ledger, the Timeline and every "where did the time go"
// view filed them as chat. These are the PURE decision rules; the database
// reads, the same-company/live-task validation and the writes live in
// run-task-attribution-store.ts. Unit-tested in
// tests/unit/run-task-attribution.test.ts.
//
// The rules, in order. A run whose task_id is already set is never touched.
//
//  (a) trigger_metadata — at start: the trigger message is a SYSTEM message
//      (sender_type 'system': the "New task assigned to you" wake, the stall
//      nudge, the onboarding brief — server code only; MCP callers can never
//      post as system), its metadata names exactly one task (`taskIds` with one
//      id, or `taskId`), and it was addressed to this agent (or to nobody in
//      particular). An agent's or a person's message is never trusted, whatever
//      its metadata says. A message that names several tasks is ambiguous and
//      attributes nothing.
//  (c) task_events — at finish: the task this same agent acted on during the
//      run window (notes, status changes, claims: any task_events row with
//      actor_type 'agent' and actor_id = the run's agent between started_at and
//      ended_at). The task with the most events wins; ties go to the task
//      acted on last. Skipped when the same agent has ANOTHER run whose window
//      overlaps this one (a runtime with concurrency > 1): the events cannot
//      be told apart, and filing them under both runs would double count the
//      task's time. A `lost` run does not count as overlapping — its ended_at
//      is when the closer gave up on it, not when it stopped working.
//
// Every candidate — from (a), (c) or a task id the runtime sent itself — is
// then validated by the store: a live (not deleted) task of the run's company
// in a live project, inside the run agent's data scope (agents.scope_json
// customers/projects, the same rule every /api/mcp task route applies).
// Nothing is ever attributed across companies or outside the agent's scope.

export const RUN_TASK_RULES = ["trigger_metadata", "task_events"] as const;
export type RunTaskRule = (typeof RUN_TASK_RULES)[number];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: unknown): value is string {
    return typeof value === "string" && UUID_RE.test(value.trim());
}

/**
 * The single task a trigger message's metadata names, or null. `taskIds` wins
 * when present: exactly one distinct valid id attributes it, anything else
 * (empty, several ids, malformed) attributes nothing — even if a `taskId` is
 * also set, since the message is about several tasks. Without `taskIds`, a
 * valid `taskId` is used.
 */
export function taskFromTriggerMetadata(metadata: unknown): string | null {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
    const meta = metadata as Record<string, unknown>;
    if (Array.isArray(meta.taskIds) && meta.taskIds.length > 0) {
        const distinct = [...new Set(meta.taskIds.map((id) => (typeof id === "string" ? id.trim().toLowerCase() : "")))];
        return distinct.length === 1 && isUuid(distinct[0]) ? distinct[0] : null;
    }
    if (isUuid(meta.taskId)) return meta.taskId.trim().toLowerCase();
    return null;
}

/** The only sender whose trigger metadata rule (a) trusts (server-written notices). */
export const TRUSTED_TRIGGER_SENDER_TYPE = "system";

export interface TriggerMessageInput {
    companyId: string;
    senderType: string;
    targetAgentId: string | null;
    metadataJson: unknown;
}

/**
 * Rule (a): the task candidate a run's trigger message gives it, or null. The
 * message must be a system message of the run's company, and when it targets
 * an agent it must target the run's own agent (a wake for another agent says
 * nothing about this run).
 */
export function triggerTaskCandidate(message: TriggerMessageInput | null | undefined, run: { companyId: string; agentId: string | null }): string | null {
    if (!message || message.companyId !== run.companyId) return null;
    if (message.senderType !== TRUSTED_TRIGGER_SENDER_TYPE) return null;
    if (message.targetAgentId && run.agentId && message.targetAgentId !== run.agentId) return null;
    return taskFromTriggerMetadata(message.metadataJson);
}

/** One task's activity by the run's agent inside the run window. */
export interface TaskActivity {
    taskId: string;
    /** task_events rows by the agent on this task inside the window. */
    events: number;
    /** The latest of those rows (epoch ms). */
    lastAtMs: number;
}

/**
 * Rule (c): the task the agent acted on most during the run, ties broken by
 * the most recent activity, then by task id (so the choice is deterministic).
 * Groups with no events are ignored.
 */
export function pickActivityTask(groups: readonly TaskActivity[]): string | null {
    let best: TaskActivity | null = null;
    for (const group of groups) {
        if (!group.taskId || !(group.events > 0)) continue;
        if (
            !best ||
            group.events > best.events ||
            (group.events === best.events && group.lastAtMs > best.lastAtMs) ||
            (group.events === best.events && group.lastAtMs === best.lastAtMs && group.taskId > best.taskId)
        ) best = group;
    }
    return best?.taskId ?? null;
}

/** Fold raw (taskId, at) activity rows into per-task groups for `pickActivityTask`. */
export function groupActivity(rows: readonly { taskId: string; atMs: number }[]): TaskActivity[] {
    const map = new Map<string, TaskActivity>();
    for (const row of rows) {
        const group = map.get(row.taskId) ?? { taskId: row.taskId, events: 0, lastAtMs: -Infinity };
        group.events += 1;
        group.lastAtMs = Math.max(group.lastAtMs, row.atMs);
        map.set(row.taskId, group);
    }
    return [...map.values()];
}

/**
 * Whether rule (c) can run for a run: it has an agent, a finished window, and
 * no task yet.
 */
export function needsActivityAttribution(run: { taskId: string | null; agentId: string | null; endedAt: Date | null }): boolean {
    return !run.taskId && Boolean(run.agentId) && run.endedAt != null;
}

/** A run window; a null end is still open (running). */
export interface RunWindow {
    startedAtMs: number;
    endedAtMs: number | null;
}

/**
 * Whether two run windows overlap (strictly: a run that starts exactly when
 * the other ends does not). An open window extends forever. The SQL twin is
 * `hasOverlappingRun` in run-task-attribution-store.ts.
 */
export function runWindowsOverlap(a: RunWindow, b: RunWindow): boolean {
    const aEnd = a.endedAtMs ?? Infinity;
    const bEnd = b.endedAtMs ?? Infinity;
    return a.startedAtMs < bEnd && b.startedAtMs < aEnd;
}
