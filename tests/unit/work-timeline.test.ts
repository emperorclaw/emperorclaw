import { test } from "node:test";
import assert from "node:assert/strict";
import {
    actorColour,
    autoFitTodayRange,
    buildWorkTimeline,
    clipSpan,
    clusterSpans,
    deriveEdges,
    deriveRunSource,
    eventKindFor,
    eventLabel,
    initialsOf,
    projectHue,
    timeTicks,
    TIMELINE_SPAN_CAP,
    type BuildRunSource,
    type BuildTimelineInput,
    type EdgeEventInput,
    type EdgeRunInput,
    type TimelineSpan,
} from "../../src/lib/work-timeline";

// ─── Span clipping ──────────────────────────────────────────────────────────

test("clipSpan keeps a span fully inside the window", () => {
    const c = clipSpan(1000, 2000, 0, 5000, 9000);
    assert.equal(c.visible, true);
    assert.equal(c.running, false);
    assert.equal(c.start, 1000);
    assert.equal(c.end, 2000);
});

test("clipSpan clips the left and right edges to the window", () => {
    const c = clipSpan(-500, 6000, 0, 5000, 9000);
    assert.equal(c.start, 0);
    assert.equal(c.end, 5000);
    assert.equal(c.visible, true);
});

test("clipSpan draws a running span to now", () => {
    const c = clipSpan(1000, null, 0, 5000, 3000);
    assert.equal(c.running, true);
    assert.equal(c.end, 3000);
});

test("clipSpan caps a running span at the window end when now is past it", () => {
    const c = clipSpan(1000, null, 0, 5000, 9000);
    assert.equal(c.end, 5000);
    assert.equal(c.running, true);
});

test("clipSpan hides a span entirely before the window", () => {
    assert.equal(clipSpan(0, 100, 500, 5000, 9000).visible, false);
});

test("clipSpan hides a span entirely after the window", () => {
    assert.equal(clipSpan(6000, 7000, 0, 5000, 9000).visible, false);
});

// ─── Actor helpers ──────────────────────────────────────────────────────────

test("initialsOf takes the first letters of the first and last word", () => {
    assert.equal(initialsOf("Atlas"), "AT");
    assert.equal(initialsOf("Nova Kai"), "NK");
    assert.equal(initialsOf(""), "?");
    assert.equal(initialsOf(null), "?");
});

test("actorColour is hue-based for agents and neutral for people", () => {
    assert.equal(actorColour("agent", 190), "hsl(190 72% 60%)");
    assert.equal(actorColour("agent", 370), "hsl(10 72% 60%)");
    assert.equal(actorColour("human", null), "hsl(215 16% 64%)");
});

// ─── Event kind mapping ─────────────────────────────────────────────────────

test("eventKindFor maps task_events types to marker kinds", () => {
    assert.equal(eventKindFor("task_generated"), "created");
    assert.equal(eventKindFor("task_assigned"), "assigned");
    assert.equal(eventKindFor("task_claimed"), "assigned");
    assert.equal(eventKindFor("task_reassigned"), "assigned");
    assert.equal(eventKindFor("task_note"), "note");
    assert.equal(eventKindFor("task_handoff"), "note");
    assert.equal(eventKindFor("task_updated"), "status");
    assert.equal(eventKindFor("task_done"), "status");
    assert.equal(eventKindFor("lease_expired_retry"), null);
    assert.equal(eventKindFor("stall_nudge"), null);
});

// ─── Edge derivation ────────────────────────────────────────────────────────

test("deriveEdges creates an edge when another actor assigns a task", () => {
    const events: EdgeEventInput[] = [
        { id: "e1", eventType: "task_generated", actorId: "agent:alpha", assigneeId: "agent:beta", taskId: "t1", atMs: 10 },
        { id: "e2", eventType: "task_assigned", actorId: "human:u1", assigneeId: "agent:gamma", taskId: "t2", atMs: 20 },
        { id: "e3", eventType: "task_reassigned", actorId: "agent:beta", assigneeId: "agent:delta", taskId: "t3", atMs: 30 },
    ];
    const edges = deriveEdges(events, []);
    assert.deepEqual(edges.map((e) => e.kind), ["created", "assigned", "reassigned"]);
    assert.equal(edges[0].from, "agent:alpha");
    assert.equal(edges[0].to, "agent:beta");
    assert.equal(edges[2].from, "agent:beta");
    assert.equal(edges[2].to, "agent:delta");
});

test("deriveEdges ignores self-assignment and claim (no distinct assignee)", () => {
    const events: EdgeEventInput[] = [
        { id: "e1", eventType: "task_assigned", actorId: "agent:alpha", assigneeId: "agent:alpha", taskId: "t1", atMs: 10 },
        { id: "e2", eventType: "task_claimed", actorId: "agent:alpha", assigneeId: null, taskId: "t2", atMs: 20 },
    ];
    assert.equal(deriveEdges(events, []).length, 0);
});

test("deriveEdges creates an edge for a run triggered by another agent's message", () => {
    const runs: EdgeRunInput[] = [
        { runId: "r1", agentId: "agent:beta", taskId: "t1", triggerKind: "message", triggerActorId: "agent:alpha", startedAtMs: 100 },
        { runId: "r2", agentId: "agent:beta", taskId: "t2", triggerKind: "message", triggerActorId: "agent:beta", startedAtMs: 200 },
        { runId: "r3", agentId: "agent:beta", taskId: "t3", triggerKind: "task", triggerActorId: null, startedAtMs: 300 },
    ];
    const edges = deriveEdges([], runs);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].kind, "triggered_run");
    assert.equal(edges[0].from, "agent:alpha");
    assert.equal(edges[0].to, "agent:beta");
});

// ─── Builder ────────────────────────────────────────────────────────────────

function run(overrides: Partial<BuildRunSource> & { runId: string; agentId: string }): BuildRunSource {
    return {
        taskId: "t1",
        taskTitle: "Do the thing",
        projectName: "Acme",
        projectId: "p1",
        threadLabel: null,
        href: "/projects/tasks/t1",
        status: "succeeded",
        exitReason: null,
        pendingApproval: false,
        triggerKind: "task",
        triggeredByOtherAgent: false,
        assignedByOther: false,
        startedAtMs: 1000,
        endedAtMs: 2000,
        durationMs: 1000,
        inputTokens: 100,
        outputTokens: 50,
        costCents: 10,
        toolCalls: 3,
        model: "deepseek-v4",
        ...overrides,
    };
}

function baseInput(overrides: Partial<BuildTimelineInput> = {}): BuildTimelineInput {
    return {
        fromMs: 0,
        toMs: 5000,
        nowMs: 4000,
        agents: [
            { id: "a1", name: "Alpha", avatarUrl: null, hue: 190 },
            { id: "a2", name: "Beta", avatarUrl: null, hue: 20 },
        ],
        runs: [],
        events: [],
        edgeEvents: [],
        edgeRuns: [],
        scoped: false,
        ...overrides,
    };
}

test("buildWorkTimeline clips spans, keeps raw times and computes totals", () => {
    const tl = buildWorkTimeline(baseInput({
        runs: [run({ runId: "r1", agentId: "agent:a1", startedAtMs: -100, endedAtMs: 2000, durationMs: 2100, inputTokens: 100, outputTokens: 50, costCents: 10 })],
    }));
    assert.equal(tl.totals.runs, 1);
    assert.equal(tl.totals.tokens, 150);
    assert.equal(tl.totals.costCents, 10);
    assert.equal(tl.spans.length, 1);
    assert.equal(tl.spans[0].start, 0);       // clipped left
    assert.equal(tl.spans[0].end, 2000);
    assert.equal(tl.spans[0].startedAtMs, -100); // raw kept
    assert.equal(tl.spans[0].endedAtMs, 2000);
});

test("buildWorkTimeline maps outcomes through runOutcome", () => {
    const tl = buildWorkTimeline(baseInput({
        runs: [
            run({ runId: "r1", agentId: "agent:a1", status: "succeeded" }),
            run({ runId: "r2", agentId: "agent:a1", status: "succeeded", pendingApproval: true, startedAtMs: 1100, endedAtMs: 1200 }),
            run({ runId: "r3", agentId: "agent:a1", status: "cancelled", startedAtMs: 1200, endedAtMs: 1300 }),
            run({ runId: "r4", agentId: "agent:a1", status: "failed", startedAtMs: 1300, endedAtMs: 1400 }),
            run({ runId: "r5", agentId: "agent:a1", status: "running", endedAtMs: null, startedAtMs: 1400 }),
        ],
    }));
    const byId = new Map(tl.spans.map((s) => [s.id, s]));
    assert.equal(byId.get("r1")?.outcome, "done");
    assert.equal(byId.get("r2")?.outcome, "needs_you");
    assert.equal(byId.get("r3")?.outcome, "stopped");
    assert.equal(byId.get("r4")?.outcome, "failed");
    assert.equal(byId.get("r5")?.outcome, "running");
    assert.equal(byId.get("r5")?.running, true);
});

test("buildWorkTimeline has agent rows only, ordered by activity", () => {
    const tl = buildWorkTimeline(baseInput({
        runs: [
            run({ runId: "r1", agentId: "agent:a1", startedAtMs: 0, endedAtMs: 100 }),           // little activity
            run({ runId: "r2", agentId: "agent:a2", startedAtMs: 0, endedAtMs: 3000 }),          // lots
            run({ runId: "r3", agentId: "human:u1", startedAtMs: 0, endedAtMs: 1000, taskId: null, href: null }),
        ],
        events: [{ id: "e1", actorId: "human:u1", taskId: "t1", kind: "note", atMs: 100 }],
        edgeEvents: [{ id: "x1", eventType: "task_assigned", actorId: "human:u1", assigneeId: "agent:a1", taskId: "t1", atMs: 10 }],
    }));
    assert.deepEqual(tl.actors.map((a) => a.id), ["agent:a2", "agent:a1"]);
    assert.ok(tl.actors.every((a) => a.kind === "agent"));
    assert.ok(!JSON.stringify(tl).includes("human:"), "no person is a row, a bar, a marker or a handoff end");
    assert.equal(tl.totals.runs, 2);
    assert.equal(tl.edges.length, 0);
});

test("buildWorkTimeline shows a person's action as a labelled marker on the receiving agent's row", () => {
    const tl = buildWorkTimeline(baseInput({
        events: [
            { id: "e1", actorId: "agent:a1", taskId: "t1", kind: "assigned", atMs: 100, byName: "Priya" },
            { id: "e2", actorId: "agent:a2", taskId: "t1", kind: "approval_decided", atMs: 200, byName: "Priya", decision: "approved" },
            { id: "e3", actorId: "agent:a2", taskId: "t1", kind: "note", atMs: 300 },
        ],
    }));
    const byId = new Map(tl.events.map((e) => [e.id, e]));
    assert.equal(byId.get("e1")?.actorId, "agent:a1");
    assert.equal(byId.get("e1")?.label, "Assigned by Priya");
    assert.equal(byId.get("e2")?.label, "Approved by Priya");
    assert.equal(byId.get("e3")?.byName, null);
    assert.equal(byId.get("e3")?.label, "Note");
});

test("eventLabel names the person for their actions and stays plain for an agent's own", () => {
    assert.equal(eventLabel("assigned", "Priya"), "Assigned by Priya");
    assert.equal(eventLabel("created", "Priya"), "Created by Priya");
    assert.equal(eventLabel("note", "Priya"), "Note by Priya");
    assert.equal(eventLabel("approval_decided", "Priya", "rejected"), "Rejected by Priya");
    assert.equal(eventLabel("approval_decided", "Priya", "weird"), "Decided by Priya");
    assert.equal(eventLabel("note", null), "Note");
    assert.equal(eventLabel("assigned", "  "), "Assigned");
});

test("buildWorkTimeline reports capped when spans exceed the cap", () => {
    const runs = Array.from({ length: TIMELINE_SPAN_CAP + 10 }, (_, i) => run({ runId: `r${i}`, agentId: "agent:a1", startedAtMs: i, endedAtMs: i + 1 }));
    const tl = buildWorkTimeline(baseInput({ runs }));
    assert.equal(tl.capped, true);
    assert.equal(tl.spans.length, TIMELINE_SPAN_CAP);
});

test("buildWorkTimeline drops edges referencing an actor outside the visible set", () => {
    const edgeEvents: EdgeEventInput[] = [
        { id: "e1", eventType: "task_assigned", actorId: "agent:ghost", assigneeId: "agent:a1", taskId: "t1", atMs: 10 },
    ];
    const tl = buildWorkTimeline(baseInput({ edgeEvents }));
    assert.equal(tl.edges.length, 0);
});

test("buildWorkTimeline derives visible actors from the agent list, never from runs or events", () => {
    const tl = buildWorkTimeline(baseInput({
        runs: [
            run({ runId: "r1", agentId: "agent:a1" }),
            run({ runId: "r2", agentId: "agent:ghost", costCents: 99 }),
        ],
        events: [
            { id: "e1", actorId: "agent:a1", taskId: "t1", kind: "note", atMs: 100 },
            { id: "e2", actorId: "agent:ghost", taskId: "t1", kind: "note", atMs: 200 },
            { id: "e3", actorId: "human:stranger", taskId: "t1", kind: "note", atMs: 300 },
        ],
        edgeEvents: [{ id: "x1", eventType: "task_assigned", actorId: "agent:a1", assigneeId: "agent:ghost", taskId: "t1", atMs: 10 }],
    }));
    const json = JSON.stringify(tl);
    assert.ok(!json.includes("ghost") && !json.includes("stranger"));
    assert.deepEqual(tl.spans.map((s) => s.id), ["r1"]);
    assert.deepEqual(tl.events.map((e) => e.id), ["e1"]);
    assert.equal(tl.totals.runs, 1, "totals only count bars that have a row");
    assert.equal(tl.totals.costCents, 10);
});

test("buildWorkTimeline keeps the newest work over the cap and honours rawCapped", () => {
    const runs = Array.from({ length: TIMELINE_SPAN_CAP + 5 }, (_, i) => run({ runId: `r${i}`, agentId: "agent:a1", startedAtMs: i, endedAtMs: i + 1 }));
    const tl = buildWorkTimeline(baseInput({ runs }));
    assert.ok(tl.spans.some((s) => s.id === `r${TIMELINE_SPAN_CAP + 4}`), "the newest run is kept");
    assert.ok(!tl.spans.some((s) => s.id === "r0"), "the oldest run is cut");
    assert.equal(buildWorkTimeline(baseInput()).capped, false);
    assert.equal(buildWorkTimeline(baseInput({ rawCapped: true })).capped, true);
});

// ─── Colour-by "Source" ─────────────────────────────────────────────────────

test("deriveRunSource classifies delegation vs automation", () => {
    assert.equal(deriveRunSource({ triggeredByOtherAgent: true, assignedByOther: false }), "delegated");
    assert.equal(deriveRunSource({ triggeredByOtherAgent: false, assignedByOther: true }), "delegated");
    assert.equal(deriveRunSource({ triggeredByOtherAgent: false, assignedByOther: false }), "automation");
});

test("buildWorkTimeline sets a span's source from delegation signals", () => {
    const tl = buildWorkTimeline(baseInput({
        runs: [
            run({ runId: "r1", agentId: "agent:a1", triggeredByOtherAgent: true }),
            run({ runId: "r2", agentId: "agent:a1", startedAtMs: 1100, endedAtMs: 1200, assignedByOther: true }),
            run({ runId: "r3", agentId: "agent:a1", startedAtMs: 1200, endedAtMs: 1300 }),
        ],
    }));
    const byId = new Map(tl.spans.map((s) => [s.id, s]));
    assert.equal(byId.get("r1")?.source, "delegated");
    assert.equal(byId.get("r2")?.source, "delegated");
    assert.equal(byId.get("r3")?.source, "automation");
});

test("projectHue is stable, in range and neutral for missing projects", () => {
    assert.equal(projectHue("abc"), projectHue("abc"));
    const h = projectHue("abc");
    assert.ok(h >= 0 && h < 360);
    assert.equal(projectHue(null), 215);
});

// ─── Success rate ───────────────────────────────────────────────────────────

test("buildWorkTimeline computes success rate as done over finished runs", () => {
    const tl = buildWorkTimeline(baseInput({
        runs: [
            run({ runId: "r1", agentId: "agent:a1", status: "succeeded" }),
            run({ runId: "r2", agentId: "agent:a1", status: "failed", startedAtMs: 1100, endedAtMs: 1200 }),
            run({ runId: "r3", agentId: "agent:a1", status: "cancelled", startedAtMs: 1200, endedAtMs: 1300 }),
            run({ runId: "r4", agentId: "agent:a1", status: "running", endedAtMs: null, startedAtMs: 1300 }),
        ],
    }));
    assert.equal(tl.totals.successRate, 1 / 3);
});

test("buildWorkTimeline reports a null success rate when nothing has finished", () => {
    const tl = buildWorkTimeline(baseInput({ runs: [run({ runId: "r1", agentId: "agent:a1", status: "running", endedAtMs: null })] }));
    assert.equal(tl.totals.successRate, null);
});

// ─── Clustering ─────────────────────────────────────────────────────────────

function span(overrides: Partial<TimelineSpan> & { id: string; start: number; end: number }): TimelineSpan {
    return {
        actorId: "agent:a1",
        taskId: "t1",
        taskTitle: null,
        projectName: null,
        projectId: null,
        kind: "task",
        threadLabel: null,
        href: null,
        running: false,
        outcome: "done",
        source: "automation",
        status: "succeeded",
        triggerKind: "task",
        startedAtMs: overrides.start,
        endedAtMs: overrides.end,
        durationMs: overrides.end - overrides.start,
        tokens: 0,
        costCents: 0,
        toolCalls: null,
        model: null,
        ...overrides,
    };
}

test("clusterSpans leaves far-apart spans as individual spans", () => {
    const items = clusterSpans([span({ id: "a", start: 0, end: 100 }), span({ id: "b", start: 200, end: 300 })], 0.1);
    assert.equal(items.length, 2);
    assert.equal(items[0].kind, "span");
    assert.equal(items[1].kind, "span");
});

test("clusterSpans merges spans closer than minGapPx into one cluster", () => {
    const items = clusterSpans([span({ id: "a", start: 0, end: 100 }), span({ id: "b", start: 110, end: 200 })], 0.1);
    assert.equal(items.length, 1);
    const item = items[0];
    assert.equal(item.kind, "cluster");
    if (item.kind === "cluster") {
        assert.equal(item.cluster.count, 2);
        assert.equal(item.cluster.start, 0);
        assert.equal(item.cluster.end, 200);
        assert.deepEqual(item.cluster.spanIds, ["a", "b"]);
    }
});

test("clusterSpans chains three tight spans and tallies outcome counts", () => {
    const items = clusterSpans([
        span({ id: "a", start: 0, end: 10 }),
        span({ id: "b", start: 12, end: 20, outcome: "failed" }),
        span({ id: "c", start: 22, end: 30, outcome: "failed" }),
    ], 1);
    assert.equal(items.length, 1);
    const item = items[0];
    if (item.kind === "cluster") {
        assert.equal(item.cluster.count, 3);
        assert.equal(item.cluster.outcomeCounts.done, 1);
        assert.equal(item.cluster.outcomeCounts.failed, 2);
        assert.equal(item.cluster.end, 30);
    }
});

test("clusterSpans merges overlapping spans regardless of gap sign", () => {
    const items = clusterSpans([span({ id: "a", start: 0, end: 100 }), span({ id: "b", start: 50, end: 150 })], 0.1);
    assert.equal(items.length, 1);
    assert.equal(items[0].kind, "cluster");
});

test("clusterSpans returns an empty list for no spans", () => {
    assert.deepEqual(clusterSpans([], 1), []);
});

// ─── Auto-fit "Today" range ─────────────────────────────────────────────────

test("autoFitTodayRange fits from the first run today (minus 30m) to now (plus 15m)", () => {
    const nowMs = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const first = new Date(2026, 0, 15, 9, 0, 0).getTime();
    const r = autoFitTodayRange([{ startedAtMs: first, running: false }], nowMs);
    assert.equal(r.fromMs, first - 30 * 60_000);
    assert.equal(r.toMs, nowMs + 15 * 60_000);
});

test("autoFitTodayRange falls back to the last 8 hours on an empty day", () => {
    const nowMs = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const r = autoFitTodayRange([], nowMs);
    assert.equal(r.fromMs, nowMs - 8 * 3_600_000);
    assert.equal(r.toMs, nowMs);
});

test("autoFitTodayRange pins a yesterday-started running span to midnight", () => {
    const nowMs = new Date(2026, 0, 15, 10, 0, 0).getTime();
    const startOfToday = new Date(2026, 0, 15, 0, 0, 0).getTime();
    const r = autoFitTodayRange([{ startedAtMs: nowMs - 20 * 3_600_000, running: true }], nowMs);
    assert.equal(r.fromMs, startOfToday);
});

// ─── Time axis ticks ────────────────────────────────────────────────────────

const UTC = { offsetMinutes: () => 0 };
const T0 = Date.UTC(2026, 9, 19, 0, 0, 0); // Mon 19 Oct 2026, 00:00 UTC
const M = 60_000;
const H = 3_600_000;
const D = 86_400_000;

test("timeTicks labels a ~45-minute range with 5-minute ticks, not a single hour", () => {
    const from = T0 + 18 * H + 50 * M; // 18:50
    const t = timeTicks(from, from + 45 * M, 1000, UTC);
    assert.ok(t.major.length >= 6 && t.major.length <= 10, `got ${t.major.length}`);
    assert.equal(t.major[0].label, "18:50");
    assert.equal(t.major[1].label, "18:55");
    assert.ok(t.major.some((m) => m.label === "19:00"));
    assert.equal(t.major[1].ms - t.major[0].ms, 5 * M);
});

test("timeTicks uses 3-hour steps over one day and names the day at midnight", () => {
    const t = timeTicks(T0, T0 + D, 1000, UTC);
    assert.ok(t.major.length >= 6 && t.major.length <= 10, `got ${t.major.length}`);
    assert.deepEqual(t.major.slice(0, 3).map((m) => m.label), ["Mon 19", "03:00", "06:00"]);
    assert.equal(t.major[t.major.length - 1].label, "Tue 20");
    assert.ok(t.minor.length > 0, "faint minor ticks between the labels");
    assert.ok(t.minor.every((ms) => !t.major.some((m) => m.ms === ms)), "a minor tick never sits on a major one");
});

test("timeTicks labels 7 days as day names with faint hour ticks between", () => {
    const from = T0 + 14 * H; // mid-afternoon, not midnight
    const t = timeTicks(from, from + 7 * D, 1000, UTC);
    assert.deepEqual(t.major.map((m) => m.label), ["Tue 20", "Wed 21", "Thu 22", "Fri 23", "Sat 24", "Sun 25", "Mon 26"]);
    assert.ok(t.major.every((m) => m.ms % D === 0), "day ticks sit on midnight");
    assert.ok(!t.major.some((m) => /\d\d:\d\d/.test(m.label)), "no repeated clock labels");
    assert.ok(t.minor.length > 0 && t.minor.every((ms) => ms % H === 0), "minor ticks sit on whole hours");
});

test("timeTicks labels 30 days with month and day", () => {
    const t = timeTicks(T0 - 30 * D, T0, 1000, UTC);
    // 3-day steps; both range ends can land on a midnight, hence up to 11.
    assert.ok(t.major.length >= 6 && t.major.length <= 11, `got ${t.major.length}`);
    assert.ok(t.major.every((m) => /^[A-Z][a-z]{2} \d{1,2}$/.test(m.label) && /^(Sep|Oct) /.test(m.label)), t.major.map((m) => m.label).join(","));
    assert.ok(t.major.every((m) => m.ms % D === 0));
});

test("timeTicks follows the viewer's offset for labels and midnights", () => {
    // UTC+2: local midnight of Tue 20 is 22:00 UTC on Mon 19.
    const t = timeTicks(T0, T0 + 7 * D, 1000, { offsetMinutes: () => 120 });
    assert.equal(t.major[0].label, "Tue 20");
    assert.equal(t.major[0].ms, T0 + D - 2 * H);
});

test("timeTicks adds labels when the chart is zoomed wider", () => {
    const narrow = timeTicks(T0, T0 + D, 1000, UTC);
    const wide = timeTicks(T0, T0 + D, 4000, UTC);
    assert.ok(wide.major.length > narrow.major.length);
});

test("timeTicks returns nothing for an empty or inverted range", () => {
    assert.deepEqual(timeTicks(T0, T0, 1000, UTC), { major: [], minor: [] });
    assert.deepEqual(timeTicks(T0, T0 - 1, 1000, UTC), { major: [], minor: [] });
    assert.deepEqual(timeTicks(T0, T0 + H, 0, UTC), { major: [], minor: [] });
});
