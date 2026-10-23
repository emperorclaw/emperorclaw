import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_IDEMPOTENCY_TTL_HOURS,
    DEFAULT_RETENTION_BUDGET_MS,
    DEFAULT_RETENTION_BUDGET_ROWS,
    RETENTION_BATCH_SIZE,
    RETENTION_STEPS,
    idempotencyTtlHours,
    isPrepareStep,
    runRetention,
    ttlCutoff,
    type RetentionExecutor,
    type RetentionStep,
} from "../../src/lib/retention";

const HOUR = 3_600_000;

/** An executor that records every call and delegates row counts to `count`. */
function fakeExecutor(
    count: (step: RetentionStep, limit: number, call: number) => number | Promise<number>,
) {
    const calls: { step: string; limit: number; cutoff: Date }[] = [];
    const executor: RetentionExecutor = {
        async deleteBatch(step, cutoff, limit) {
            calls.push({ step: step.id, limit, cutoff });
            return count(step, limit, calls.length - 1);
        },
    };
    return { executor, calls };
}

function step(overrides: Partial<RetentionStep> & Pick<RetentionStep, "id">): RetentionStep {
    return {
        label: overrides.id,
        table: overrides.id,
        timeColumn: "created_at",
        cutoff: () => new Date(0),
        ...overrides,
    };
}

test("idempotencyTtlHours defaults, validates and clamps sub-1 values", () => {
    assert.equal(idempotencyTtlHours({}), DEFAULT_IDEMPOTENCY_TTL_HOURS);
    assert.equal(idempotencyTtlHours({ EMPEROR_IDEMPOTENCY_TTL_HOURS: "24" }), 24);
    assert.equal(idempotencyTtlHours({ EMPEROR_IDEMPOTENCY_TTL_HOURS: "1" }), 1);
    assert.equal(idempotencyTtlHours({ EMPEROR_IDEMPOTENCY_TTL_HOURS: "0" }), DEFAULT_IDEMPOTENCY_TTL_HOURS);
    assert.equal(idempotencyTtlHours({ EMPEROR_IDEMPOTENCY_TTL_HOURS: "-3" }), DEFAULT_IDEMPOTENCY_TTL_HOURS);
    assert.equal(idempotencyTtlHours({ EMPEROR_IDEMPOTENCY_TTL_HOURS: "nope" }), DEFAULT_IDEMPOTENCY_TTL_HOURS);
    assert.equal(idempotencyTtlHours({ EMPEROR_IDEMPOTENCY_TTL_HOURS: "" }), DEFAULT_IDEMPOTENCY_TTL_HOURS);
});

test("ttlCutoff subtracts whole hours from the run instant", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(ttlCutoff(now, 48).toISOString(), new Date(now.getTime() - 48 * HOUR).toISOString());
    assert.equal(ttlCutoff(now, 1).getTime(), now.getTime() - HOUR);
});

test("the default registry starts with the idempotency prune and adds the ledger steps in order", () => {
    assert.deepEqual(
        RETENTION_STEPS.map((entry) => entry.id),
        ["idempotency_keys", "agent_runs_lost", "agent_run_daily_rollup", "agent_run_events", "agent_runs", "message_routes", "agent_run_daily"],
    );
    const first = RETENTION_STEPS[0];
    assert.equal(isPrepareStep(first), false);
    if (isPrepareStep(first)) return;
    assert.equal(first.table, "idempotency_keys");
    assert.equal(first.timeColumn, "created_at");
    assert.equal(typeof first.cutoff, "function");
    // The step's cutoff honors the env-configured TTL.
    const now = new Date("2026-01-01T00:00:00.000Z");
    assert.equal(first.cutoff(now).getTime(), now.getTime() - DEFAULT_IDEMPOTENCY_TTL_HOURS * HOUR);
});

test("prepare steps run and count their touched rows toward the budget", async () => {
    const { executor, calls } = fakeExecutor(() => 0);
    const ran: string[] = [];
    const prepare = {
        id: "rollup",
        label: "Rollup",
        kind: "prepare" as const,
        run: async () => {
            ran.push("rollup");
            return 3;
        },
    };
    const summary = await runRetention(
        { now: new Date(0), budgetRows: 2 },
        { executor, clock: () => 0, steps: [prepare, step({ id: "t" })] },
    );
    assert.deepEqual(ran, ["rollup"]);
    assert.equal(summary.steps[0].deleted, 3);
    // The prepare step spent the row budget, so the later delete is deferred.
    assert.equal(summary.steps[1].exhausted, true);
    assert.equal(calls.length, 0);
});

test("batch loop stops when the row budget is exhausted", async () => {
    // Always a full batch: only the budget can stop it.
    const { executor, calls } = fakeExecutor((_step, limit) => limit);
    const summary = await runRetention(
        { now: new Date(0), budgetRows: RETENTION_BATCH_SIZE * 2, budgetMs: 60_000 },
        { executor, clock: () => 0, steps: [step({ id: "t" })] },
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => c.limit), [RETENTION_BATCH_SIZE, RETENTION_BATCH_SIZE]);
    assert.deepEqual(summary.steps, [{ table: "t", deleted: RETENTION_BATCH_SIZE * 2, exhausted: true }]);
});

test("batch loop stops when rows run out (short batch) without exhausting", async () => {
    const counts = [RETENTION_BATCH_SIZE, RETENTION_BATCH_SIZE, 123];
    const { executor, calls } = fakeExecutor((_step, _limit, call) => counts[call] ?? 0);
    const summary = await runRetention(
        { now: new Date(0), budgetRows: DEFAULT_RETENTION_BUDGET_ROWS, budgetMs: 60_000 },
        { executor, clock: () => 0, steps: [step({ id: "t" })] },
    );

    assert.equal(calls.length, 3);
    assert.deepEqual(summary.steps, [{ table: "t", deleted: RETENTION_BATCH_SIZE * 2 + 123, exhausted: false }]);
});

test("a zero-row step deletes nothing and is not exhausted", async () => {
    const { executor, calls } = fakeExecutor(() => 0);
    const summary = await runRetention(
        { now: new Date(0) },
        { executor, clock: () => 0, steps: [step({ id: "t" })] },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(summary.steps, [{ table: "t", deleted: 0, exhausted: false }]);
});

test("batch loop stops when the time budget is exhausted", async () => {
    let nowMs = 0;
    const { executor, calls } = fakeExecutor((_step, limit) => {
        nowMs += 6_000;
        return limit;
    });
    const summary = await runRetention(
        { now: new Date(0), budgetRows: DEFAULT_RETENTION_BUDGET_ROWS, budgetMs: 10_000 },
        { executor, clock: () => nowMs, steps: [step({ id: "t" })] },
    );

    assert.equal(calls.length, 2);
    assert.deepEqual(summary.steps, [{ table: "t", deleted: RETENTION_BATCH_SIZE * 2, exhausted: true }]);
    assert.equal(DEFAULT_RETENTION_BUDGET_MS, 20_000);
});

test("steps run in registry order", async () => {
    const { executor, calls } = fakeExecutor(() => 0);
    const summary = await runRetention(
        { now: new Date(0) },
        { executor, clock: () => 0, steps: [step({ id: "a" }), step({ id: "b" }), step({ id: "c" })] },
    );
    assert.deepEqual(calls.map((c) => c.step), ["a", "b", "c"]);
    assert.deepEqual(summary.steps.map((s) => s.table), ["a", "b", "c"]);
});

test("a failing step is recorded and later steps still run", async () => {
    const { executor } = fakeExecutor((s) => {
        if (s.id === "boom") throw new Error("nope");
        return 0;
    });
    const summary = await runRetention(
        { now: new Date(0) },
        { executor, clock: () => 0, steps: [step({ id: "boom" }), step({ id: "ok" })] },
    );
    assert.equal(summary.steps[0].error, "nope");
    assert.equal(summary.steps[0].deleted, 0);
    assert.equal(summary.steps[1].error, undefined);
    assert.equal(summary.steps[1].deleted, 0);
});

test("steps after an exhausted budget are deferred, not run", async () => {
    const { executor, calls } = fakeExecutor((_step, limit) => limit);
    const summary = await runRetention(
        { now: new Date(0), budgetRows: RETENTION_BATCH_SIZE, budgetMs: 60_000 },
        { executor, clock: () => 0, steps: [step({ id: "first" }), step({ id: "second" })] },
    );
    assert.equal(calls.length, 1);
    assert.deepEqual(summary.steps, [
        { table: "first", deleted: RETENTION_BATCH_SIZE, exhausted: true },
        { table: "second", deleted: 0, exhausted: true },
    ]);
});

test("summary carries the run instant and duration and is persisted", async () => {
    const { executor } = fakeExecutor(() => 0);
    let saved: unknown = null;
    const summary = await runRetention(
        { now: new Date("2026-05-01T12:00:00.000Z") },
        {
            executor,
            clock: (() => {
                let t = 100;
                return () => t++;
            })(),
            steps: [step({ id: "t" })],
            saveSummary: async (value) => {
                saved = value;
            },
        },
    );
    assert.equal(summary.startedAt, "2026-05-01T12:00:00.000Z");
    assert.ok(summary.durationMs > 0);
    assert.equal(saved, summary);
});
