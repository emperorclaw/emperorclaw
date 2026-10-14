import { test } from "node:test";
import assert from "node:assert/strict";
import {
    buildDailyWindow,
    buildRunsQuery,
    isPersistedUuid,
    runThreadLink,
    summarizeRunDaily,
    type RunDailyDay,
    type RunDailyInput,
} from "../../src/lib/run-ledger-copy";

function day(overrides: Partial<RunDailyDay>): RunDailyDay {
    return {
        day: "2026-03-15",
        runs: 0, succeeded: 0, failed: 0, timeout: 0, lost: 0,
        p50Ms: null, p95Ms: null, inputTokens: 0, outputTokens: 0, costCents: 0, toolCalls: 0,
        ...overrides,
    };
}

test("buildDailyWindow spans exactly windowDays UTC calendar days, oldest first", () => {
    const window = buildDailyWindow([], 30, new Date("2026-03-15T12:00:00Z"));
    assert.equal(window.length, 30);
    assert.equal(window[0].day, "2026-02-14");
    assert.equal(window[29].day, "2026-03-15");
});

test("buildDailyWindow crosses month boundaries in UTC", () => {
    const window = buildDailyWindow([], 3, new Date("2026-03-01T00:30:00Z"));
    assert.deepEqual(window.map((d) => d.day), ["2026-02-27", "2026-02-28", "2026-03-01"]);
});

test("buildDailyWindow separates a recorded zero-run day from a missing day", () => {
    const window = buildDailyWindow([
        day({ day: "2026-03-15", runs: 0 }),
        day({ day: "2026-03-14", runs: 3, succeeded: 2, failed: 1 }),
    ], 30, new Date("2026-03-15T08:00:00Z"));

    const today = window[29];
    assert.equal(today.hasData, true);
    assert.equal(today.succeeded, 0);
    assert.equal(today.unsuccessful, 0);

    const yesterday = window[28];
    assert.equal(yesterday.hasData, true);
    assert.equal(yesterday.succeeded, 2);
    assert.equal(yesterday.unsuccessful, 1);

    const older = window[0];
    assert.equal(older.hasData, false);
    assert.equal(older.succeeded + older.unsuccessful, 0);
});

test("buildDailyWindow folds failed, timeout and lost into unsuccessful", () => {
    const window = buildDailyWindow([
        day({ day: "2026-03-15", runs: 4, succeeded: 1, failed: 1, timeout: 1, lost: 1 }),
    ], 1, new Date("2026-03-15T23:59:00Z"));
    assert.equal(window[0].unsuccessful, 3);
});

test("buildRunsQuery builds only the params that are present", () => {
    assert.equal(buildRunsQuery({}), "");
    assert.equal(buildRunsQuery({ status: "failed" }), "status=failed");
    assert.equal(buildRunsQuery({ cursor: "2026-03-15T00:00:00.000Z|id" }), `cursor=${encodeURIComponent("2026-03-15T00:00:00.000Z|id")}`);
    assert.equal(buildRunsQuery({ status: "lost", cursor: "abc" }), "status=lost&cursor=abc");
    assert.equal(buildRunsQuery({ status: null, cursor: null }), "");
});

test("runThreadLink links only thread types the messaging hub can open", () => {
    assert.equal(runThreadLink({ threadId: null, threadType: "group", agentId: "a" }), null);
    assert.equal(runThreadLink({ threadId: "t1", threadType: "group", agentId: null }), "/messages?group=t1");
    assert.equal(runThreadLink({ threadId: "t1", threadType: "direct", agentId: "a1" }), "/messages?agent=a1");
    assert.equal(runThreadLink({ threadId: "t1", threadType: "direct", agentId: null }), null);
    assert.equal(runThreadLink({ threadId: "t1", threadType: "team", agentId: "a1" }), null);
    assert.equal(runThreadLink({ threadId: "t1", threadType: null, agentId: "a1" }), null);
});

test("isPersistedUuid accepts stored ids and rejects optimistic ones", () => {
    assert.equal(isPersistedUuid("3f0ffbf0-1a2b-4c3d-8e4f-5a6b7c8d9e0f"), true);
    assert.equal(isPersistedUuid("temp-1700000000000"), false);
    assert.equal(isPersistedUuid(""), false);
    assert.equal(isPersistedUuid(null), false);
    assert.equal(isPersistedUuid(undefined), false);
});

test("summarizeRunDaily keeps the success rate null with zero terminal runs", () => {
    const none: RunDailyInput[] = [day({ runs: 0 })];
    const summary = summarizeRunDaily(none);
    assert.equal(summary.runs, 0);
    assert.equal(summary.succeeded, 0);
    assert.equal(summary.unsuccessful, 0);
    assert.equal(summary.successRate, null);
});
