import assert from "node:assert/strict";
import test from "node:test";
import {
    bridgeBadgeCopy, cacheHitPercent, chatPollDelayMs, clipActivity, eventsSinceParam, formatElapsed, holdActivity,
    isTimedStepKind, lastReasoningLine, LIVE_ACTIVITY_HOLD_MS, LIVE_RUN_STEPS_KEPT, liveUsageLine, mergeLiveRuns,
    nextTurnStart, runFooterSummary, runningRun, timelineRows, visibleActivity, type ClientLiveRun, type TimelineStep,
} from "../../src/lib/live-activity";
import type { RunLive, RunStep } from "../../src/lib/run-events";

test("formatElapsed renders seconds, minutes and hours compactly", () => {
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(-500), "0s");
    assert.equal(formatElapsed(Number.NaN), "0s");
    assert.equal(formatElapsed(4_999), "4s");
    assert.equal(formatElapsed(65_000), "1m 05s");
    assert.equal(formatElapsed(3_600_000 + 2 * 60_000 + 30_000), "1h 02m");
});

test("clipActivity keeps case, collapses whitespace and clips long text", () => {
    assert.equal(clipActivity("  Running  Terminal:\n npm test "), "Running Terminal: npm test");
    assert.equal(clipActivity("   "), null);
    assert.equal(clipActivity(null), null);
    const clipped = clipActivity("x".repeat(300), 10);
    assert.equal(clipped, `${"x".repeat(9)}…`);
});

test("a missed refresh keeps the last activity until the hold expires", () => {
    const t0 = 1_000_000;
    let held = holdActivity(null, "Reading the brief", t0);
    assert.equal(visibleActivity(held, t0), "Reading the brief");

    // Refresh arrives with no activity (server cleared it): keep the old line.
    held = holdActivity(held, null, t0 + 3_000);
    assert.equal(visibleActivity(held, t0 + 3_000), "Reading the brief");
    assert.equal(visibleActivity(held, t0 + LIVE_ACTIVITY_HOLD_MS), "Reading the brief");
    assert.equal(visibleActivity(held, t0 + LIVE_ACTIVITY_HOLD_MS + 1), null);

    // A fresh line replaces it and restarts the hold.
    held = holdActivity(held, "Calling web_search", t0 + 25_000);
    assert.equal(visibleActivity(held, t0 + 40_000), "Calling web_search");
});

test("the turn timer survives refreshes and restarts only for new work", () => {
    let state = nextTurnStart({ startedAt: null, key: null }, { active: true, key: null, now: 100 });
    assert.deepEqual(state, { startedAt: 100, key: null });

    // Typing first, then the prompt flips to acting: same turn, same start.
    state = nextTurnStart(state, { active: true, key: "m1", now: 2_000 });
    assert.deepEqual(state, { startedAt: 100, key: "m1" });

    // A refresh with no key keeps the known prompt.
    state = nextTurnStart(state, { active: true, key: null, now: 3_000 });
    assert.deepEqual(state, { startedAt: 100, key: "m1" });

    // The next queued prompt becomes active: restart.
    state = nextTurnStart(state, { active: true, key: "m2", now: 9_000 });
    assert.deepEqual(state, { startedAt: 9_000, key: "m2" });

    // Work ends: reset, and the next turn starts fresh.
    state = nextTurnStart(state, { active: false, key: null, now: 10_000 });
    assert.deepEqual(state, { startedAt: null, key: null });
    state = nextTurnStart(state, { active: true, key: "m3", now: 12_000 });
    assert.deepEqual(state, { startedAt: 12_000, key: "m3" });
});

// ─── Live runs ──────────────────────────────────────────────────────────────

const RUN_A = "11111111-1111-4111-8111-111111111111";
const RUN_B = "22222222-2222-4222-8222-222222222222";

function step(seq: number, kind: RunStep["kind"], extra: Partial<RunStep> = {}): RunStep {
    return { seq, ts: new Date(Date.UTC(2026, 9, 22, 12, 0, seq)).toISOString(), kind, ...extra };
}

function live(over: Partial<RunLive> = {}): RunLive {
    return {
        runId: RUN_A, agentId: "agent-1", triggerMessageId: null, status: "running",
        startedAt: "2026-10-22T12:00:00.000Z",
        current: { kind: "tool.start", toolName: "terminal", summary: "Running terminal · npm test", sinceMs: 4_000 },
        steps: [], ...over,
    };
}

test("the chat polls fast only while a run is live", () => {
    assert.equal(chatPollDelayMs("direct", true), 1_500);
    assert.equal(chatPollDelayMs("direct", false), 3_000);
    assert.equal(chatPollDelayMs("team", true), 2_000);
    assert.equal(chatPollDelayMs("team", false), 5_000);
});

test("incremental polls merge steps by seq, cap them, and drop aged-out runs", () => {
    let held: ClientLiveRun[] = mergeLiveRuns([], [live({ steps: [step(1, "tool.start"), step(2, "tool.end")] })], 10_000);
    assert.equal(held[0].steps.length, 2);
    assert.equal(held[0].currentStartedAt, 6_000);
    assert.equal(eventsSinceParam(held), `${RUN_A}:2`);

    // eventsSince poll: only newer steps; the same current step keeps its start.
    held = mergeLiveRuns(held, [live({ current: { kind: "tool.start", toolName: "terminal", summary: "Running terminal · npm test", sinceMs: 5_600 }, steps: [step(3, "reasoning", { summary: "hm" })] })], 11_500);
    assert.deepEqual(held[0].steps.map((s) => s.seq), [1, 2, 3]);
    assert.equal(held[0].currentStartedAt, 6_000, "same step: no timer jitter");

    // A new current step restarts the step clock.
    held = mergeLiveRuns(held, [live({ current: { kind: "reasoning", summary: "Thinking", sinceMs: 0 }, steps: [] })], 12_000);
    assert.equal(held[0].currentStartedAt, 12_000);

    // Over the cap: newest steps win.
    const many = Array.from({ length: 12 }, (_, i) => step(10 + i, "tool.end"));
    held = mergeLiveRuns(held, [live({ steps: many })], 13_000);
    assert.equal(held[0].steps.length, LIVE_RUN_STEPS_KEPT);
    assert.equal(held[0].steps[held[0].steps.length - 1].seq, 21);

    // A run missing from the poll aged out; an old server (no liveRuns) clears all.
    held = mergeLiveRuns(held, [live({ runId: RUN_B, steps: [] })], 14_000);
    assert.deepEqual(held.map((r) => r.runId), [RUN_B]);
    assert.equal(eventsSinceParam(held), null);
    assert.deepEqual(mergeLiveRuns(held, undefined, 15_000), []);
});

test("runningRun picks the newest running run, optionally for one agent", () => {
    const runs = [live({ runId: RUN_B, status: "succeeded" }), live({ agentId: "agent-2" }), live()];
    assert.equal(runningRun(runs)?.agentId, "agent-2");
    assert.equal(runningRun(runs, "agent-1")?.runId, RUN_A);
    assert.equal(runningRun(runs, "agent-3"), null);
});

test("the status row shows a step timer for tools and the last reasoning line", () => {
    assert.equal(isTimedStepKind("tool.start"), true);
    assert.equal(isTimedStepKind("reasoning"), false);
    const run = live({ steps: [step(1, "reasoning", { summary: "check  the\n tests" }), step(2, "tool.start", { toolName: "terminal" })] });
    assert.equal(lastReasoningLine(run), "Thinking · check the tests");
    assert.equal(lastReasoningLine({ ...run, current: { kind: "reasoning", summary: "Thinking · x", sinceMs: 0 } }), null);
    assert.equal(lastReasoningLine(live()), null);
});

test("timeline rows pair tool start/end, keep notices muted and close compaction", () => {
    const steps: TimelineStep[] = [
        { seq: 1, ts: "t1", kind: "tool.start", toolName: "read_file", toolCallId: "c1", summary: "hostname" },
        { seq: 2, ts: "t2", kind: "tool.start", toolName: "terminal" },
        { seq: 3, ts: "t3", kind: "notice", summary: "Retrying model call" },
        { seq: 4, ts: "t4", kind: "tool.end", toolName: "read_file", toolCallId: "c1", status: "ok", durationMs: 67, summary: "hostname" },
        { seq: 5, ts: "t5", kind: "tool.end", toolName: "terminal", status: "error", durationMs: 1200 },
        { seq: 6, ts: "t6", kind: "compaction.start" },
        { seq: 7, ts: "t7", kind: "compaction.end", durationMs: 900 },
        { seq: 8, ts: "t8", kind: "usage" },
        { seq: 9, ts: "t9", kind: "tool.start", toolName: "web_search", toolCallId: "c9" },
    ];
    const rows = timelineRows(steps);
    assert.deepEqual(rows.map((r) => [r.kind, r.label, r.status, r.durationMs]), [
        ["tool", "read_file", "ok", 67],
        ["tool", "terminal", "error", 1200],
        ["notice", "Note", "info", null],
        ["compaction", "Memory tidied", "ok", 900],
        ["tool", "web_search", "running", null],
    ]);
    assert.equal(rows[0].detail, "hostname");
    assert.equal(rows[2].detail, "Retrying model call");
    // An orphan end (its start was capped away) still shows.
    assert.equal(timelineRows([{ seq: 1, ts: "t", kind: "tool.end", toolName: "x", durationMs: 5 }])[0].status, "ok");
});

test("reply footer, usage and cache copy", () => {
    assert.equal(runFooterSummary({ durationMs: 42_000, toolCalls: 6, inputTokens: 18_000, outputTokens: 200, model: "deepseek-v4" }), "Worked 42s · 6 tools · 18.2k tokens · deepseek-v4");
    assert.equal(runFooterSummary({ durationMs: 900, toolCalls: 1 }), "Worked 900ms · 1 tool");
    assert.equal(runFooterSummary({}), null);
    assert.equal(liveUsageLine({ input: 18_200, output: 900, cacheRead: 12_000, contextPercent: 41 }), "18.2k in · 900 out · 12k cached · 41% context");
    assert.equal(liveUsageLine(null), null);
    assert.equal(cacheHitPercent(1000, 650), 65);
    assert.equal(cacheHitPercent(0, 10), null);
    assert.equal(cacheHitPercent(1000, null), null);
});

test("bridge badges cover every update state", () => {
    assert.equal(bridgeBadgeCopy("current", "0.9.0", false).label, "Bridge 0.9.0");
    assert.equal(bridgeBadgeCopy("current", "0.9.0", false).showGuide, false);
    const update = bridgeBadgeCopy("update-available", "0.9.0", false);
    assert.equal(update.label, "Update available");
    assert.equal(update.tone, "warn");
    assert.match(update.hint, /emperor-hermes update/);
    assert.match(bridgeBadgeCopy("update-available", "0.9.0", true).hint, /Recreate the runtime/);
    assert.equal(bridgeBadgeCopy("unsupported", "0.8.0", false).tone, "bad");
    const legacy = bridgeBadgeCopy("legacy", null, false);
    assert.equal(legacy.label, "Legacy bridge");
    assert.match(legacy.hint, /0\.10\.0/);
});
