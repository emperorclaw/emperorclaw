// The company "Timeline" page (docs/roadmap/product-decisions.md): a
// Gantt-style chart of who (agents and people) worked on what, when, and who
// handed work to whom. This module is the PURE builder — every input is a
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

export type TimelineActorKind = "agent" | "human";

export interface TimelineActor {
    /** Canonical id: "agent:<id>" or "human:<userId>". Shared by spans/events/edges. */
    id: string;
    kind: TimelineActorKind;
    name: string;
    /** Two-letter fallback when there is no avatar. */
    initials: string;
    /** Agent avatar endpoint (agents only); null for people. */
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
    actorId: string;
    taskId: string;
    kind: TimelineEventKind;
    /** Epoch ms. */
    at: number;
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
export function actorColour(kind: TimelineActorKind, hue: number | null | undefined): string {
    if (kind === "agent") return `hsl(${((hue ?? 205) % 360 + 360) % 360} 72% 60%)`;
    return "hsl(215 16% 64%)";
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
 * Edges only connect actors that are actually present in the timeline (the
 * builder drops any edge whose `from` or `to` is not a visible actor), so a
 * scoped view can never leak an out-of-scope agent through an edge.
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
    threadLabel: string | null;
    href: string | null;
    status: string;
    exitReason: string | null;
    pendingApproval: boolean;
    triggerKind: string;
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
    actorId: string;
    taskId: string;
    kind: TimelineEventKind;
    atMs: number;
}

export interface BuildTimelineInput {
    fromMs: number;
    toMs: number;
    nowMs: number;
    agents: BuildAgentSource[];
    /** People who acted or were assigned work; only referenced ones become rows. */
    humans: { id: string; name: string }[];
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

    // Rows: agents first (activity, then name), then humans who acted.
    const humanById = new Map(input.humans.map((h) => [`human:${h.id}`, h]));

    // Visible actors are EXACTLY the (already scoped) agent rows plus the
    // people the caller supplied. Runs, events and edges never widen the set:
    // anything naming an actor outside it is dropped, so an out-of-scope or
    // deleted agent never appears through a span, a marker or a handoff, and
    // the totals only count bars that have a row.
    const actorIds = new Set<string>(input.agents.map((a) => `agent:${a.id}`));
    for (const human of input.humans) actorIds.add(`human:${human.id}`);

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
        .map((event) => ({ id: event.id, actorId: event.actorId, taskId: event.taskId, kind: event.kind, at: event.atMs }));

    // Edges: only between visible actors, capped (newest kept).
    const allEdges = deriveEdges(input.edgeEvents, input.edgeRuns)
        .filter((edge) => edge.at >= fromMs && edge.at <= toMs)
        .filter((edge) => actorIds.has(edge.from) && actorIds.has(edge.to))
        .sort((a, b) => a.at - b.at);
    const edges = allEdges.slice(-TIMELINE_EDGE_CAP);

    // Actors: agents first (activity, then name), then humans who acted.
    const humansPresent = [...new Set(input.humans.map((h) => `human:${h.id}`))].filter((id) => {
        return spans.some((s) => s.actorId === id) || events.some((e) => e.actorId === id) || edges.some((e) => e.from === id || e.to === id);
    });
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
    const humansOrdered = humansPresent
        .sort((a, b) => {
            const sa = stats.get(a);
            const sb = stats.get(b);
            const byBusy = (sb?.busyMs ?? 0) - (sa?.busyMs ?? 0);
            if (byBusy !== 0) return byBusy;
            return (humanById.get(a)?.name ?? a).localeCompare(humanById.get(b)?.name ?? b);
        });

    const actors: TimelineActor[] = [
        ...agentsOrdered.map(({ id, a }) => ({
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
        })),
        ...humansOrdered.map((id) => ({
            id,
            kind: "human" as const,
            name: humanById.get(id)?.name ?? "Someone",
            initials: initialsOf(humanById.get(id)?.name),
            avatarUrl: null,
            colour: actorColour("human", null),
            runCount: stats.get(id)?.runCount ?? 0,
            busyMs: stats.get(id)?.busyMs ?? 0,
            tokens: stats.get(id)?.tokens ?? 0,
            costCents: stats.get(id)?.costCents ?? 0,
        })),
    ];

    const totals: TimelineTotals = {
        runs: spans.length,
        busyMs: spans.reduce((sum, s) => sum + (s.end - s.start), 0),
        tokens: spans.reduce((sum, s) => sum + s.tokens, 0),
        costCents: spans.reduce((sum, s) => sum + s.costCents, 0),
    };

    const capped =
        Boolean(input.rawCapped) ||
        sortedRuns.length > TIMELINE_SPAN_CAP ||
        windowEvents.length > TIMELINE_EVENT_CAP ||
        allEdges.length > TIMELINE_EDGE_CAP;

    return { actors, spans, events, edges, totals, from: fromMs, to: toMs, now: nowMs, capped, scoped: input.scoped };
}
