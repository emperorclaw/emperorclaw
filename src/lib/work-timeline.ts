// The company "Timeline" page (docs/roadmap/product-decisions.md): a
// Gantt-style chart of which agents worked on what, when, and which agent
// handed work to which. Rows are AGENTS ONLY: a person's action (assigning a
// task, deciding an approval, a note) is never a row; it is a marker on the
// row of the agent that received it ("Assigned by Priya"). This module is the PURE builder — every input is a
// plain object and nothing touches the database — so it is unit-tested
// directly (tests/unit/work-timeline.test.ts). The database reads and the
// access/scope/privacy filtering live in work-timeline-reads.ts, which feeds
// already-filtered rows into buildWorkTimeline.
//
// Axis conventions: all times are epoch milliseconds. A "clipped" span sits
// inside the requested window [fromMs, toMs]; the raw start/end are kept
// alongside so a tooltip can show the true times. A running span (no end)
// draws to `nowMs`, clipped to the window.

import { runOutcome, type RunOutcome } from "@/lib/task-story";

/** The route rejects a window wider than this (whole days). */
export const MAX_WINDOW_DAYS = 31;
/** Hard caps that keep a 31-day company chart renderable; the caller reports `capped: true`. */
export const TIMELINE_SPAN_CAP = 2000;
export const TIMELINE_EVENT_CAP = 2000;
export const TIMELINE_EDGE_CAP = 1000;

/** Whether a run was handed to the agent ("delegated") or the agent acted on its own ("automation"). */
export type TimelineSource = "delegated" | "automation";

/** Rows are agents only. */
export type TimelineActorKind = "agent";

export interface TimelineActor {
    /** Canonical id: "agent:<id>". Shared by spans/events/edges. */
    id: string;
    kind: TimelineActorKind;
    name: string;
    /** Two-letter fallback when there is no avatar. */
    initials: string;
    /** Agent avatar endpoint, or null for the initials fallback. */
    avatarUrl: string | null;
    /** A stable colour for bars and markers (hsl(...)). */
    colour: string;
    runCount: number;
    busyMs: number;
    tokens: number;
    costCents: number;
}

export interface TimelineSpan {
    id: string;
    actorId: string;
    taskId: string | null;
    taskTitle: string | null;
    /** Short project label; null for chat runs. */
    projectName: string | null;
    kind: "task" | "chat";
    threadLabel: string | null;
    /** Deep link: the task page or the chat thread. */
    href: string | null;
    /** Clipped to the window (ms). */
    start: number;
    end: number;
    running: boolean;
    outcome: RunOutcome;
    /** Colour-by "Source": delegated work vs the agent acting on its own. */
    source: TimelineSource;
    /** Stable project id for colour-by "Project"; null for chat runs. */
    projectId: string | null;
    /** Raw run status, kept so a cancelled bar can draw hollow. */
    status: string;
    triggerKind: string;
    /** Raw values for tooltips — not clipped. */
    startedAtMs: number;
    endedAtMs: number | null;
    durationMs: number | null;
    tokens: number;
    costCents: number;
    toolCalls: number | null;
    model: string | null;
}

export type TimelineEventKind =
    | "created"
    | "assigned"
    | "status"
    | "note"
    | "approval_requested"
    | "approval_decided"
    | "file";

export interface TimelineEvent {
    id: string;
    /** The agent row the marker sits on (for a person's action: the agent that received it). */
    actorId: string;
    taskId: string;
    kind: TimelineEventKind;
    /** Epoch ms. */
    at: number;
    /** Display name of the person who caused the marker, or null when the agent itself acted. Never an email. */
    byName: string | null;
    /** Tooltip text, e.g. "Note", "Assigned by Priya", "Approved by Priya". */
    label: string;
}

export type TimelineEdgeKind = "created" | "assigned" | "reassigned" | "triggered_run";

export interface TimelineEdge {
    id: string;
    from: string;
    to: string;
    taskId: string;
    kind: TimelineEdgeKind;
    /** Epoch ms. */
    at: number;
}

export interface TimelineTotals {
    runs: number;
    busyMs: number;
    tokens: number;
    costCents: number;
    /** done / finished (non-running) runs, or null when nothing has finished. */
    successRate: number | null;
}

export interface WorkTimeline {
    actors: TimelineActor[];
    spans: TimelineSpan[];
    events: TimelineEvent[];
    edges: TimelineEdge[];
    totals: TimelineTotals;
    from: number;
    to: number;
    now: number;
    capped: boolean;
    /** True when a member scope hid work (rows are filtered); never a leak. */
    scoped: boolean;
}

export const EVENT_KIND_LABEL: Record<TimelineEventKind, string> = {
    created: "Created",
    assigned: "Assigned",
    status: "Status",
    note: "Note",
    approval_requested: "Approval requested",
    approval_decided: "Approval decided",
    file: "File",
};

export const EDGE_KIND_LABEL: Record<TimelineEdgeKind, string> = {
    created: "Created and assigned",
    assigned: "Assigned",
    reassigned: "Reassigned",
    triggered_run: "Triggered a run",
};

// ─── Span clipping ──────────────────────────────────────────────────────────

export interface ClippedSpan {
    start: number;
    end: number;
    /** A running span drew to `nowMs`. */
    running: boolean;
    /** False when the span lies entirely outside the window. */
    visible: boolean;
}

/**
 * Clip one run to the window. A span whose raw end is missing is "running"
 * and draws to `nowMs`; either way the clipped end never passes `toMs` and the
 * clipped start never precedes `fromMs`. Returns `visible: false` when the
 * span does not overlap the window at all.
 */
export function clipSpan(startMs: number, endMs: number | null, fromMs: number, toMs: number, nowMs: number): ClippedSpan {
    const running = endMs == null;
    const rawEnd = running ? nowMs : endMs;
    const start = Math.max(startMs, fromMs);
    const end = Math.min(rawEnd, toMs);
    const visible = end > fromMs && start < toMs && start < end;
    return { start, end, running, visible };
}

// ─── Actor helpers ──────────────────────────────────────────────────────────

/** "Atlas" → "AT", "Nova Kai" → "NK", "X" → "X", "" → "?" */
export function initialsOf(name: string | null | undefined): string {
    const clean = (name ?? "").trim().replace(/\s+/g, " ");
    if (!clean) return "?";
    const parts = clean.split(" ");
    if (parts.length === 1) return clean.slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** The stable colour for a bar/marker: a character hue for agents, a neutral for people. */
export function actorColour(kind: "agent" | "human", hue: number | null | undefined): string {
    if (kind === "agent") return `hsl(${((hue ?? 205) % 360 + 360) % 360} 72% 60%)`;
    return "hsl(215 16% 64%)";
}

// ─── Colour-by "Source" ─────────────────────────────────────────────────────

/**
 * Whether a run counts as "delegated" (another actor handed this work to the
 * agent) rather than "automation" (the agent acted on its own). Delegated =
 * another agent's message triggered the run, or another actor assigned its
 * task. Everything else — task/objective/self triggers — is automation.
 */
export function deriveRunSource(run: { triggeredByOtherAgent: boolean; assignedByOther: boolean }): TimelineSource {
    return run.triggeredByOtherAgent || run.assignedByOther ? "delegated" : "automation";
}

/** A stable hue (0–359) for a project id, so "Colour by project" never changes between renders. */
export function projectHue(id: string | null | undefined): number {
    if (!id) return 215;
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return hash % 360;
}

// ─── Clustering ─────────────────────────────────────────────────────────────

export interface TimelineCluster {
    count: number;
    start: number;
    end: number;
    /** How many runs of each outcome are folded into the cluster. */
    outcomeCounts: Partial<Record<RunOutcome, number>>;
    spanIds: string[];
}

export type TimelineRowItem =
    | { kind: "span"; span: TimelineSpan }
    | { kind: "cluster"; cluster: TimelineCluster };

/**
 * Collapse runs that are closer than `minGapPx` at the current zoom into a
 * single cluster pill (the "barcode" fix for 7/30-day views). Spans are
 * assumed to be on the same row; the result preserves start order, with each
 * cluster spanning its earliest start to its latest end.
 */
export function clusterSpans(spans: readonly TimelineSpan[], pxPerMs: number, minGapPx = 4): TimelineRowItem[] {
    const sorted = [...spans].sort((a, b) => a.start - b.start);
    const items: TimelineRowItem[] = [];
    const mergeCounts = (base: Partial<Record<RunOutcome, number>>, outcome: RunOutcome): Partial<Record<RunOutcome, number>> => {
        const next = { ...base };
        next[outcome] = (next[outcome] ?? 0) + 1;
        return next;
    };
    for (const span of sorted) {
        const last = items[items.length - 1];
        if (last && last.kind === "cluster") {
            if ((span.start - last.cluster.end) * pxPerMs < minGapPx) {
                const c = last.cluster;
                c.count += 1;
                c.end = Math.max(c.end, span.end);
                c.outcomeCounts = mergeCounts(c.outcomeCounts, span.outcome);
                c.spanIds.push(span.id);
                continue;
            }
        } else if (last && last.kind === "span") {
            if ((span.start - last.span.end) * pxPerMs < minGapPx) {
                const a = last.span;
                const outcomeCounts = mergeCounts(mergeCounts({}, a.outcome), span.outcome);
                items[items.length - 1] = {
                    kind: "cluster",
                    cluster: { count: 2, start: a.start, end: Math.max(a.end, span.end), outcomeCounts, spanIds: [a.id, span.id] },
                };
                continue;
            }
        }
        items.push({ kind: "span", span });
    }
    return items;
}

// ─── Auto-fit "Today" range ─────────────────────────────────────────────────

const MIN_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * The "Today" window, auto-fitted to the day's activity: from the first run
 * that started today (minus 30 minutes, never before midnight) to now (plus 15
 * minutes). A running run that began yesterday pins the left edge to midnight.
 * An empty day falls back to the last 8 hours.
 */
export function autoFitTodayRange(spans: readonly { startedAtMs: number; running: boolean }[], nowMs: number): { fromMs: number; toMs: number } {
    const startOfToday = new Date(new Date(nowMs).getFullYear(), new Date(nowMs).getMonth(), new Date(nowMs).getDate()).getTime();
    let first = Infinity;
    for (const s of spans) {
        if (s.startedAtMs >= startOfToday) first = Math.min(first, s.startedAtMs);
        else if (s.running) first = Math.min(first, startOfToday);
    }
    if (!Number.isFinite(first)) return { fromMs: nowMs - 8 * HOUR_MS, toMs: nowMs };
    return { fromMs: Math.max(startOfToday, first - 30 * MIN_MS), toMs: nowMs + 15 * MIN_MS };
}

// ─── Time axis ticks ────────────────────────────────────────────────────────

const DAY_MS = 24 * HOUR_MS;
/** Candidate tick steps, finest first. */
const TICK_STEPS = [
    5 * MIN_MS, 10 * MIN_MS, 15 * MIN_MS, 30 * MIN_MS,
    HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS, 6 * HOUR_MS, 12 * HOUR_MS,
    DAY_MS, 2 * DAY_MS, 3 * DAY_MS, 7 * DAY_MS,
];
/** Room each labelled tick needs; ~6–10 labels across a typical chart. */
const TICK_LABEL_PX = 100;
/** The closest faint minor ticks may sit. */
const MINOR_TICK_PX = 10;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface TimeTicks {
    /** Labelled ticks. */
    major: { ms: number; label: string }[];
    /** Faint unlabelled ticks between the labelled ones (never on a major tick). */
    minor: number[];
}

export interface TimeTickOptions {
    /**
     * The viewer's UTC offset in minutes at an instant (east positive). Defaults
     * to the browser's local zone; tests pass a fixed offset. Evaluated per tick,
     * so ticks stay on local hours and midnights across a DST change.
     */
    offsetMinutes?: (ms: number) => number;
}

const localOffset = (ms: number) => -new Date(ms).getTimezoneOffset();
const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Ticks for the time axis of [fromMs, toMs] drawn `widthPx` wide. Picks the
 * finest step (5/10/15/30 min, 1/2/3/6/12 h, 1/2/3 days, 1 week) that keeps
 * labelled ticks at least ~100 px apart — so ~6–10 labels on a typical chart,
 * more when zoomed in. Steps of a day or more sit on local midnights (a week
 * on Mondays) and read as days: "Mon 19" for ranges up to 10 days, "Oct 19"
 * beyond; sub-day ticks read "14:00", except a tick on local midnight, which
 * names the day. Minor ticks are the finest step that divides the major step
 * and stays ≥ 10 px apart (hours under a day step).
 */
export function timeTicks(fromMs: number, toMs: number, widthPx: number, options: TimeTickOptions = {}): TimeTicks {
    const empty: TimeTicks = { major: [], minor: [] };
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs || !(widthPx > 0)) return empty;
    const offsetMinutes = options.offsetMinutes ?? localOffset;
    const spanMs = toMs - fromMs;
    const pxPerMs = widthPx / spanMs;
    const maxLabels = Math.max(2, Math.floor(widthPx / TICK_LABEL_PX));
    const major = TICK_STEPS.find((step) => spanMs / step <= maxLabels) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const minor = TICK_STEPS.find((step) => step < major && major % step === 0 && step * pxPerMs >= MINOR_TICK_PX) ?? null;
    const longRange = spanMs > 10 * DAY_MS;

    // Work in "local ms" (UTC ms shifted by the offset), so UTC getters read local fields.
    const toLocal = (ms: number) => ms + offsetMinutes(ms) * MIN_MS;
    const toUtc = (local: number) => {
        const guess = local - offsetMinutes(local) * MIN_MS;
        return local - offsetMinutes(guess) * MIN_MS;
    };
    const dayLabel = (local: number) => {
        const d = new Date(local);
        return longRange ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()}`;
    };
    const label = (local: number) => {
        const d = new Date(local);
        if (major >= DAY_MS || (d.getUTCHours() === 0 && d.getUTCMinutes() === 0)) return dayLabel(local);
        return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
    };
    // The first aligned local instant at or after `localFrom` for a step.
    const firstAligned = (localFrom: number, step: number) => {
        if (step === 7 * DAY_MS) {
            // Epoch day 0 (1970-01-01) was a Thursday; Monday is day 4.
            const day = Math.ceil(localFrom / DAY_MS);
            return (day + ((4 - day) % 7 + 7) % 7) * DAY_MS;
        }
        return Math.ceil(localFrom / step) * step;
    };
    const walk = (step: number, limit: number): number[] => {
        const out: number[] = [];
        const localFrom = toLocal(fromMs);
        const localTo = toLocal(toMs);
        for (let local = firstAligned(localFrom, step); local <= localTo && out.length < limit; local += step) {
            const ms = toUtc(local);
            // A DST jump can fold two local instants together; keep ticks strictly increasing.
            if (ms >= fromMs && ms <= toMs && (out.length === 0 || ms > out[out.length - 1])) out.push(local);
        }
        return out;
    };

    const majorLocal = walk(major, 500);
    const majorSet = new Set(majorLocal);
    return {
        major: majorLocal.map((local) => ({ ms: toUtc(local), label: label(local) })),
        minor: minor == null ? [] : walk(minor, 5000).filter((local) => !majorSet.has(local)).map(toUtc),
    };
}

// ─── Event kind mapping ─────────────────────────────────────────────────────

/**
 * A task_events row's type → marker kind. `task_updated` and `task_<state>`
 * are status changes; `task_note`/`task_handoff` are notes; `task_generated`
 * is a creation; assignments and reassignments (and a claim, which is a
 * self-assignment) are assignments. Approval and file markers do not come from
 * task_events (they come from approvals/artifacts in the reads module) and are
 * not produced here.
 */
export function eventKindFor(eventType: string): TimelineEventKind | null {
    if (eventType === "task_generated") return "created";
    if (eventType === "task_assigned" || eventType === "task_claimed" || eventType === "task_reassigned") return "assigned";
    if (eventType === "task_note" || eventType === "task_handoff") return "note";
    if (eventType === "task_updated" || eventType.startsWith("task_")) return "status";
    return null;
}

/** Past-tense verb for an approval decision; unknown values read "Decided". */
const DECISION_VERB: Record<string, string> = { approved: "Approved", rejected: "Rejected", dismissed: "Dismissed" };
const PERSON_VERB: Record<TimelineEventKind, string> = {
    created: "Created",
    assigned: "Assigned",
    status: "Status changed",
    note: "Note",
    approval_requested: "Approval requested",
    approval_decided: "Decided",
    file: "File added",
};

/**
 * A marker's tooltip text. A person's action reads "<Verb> by <name>"
 * ("Assigned by Priya", "Approved by Priya", "Note by Priya"); an agent's own
 * marker is the plain kind label ("Note").
 */
export function eventLabel(kind: TimelineEventKind, byName: string | null | undefined, decision?: string | null): string {
    const name = byName?.trim();
    if (!name) return EVENT_KIND_LABEL[kind];
    const verb = kind === "approval_decided" ? (DECISION_VERB[decision ?? ""] ?? "Decided") : PERSON_VERB[kind];
    return `${verb} by ${name}`;
}

// ─── Edge derivation ────────────────────────────────────────────────────────

/**
 * Handoffs between two actors, derived from task_events and run triggers.
 *
 * Rules (the only edges this system produces):
 *
 *  1. Assignment by another actor — a `task_generated`, `task_assigned` or
 *     `task_reassigned` event whose ACTING actor differs from the assignee it
 *     names. `task_claimed` is excluded: a claim is an agent taking a task for
 *     itself, not a handoff. `task_handoff` is excluded too: its payload only
 *     carries role names (`fromRole`/`toRole`), not actor ids, so it cannot be
 *     attributed to a specific row safely.
 *  2. A run triggered by another agent — a run with `triggerKind === "message"`
 *     whose triggering message was sent by a DIFFERENT agent (the reads module
 *     resolves `triggerActorId` from the trigger message's sender). This is the
 *     "agent A asked agent B to act" handoff path.
 *
 * Edges only connect agents that are actually present in the timeline (the
 * builder drops any edge whose `from` or `to` is not a visible agent row), so
 * a scoped view can never leak an out-of-scope agent through an edge, and a
 * person's assignment is never an edge: it is an "Assigned by …" marker on
 * the receiving agent's row instead.
 */

export interface EdgeEventInput {
    id: string;
    eventType: string;
    /** Canonical id of the acting party, or null (system). */
    actorId: string | null;
    /** Canonical id of the assignee named in the payload, or null. */
    assigneeId: string | null;
    taskId: string;
    atMs: number;
}

export interface EdgeRunInput {
    runId: string;
    /** Canonical agent id. */
    agentId: string;
    taskId: string | null;
    triggerKind: string;
    /** Canonical id of the actor whose message triggered the run, or null. */
    triggerActorId: string | null;
    startedAtMs: number;
}

export function deriveEdges(events: readonly EdgeEventInput[], runs: readonly EdgeRunInput[]): TimelineEdge[] {
    const edges: TimelineEdge[] = [];
    const add = (id: string, from: string | null, to: string | null, taskId: string, kind: TimelineEdgeKind, atMs: number) => {
        if (!from || !to || from === to) return;
        edges.push({ id, from, to, taskId, kind, at: atMs });
    };

    for (const event of events) {
        if (!event.assigneeId) continue;
        let kind: TimelineEdgeKind | null = null;
        if (event.eventType === "task_generated") kind = "created";
        else if (event.eventType === "task_assigned") kind = "assigned";
        else if (event.eventType === "task_reassigned") kind = "reassigned";
        if (kind) add(`event:${event.id}`, event.actorId, event.assigneeId, event.taskId, kind, event.atMs);
    }

    for (const run of runs) {
        if (run.triggerKind !== "message" || !run.triggerActorId) continue;
        add(`run:${run.runId}`, run.triggerActorId, run.agentId, run.taskId ?? "", "triggered_run", run.startedAtMs);
    }

    return edges;
}

// ─── Builder inputs ─────────────────────────────────────────────────────────

export interface BuildAgentSource {
    id: string;
    name: string;
    avatarUrl: string | null;
    /** Character hue (0–359) for the bar colour. */
    hue: number | null;
}

export interface BuildRunSource {
    runId: string;
    /** Canonical agent id. */
    agentId: string;
    taskId: string | null;
    taskTitle: string | null;
    projectName: string | null;
    projectId: string | null;
    threadLabel: string | null;
    href: string | null;
    status: string;
    exitReason: string | null;
    pendingApproval: boolean;
    triggerKind: string;
    /** True when a different agent's message triggered this run (the handoff path). */
    triggeredByOtherAgent: boolean;
    /** True when another actor assigned this run's task. */
    assignedByOther: boolean;
    startedAtMs: number;
    endedAtMs: number | null;
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costCents: number | null;
    toolCalls: number | null;
    model: string | null;
}

export interface BuildEventSource {
    id: string;
    /** The agent row to draw on. */
    actorId: string;
    taskId: string;
    kind: TimelineEventKind;
    atMs: number;
    /** Display name of the person who acted, when a person did (never an email). */
    byName?: string | null;
    /** An approval's final status, for "Approved by …" / "Rejected by …". */
    decision?: string | null;
}

export interface BuildTimelineInput {
    fromMs: number;
    toMs: number;
    nowMs: number;
    /** The (already scoped) agents: the ONLY rows the timeline has. */
    agents: BuildAgentSource[];
    runs: BuildRunSource[];
    events: BuildEventSource[];
    edgeEvents: EdgeEventInput[];
    edgeRuns: EdgeRunInput[];
    /** True when the viewer is member-scoped (affects only the `scoped` flag). */
    scoped: boolean;
    /** True when the reads module hit a raw row limit before filtering; reported as `capped`. */
    rawCapped?: boolean;
}

// ─── Builder ────────────────────────────────────────────────────────────────

export function buildWorkTimeline(input: BuildTimelineInput): WorkTimeline {
    const { fromMs, toMs, nowMs } = input;

    // Visible actors are EXACTLY the (already scoped) agent rows. Runs,
    // events and edges never widen the set: anything naming an actor outside
    // it (a person, an out-of-scope or deleted agent) is dropped, so no person
    // ever gets a row or a handoff end, and the totals only count bars that
    // have a row.
    const actorIds = new Set<string>(input.agents.map((a) => `agent:${a.id}`));

    // Build spans (clipped) and accumulate per-actor stats.
    const spans: TimelineSpan[] = [];
    const stats = new Map<string, { runCount: number; busyMs: number; tokens: number; costCents: number }>();
    const bump = (id: string, busyMs: number, tokens: number, costCents: number) => {
        const s = stats.get(id) ?? { runCount: 0, busyMs: 0, tokens: 0, costCents: 0 };
        s.runCount += 1;
        s.busyMs += busyMs;
        s.tokens += tokens;
        s.costCents += costCents;
        stats.set(id, s);
    };

    // Over the cap, the newest runs are kept.
    const sortedRuns = input.runs.filter((run) => actorIds.has(run.agentId)).sort((a, b) => a.startedAtMs - b.startedAtMs);
    for (const run of sortedRuns.slice(-TIMELINE_SPAN_CAP)) {
        const clipped = clipSpan(run.startedAtMs, run.endedAtMs, fromMs, toMs, nowMs);
        if (!clipped.visible) continue;
        const tokens = Math.max(0, run.inputTokens ?? 0) + Math.max(0, run.outputTokens ?? 0);
        const cost = Math.max(0, run.costCents ?? 0);
        spans.push({
            id: run.runId,
            actorId: run.agentId,
            taskId: run.taskId,
            taskTitle: run.taskTitle,
            projectName: run.projectName,
            kind: run.taskId ? "task" : "chat",
            threadLabel: run.threadLabel,
            href: run.href,
            start: clipped.start,
            end: clipped.end,
            running: clipped.running,
            outcome: runOutcome({ status: run.status, exitReason: run.exitReason }, { pendingApproval: run.pendingApproval }),
            source: deriveRunSource(run),
            projectId: run.projectId,
            status: run.status,
            triggerKind: run.triggerKind,
            startedAtMs: run.startedAtMs,
            endedAtMs: run.endedAtMs,
            durationMs: run.durationMs,
            tokens,
            costCents: cost,
            toolCalls: run.toolCalls,
            model: run.model,
        });
        bump(run.agentId, clipped.end - clipped.start, tokens, cost);
    }

    // Events: markers of visible actors, clipped to the window, capped (newest kept).
    const windowEvents = input.events
        .filter((event) => actorIds.has(event.actorId) && event.atMs >= fromMs && event.atMs <= toMs)
        .sort((a, b) => a.atMs - b.atMs);
    const events: TimelineEvent[] = windowEvents
        .slice(-TIMELINE_EVENT_CAP)
        .map((event) => {
            const byName = event.byName?.trim() || null;
            return { id: event.id, actorId: event.actorId, taskId: event.taskId, kind: event.kind, at: event.atMs, byName, label: eventLabel(event.kind, byName, event.decision) };
        });

    // Edges: only between visible agents, capped (newest kept).
    const allEdges = deriveEdges(input.edgeEvents, input.edgeRuns)
        .filter((edge) => edge.at >= fromMs && edge.at <= toMs)
        .filter((edge) => actorIds.has(edge.from) && actorIds.has(edge.to))
        .sort((a, b) => a.at - b.at);
    const edges = allEdges.slice(-TIMELINE_EDGE_CAP);

    // Actors: agents only, by activity, then runs, then name.
    const agentsOrdered = input.agents
        .map((a) => ({ id: `agent:${a.id}`, a }))
        .sort((x, y) => {
            const sx = stats.get(x.id);
            const sy = stats.get(y.id);
            const byActivity = (sy?.busyMs ?? 0) - (sx?.busyMs ?? 0);
            if (byActivity !== 0) return byActivity;
            const byRuns = (sy?.runCount ?? 0) - (sx?.runCount ?? 0);
            if (byRuns !== 0) return byRuns;
            return x.a.name.localeCompare(y.a.name);
        });
    const actors: TimelineActor[] = agentsOrdered.map(({ id, a }) => ({
        id,
        kind: "agent" as const,
        name: a.name,
        initials: initialsOf(a.name),
        avatarUrl: a.avatarUrl,
        colour: actorColour("agent", a.hue),
        runCount: stats.get(id)?.runCount ?? 0,
        busyMs: stats.get(id)?.busyMs ?? 0,
        tokens: stats.get(id)?.tokens ?? 0,
        costCents: stats.get(id)?.costCents ?? 0,
    }));

    const finished = spans.filter((s) => !s.running);
    const done = finished.filter((s) => s.outcome === "done").length;
    const totals: TimelineTotals = {
        runs: spans.length,
        busyMs: spans.reduce((sum, s) => sum + (s.end - s.start), 0),
        tokens: spans.reduce((sum, s) => sum + s.tokens, 0),
        costCents: spans.reduce((sum, s) => sum + s.costCents, 0),
        successRate: finished.length > 0 ? done / finished.length : null,
    };

    const capped =
        Boolean(input.rawCapped) ||
        sortedRuns.length > TIMELINE_SPAN_CAP ||
        windowEvents.length > TIMELINE_EVENT_CAP ||
        allEdges.length > TIMELINE_EDGE_CAP;

    return { actors, spans, events, edges, totals, from: fromMs, to: toMs, now: nowMs, capped, scoped: input.scoped };
}
