import { test } from "node:test";
import assert from "node:assert/strict";
import {
    actorColour,
    buildWorkTimeline,
    clipSpan,
    deriveEdges,
    eventKindFor,
    initialsOf,
    TIMELINE_SPAN_CAP,
    type BuildRunSource,
    type BuildTimelineInput,
    type EdgeEventInput,
    type EdgeRunInput,
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
        threadLabel: null,
        href: "/projects/tasks/t1",
        status: "succeeded",
        exitReason: null,
        pendingApproval: false,
        triggerKind: "task",
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
        humans: [],
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

test("buildWorkTimeline orders agents first by activity, then humans", () => {
    const tl = buildWorkTimeline(baseInput({
        humans: [{ id: "u1", name: "Priya" }],
        runs: [
            run({ runId: "r1", agentId: "agent:a1", startedAtMs: 0, endedAtMs: 100 }),           // little activity
            run({ runId: "r2", agentId: "agent:a2", startedAtMs: 0, endedAtMs: 3000 }),          // lots
            run({ runId: "r3", agentId: "human:u1", startedAtMs: 0, endedAtMs: 1000, taskId: null, href: null }),
        ],
    }));
    assert.equal(tl.actors[0].id, "agent:a2");
    assert.equal(tl.actors[1].id, "agent:a1");
    assert.equal(tl.actors[2].id, "human:u1");
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

test("buildWorkTimeline derives visible actors from the agent and human lists, never from runs or events", () => {
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
