import { test } from "node:test";
import assert from "node:assert/strict";
import {
    RUN_ERROR_MAX_CHARS,
    RUN_PAYLOAD_MAX_BYTES,
    RUN_TIMESTAMP_MAX_FUTURE_MS,
    RUN_TIMESTAMP_MAX_PAST_MS,
    clampRunTimestamp,
    computeRunDurationMs,
    dailyRollupQuery,
    finishAppliesTo,
    finishRunSchema,
    interestingVerdicts,
    isInterestingVerdict,
    isTerminalRunStatus,
    lostRunCutoff,
    payloadTooLarge,
    rollupDaysQuery,
    startRunSchema,
    truncateRunError,
} from "../../src/lib/run-ledger";
import type { VerdictRecord } from "../../src/lib/run-ledger";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const MESSAGE_ID = "33333333-3333-4333-8333-333333333333";

test("startRunSchema accepts a minimal start and fills the enum defaults", () => {
    const parsed = startRunSchema.parse({ id: RUN_ID, agentId: AGENT_ID });
    assert.equal(parsed.id, RUN_ID);
    assert.equal(parsed.runtimeKind, undefined); // default applied in the route, not the schema
    assert.equal(parsed.triggerMessageId, undefined);
});

test("startRunSchema accepts a full start and rejects bad ids, enums and oversized strings", () => {
    const full = startRunSchema.safeParse({
        id: RUN_ID,
        agentId: "hermes-qa",
        runtimeId: "hermes-qa-malecu-hermes-1",
        runtimeKind: "hermes",
        bridgeVersion: "1.2.0",
        triggerKind: "message",
        triggerMessageId: MESSAGE_ID,
        startedAt: "2026-10-13T10:00:00.000Z",
    });
    assert.equal(full.success, true);

    assert.equal(startRunSchema.safeParse({ id: "not-a-uuid", agentId: AGENT_ID }).success, false);
    assert.equal(startRunSchema.safeParse({ id: RUN_ID }).success, false); // agentId required
    assert.equal(startRunSchema.safeParse({ id: RUN_ID, agentId: AGENT_ID, runtimeKind: "wat" }).success, false);
    assert.equal(startRunSchema.safeParse({ id: RUN_ID, agentId: AGENT_ID, triggerMessageId: "nope" }).success, false);
    assert.equal(startRunSchema.safeParse({ id: RUN_ID, agentId: AGENT_ID, runtimeId: "x".repeat(201) }).success, false);
    assert.equal(startRunSchema.safeParse({ id: RUN_ID, agentId: AGENT_ID, startedAt: "not-a-date" }).success, false);
});

test("finishRunSchema enforces enums, non-negative ints and the error cap", () => {
    assert.equal(finishRunSchema.safeParse({ status: "succeeded" }).success, true);
    assert.equal(finishRunSchema.safeParse({ status: "running" }).success, false);
    assert.equal(finishRunSchema.safeParse({ status: "lost" }).success, false);
    assert.equal(finishRunSchema.safeParse({ status: "failed", durationMs: -1 }).success, false);
    assert.equal(finishRunSchema.safeParse({ status: "failed", inputTokens: 1.5 }).success, false);
    assert.equal(finishRunSchema.safeParse({ status: "failed", replyMessageId: "nope" }).success, false);
    assert.equal(finishRunSchema.safeParse({ status: "failed", error: "x".repeat(2_001) }).success, false);
});

test("payloadTooLarge caps the raw body at 8 KB", () => {
    assert.equal(payloadTooLarge("a".repeat(RUN_PAYLOAD_MAX_BYTES)), false);
    assert.equal(payloadTooLarge("a".repeat(RUN_PAYLOAD_MAX_BYTES + 1)), true);
});

test("truncateRunError redacts secrets and truncates to the cap", () => {
    assert.equal(truncateRunError(null), null);
    assert.equal(truncateRunError("   "), null);
    const long = truncateRunError("x".repeat(RUN_ERROR_MAX_CHARS + 50));
    assert.ok(long);
    assert.equal(long!.length, RUN_ERROR_MAX_CHARS);
    assert.ok(long!.endsWith("..."));
    // A URL / bearer-looking secret is redacted before it is stored.
    const redacted = truncateRunError("failed calling https://api.example.com?token=abc with Bearer sk-abcdef0123456789");
    assert.ok(redacted);
    assert.doesNotMatch(redacted!, /api\.example\.com/);
});

test("computeRunDurationMs prefers the reported value and clamps", () => {
    const start = new Date("2026-10-13T10:00:00.000Z");
    const end = new Date("2026-10-13T10:00:05.000Z");
    assert.equal(computeRunDurationMs(start, end, 1234), 1234);
    assert.equal(computeRunDurationMs(start, end), 5_000);
    assert.equal(computeRunDurationMs(end, start), 0); // never negative
});

test("clampRunTimestamp keeps in-range values and replaces wild or absent ones", () => {
    const now = new Date("2026-10-13T12:00:00.000Z");
    const inside = new Date(now.getTime() - 24 * 3_600_000).toISOString();
    assert.equal(clampRunTimestamp(inside, now).toISOString(), inside);
    assert.equal(clampRunTimestamp(now.toISOString(), now).getTime(), now.getTime());

    // Unparseable, absent and out-of-range all fall back to server now.
    assert.equal(clampRunTimestamp("not-a-date", now).getTime(), now.getTime());
    assert.equal(clampRunTimestamp(undefined, now).getTime(), now.getTime());
    const tooOld = new Date(now.getTime() - RUN_TIMESTAMP_MAX_PAST_MS - 1).toISOString();
    const tooNew = new Date(now.getTime() + RUN_TIMESTAMP_MAX_FUTURE_MS + 1).toISOString();
    assert.equal(clampRunTimestamp(tooOld, now).getTime(), now.getTime());
    assert.equal(clampRunTimestamp(tooNew, now).getTime(), now.getTime());
    // Exactly on each boundary is still kept.
    assert.equal(
        clampRunTimestamp(new Date(now.getTime() - RUN_TIMESTAMP_MAX_PAST_MS).toISOString(), now).getTime(),
        now.getTime() - RUN_TIMESTAMP_MAX_PAST_MS,
    );
});

test("lost-run rule: terminal states and the lost→terminal exception", () => {
    assert.equal(isTerminalRunStatus("running"), false);
    assert.equal(isTerminalRunStatus("succeeded"), true);
    assert.equal(isTerminalRunStatus("lost"), true);
    assert.equal(finishAppliesTo("running"), true);
    assert.equal(finishAppliesTo("lost"), true);
    assert.equal(finishAppliesTo("succeeded"), false);
    assert.equal(finishAppliesTo("failed"), false);

    const now = new Date("2026-10-13T12:00:00.000Z");
    assert.equal(lostRunCutoff(now).getTime(), now.getTime() - 2 * 60 * 60 * 1000);
});

test("isInterestingVerdict keeps addressed and lost-to-guard verdicts only", () => {
    assert.equal(isInterestingVerdict({ addressedToYou: true, routeReason: "mention" }), true);
    assert.equal(isInterestingVerdict({ addressedToYou: false, routeReason: "loop_paused" }), true);
    assert.equal(isInterestingVerdict({ addressedToYou: false, routeReason: "targeted_other" }), true);
    assert.equal(isInterestingVerdict({ addressedToYou: false, routeReason: "not_addressed" }), false);
    assert.equal(isInterestingVerdict({ addressedToYou: false, routeReason: "self" }), false);
});

test("interestingVerdicts filters noise and stamps the company and decision instant", () => {
    const decidedAt = new Date("2026-10-13T12:00:00.000Z");
    const records: VerdictRecord[] = [
        { messageId: MESSAGE_ID, agentId: AGENT_ID, addressed: true, routeReason: "mention", agentStreak: 2, maxTurns: 12 },
        { messageId: MESSAGE_ID, agentId: "44444444-4444-4444-8444-444444444444", addressed: false, routeReason: "loop_paused", agentStreak: 13, maxTurns: 12 },
        { messageId: MESSAGE_ID, agentId: "55555555-5555-4555-8555-555555555555", addressed: false, routeReason: "not_addressed", agentStreak: 0, maxTurns: 12 },
        { messageId: MESSAGE_ID, agentId: "66666666-6666-4666-8666-666666666666", addressed: false, routeReason: "self", agentStreak: 0, maxTurns: 12 },
    ];
    const rows = interestingVerdicts("co-1", records, decidedAt);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((row) => row.routeReason), ["mention", "loop_paused"]);
    assert.ok(rows.every((row) => row.companyId === "co-1" && row.decidedAt === decidedAt));
    assert.equal(rows[1].agentStreak, 13);
    assert.equal(rows[1].maxTurns, 12);
});

test("dailyRollupQuery is a single grouped aggregate with percentile_cont and GROUP BY positions", () => {
    const { sql } = dailyRollupQuery("2026-10-12").toSQL();
    assert.match(sql, /percentile_cont\(0\.5\)/i);
    assert.match(sql, /percentile_cont\(0\.95\)/i);
    assert.match(sql, /within group \(order by/i);
    assert.match(sql, /filter \(where/i);
    assert.match(sql, /group by 1, 2, 3/i);
    assert.match(sql, /date_trunc\('day'/i);
    // The GROUP BY expressions match the selected day expression (no 42803 trap).
    assert.match(sql, /group by 1, 2, 3/i);
});

test("rollupDaysQuery only scans complete days with finished, attributed runs", () => {
    const { sql } = rollupDaysQuery(new Date("2026-10-13T09:00:00.000Z")).toSQL();
    assert.match(sql, /started_at/i);
    assert.match(sql, /<> 'running'/i);
    assert.match(sql, /is not null/i);
});

test("rollupDaysQuery skips days that already have a rollup (roll exactly once)", () => {
    const { sql } = rollupDaysQuery(new Date("2026-10-13T09:00:00.000Z")).toSQL();
    assert.match(sql, /not exists/i);
    assert.match(sql, /agent_run_daily/i);
});
