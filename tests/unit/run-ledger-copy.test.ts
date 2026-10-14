import { test } from "node:test";
import assert from "node:assert/strict";
import {
    deliveryVerdictCopy,
    formatRunDuration,
    formatRunTokens,
    formatTokenCount,
    runStatusCopy,
    summarizeRunDaily,
    triggerKindLabel,
    type RunDailyInput,
} from "../../src/lib/run-ledger-copy";

test("deliveryVerdictCopy maps every route reason to plain language", () => {
    const verdict = (routeReason: string, addressed = true, agentStreak = 0, maxTurns = 12) =>
        deliveryVerdictCopy({ addressed, routeReason, agentStreak, maxTurns });

    assert.equal(verdict("targeted").label, "Delivered — directed to this agent");
    assert.equal(verdict("direct").label, "Delivered — direct message");
    assert.equal(verdict("mention").label, "Delivered — mentioned");
    assert.equal(verdict("all").label, "Delivered — @all in the group");
    assert.equal(verdict("agent_pair").label, "Delivered — pair handoff");
    assert.equal(verdict("task_assigned").label, "Delivered — task assigned");
    assert.equal(verdict("self", false).label, "Not delivered — the agent's own message");
    assert.equal(verdict("targeted_other", false).label, "Not delivered — addressed to another agent");
    assert.equal(verdict("not_addressed", false).label, "Not delivered — not addressed");
});

test("deliveryVerdictCopy names the loop-guard streak and cap", () => {
    const copy = deliveryVerdictCopy({ addressed: false, routeReason: "loop_paused", agentStreak: 13, maxTurns: 12 });
    assert.equal(copy.outcome, "not_delivered");
    assert.equal(copy.label, "Not delivered — paused by the loop guard (13 of 12 agent messages without a human)");
});

test("deliveryVerdictCopy falls back to the raw reason for an unknown value", () => {
    const copy = deliveryVerdictCopy({ addressed: false, routeReason: "some_new_reason", agentStreak: 0, maxTurns: 12 });
    assert.equal(copy.outcome, "not_delivered");
    assert.equal(copy.label, "Not delivered — some_new_reason");
});

test("formatRunDuration renders seconds, padded minutes and hours", () => {
    assert.equal(formatRunDuration(null), "—");
    assert.equal(formatRunDuration(-1), "—");
    assert.equal(formatRunDuration(0), "0ms");
    assert.equal(formatRunDuration(420), "420ms");
    assert.equal(formatRunDuration(8_400), "8s");
    assert.equal(formatRunDuration(123_000), "2m 03s");
    assert.equal(formatRunDuration(60_000), "1m 00s");
    assert.equal(formatRunDuration(3_720_000), "1h 02m");
});

test("formatTokenCount compacts thousands and millions", () => {
    assert.equal(formatTokenCount(null), "—");
    assert.equal(formatTokenCount(420), "420");
    assert.equal(formatTokenCount(1_500), "1.5k");
    assert.equal(formatTokenCount(81_000), "81k");
    assert.equal(formatTokenCount(81_400), "81.4k");
    assert.equal(formatTokenCount(1_200_000), "1.2M");
});

test("formatRunTokens joins input and output, with — for a missing side", () => {
    assert.equal(formatRunTokens(81_000, 420), "81k in · 420 out");
    assert.equal(formatRunTokens(81_000, null), "81k in · — out");
    assert.equal(formatRunTokens(null, null), "—");
});

test("runStatusCopy gives every status a label and a tone", () => {
    assert.deepEqual(runStatusCopy("succeeded"), { label: "Succeeded", tone: "ok" });
    assert.deepEqual(runStatusCopy("failed"), { label: "Failed", tone: "bad" });
    assert.deepEqual(runStatusCopy("timeout"), { label: "Timed out", tone: "warn" });
    assert.deepEqual(runStatusCopy("lost"), { label: "Lost", tone: "bad" });
    assert.deepEqual(runStatusCopy("running"), { label: "Running", tone: "info" });
    assert.deepEqual(runStatusCopy("cancelled"), { label: "Cancelled", tone: "muted" });
    assert.deepEqual(runStatusCopy("blocked"), { label: "Blocked", tone: "warn" });
    assert.equal(runStatusCopy("mystery").label, "mystery");
});

test("triggerKindLabel humanizes trigger kinds", () => {
    assert.equal(triggerKindLabel("message"), "Message");
    assert.equal(triggerKindLabel("task"), "Task");
    assert.equal(triggerKindLabel("objective"), "Objective");
    assert.equal(triggerKindLabel(null), "Unknown");
});

function day(overrides: Partial<RunDailyInput>): RunDailyInput {
    return {
        runs: 0, succeeded: 0, failed: 0, timeout: 0, lost: 0,
        p50Ms: null, p95Ms: null, inputTokens: 0, outputTokens: 0, costCents: 0, toolCalls: 0,
        ...overrides,
    };
}

test("summarizeRunDaily sums counts and totals", () => {
    const summary = summarizeRunDaily([
        day({ runs: 10, succeeded: 8, failed: 2, inputTokens: 1_000, outputTokens: 500, costCents: 120, toolCalls: 40 }),
        day({ runs: 4, succeeded: 2, failed: 1, timeout: 1, inputTokens: 400, outputTokens: 100, costCents: 30, toolCalls: 9 }),
    ]);
    assert.equal(summary.runs, 14);
    assert.equal(summary.succeeded, 10);
    assert.equal(summary.unsuccessful, 4);
    assert.equal(summary.successRate, 10 / 14);
    assert.equal(summary.inputTokens, 1_400);
    assert.equal(summary.outputTokens, 600);
    assert.equal(summary.costCents, 150);
    assert.equal(summary.toolCalls, 49);
});

test("summarizeRunDaily weights percentiles by runs and is null with no samples", () => {
    const empty = summarizeRunDaily([]);
    assert.equal(empty.successRate, null);
    assert.equal(empty.p50Ms, null);

    const summary = summarizeRunDaily([
        day({ runs: 10, succeeded: 10, p50Ms: 1_000, p95Ms: 5_000 }),
        day({ runs: 30, succeeded: 30, p50Ms: 3_000, p95Ms: 9_000 }),
    ]);
    // (1000*10 + 3000*30) / 40 = 2500; (5000*10 + 9000*30) / 40 = 8000
    assert.equal(summary.p50Ms, 2_500);
    assert.equal(summary.p95Ms, 8_000);
});
