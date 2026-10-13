import { eq, sql, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db } from "@/db";
import { agentRuns, instanceSettings } from "@/db/schema";
import {
    RUN_DAILY_RETENTION_DAYS,
    closeLostRuns,
    rollupFinishedRuns,
} from "@/lib/run-ledger";

/**
 * Data retention: prune high-volume tables on a schedule so nothing grows
 * without bound. The job is a registry of steps run in order; each step deletes
 * rows older than a per-table cutoff in bounded batches, so a single tick never
 * holds locks for long and the first deploy can drain an existing backlog over
 * several ticks instead of one long lock.
 *
 * PR 2 adds the run-ledger tables (`agent_runs`, `message_routes`) and the
 * rollup step by appending entries to `RETENTION_STEPS`.
 */

/** Rows deleted per statement. Small enough to keep each batch's lock short. */
export const RETENTION_BATCH_SIZE = 5_000;
/** Default per-tick caps: stop once this many rows or this much wall time is spent. */
export const DEFAULT_RETENTION_BUDGET_ROWS = 50_000;
export const DEFAULT_RETENTION_BUDGET_MS = 20_000;

export const DEFAULT_IDEMPOTENCY_TTL_HOURS = 48;
/** Detail run rows live this long (once rolled up). */
export const DEFAULT_RUN_RETENTION_DAYS = 30;
/** Stored delivery verdicts live this long. */
export const DEFAULT_ROUTE_RETENTION_DAYS = 14;

/** Shared parser for the per-table TTL env vars (invalid or sub-1 → default). */
function ttlDaysFrom(env: Record<string, string | undefined>, name: string, fallback: number): number {
    const value = Number(env[name]);
    return Number.isFinite(value) && value >= 1 ? value : fallback;
}

/**
 * How long idempotency keys are kept. A key only needs to outlive a client's
 * retry window; anything older is dead weight. Invalid or sub-1 values fall
 * back to the default.
 */
export function idempotencyTtlHours(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.EMPEROR_IDEMPOTENCY_TTL_HOURS);
    return Number.isFinite(value) && value >= 1 ? value : DEFAULT_IDEMPOTENCY_TTL_HOURS;
}

/** How long `agent_runs` detail rows are kept. */
export function runRetentionDays(env: Record<string, string | undefined> = process.env): number {
    return ttlDaysFrom(env, "EMPEROR_RUN_RETENTION_DAYS", DEFAULT_RUN_RETENTION_DAYS);
}

/** How long `message_routes` verdicts are kept. */
export function routeRetentionDays(env: Record<string, string | undefined> = process.env): number {
    return ttlDaysFrom(env, "EMPEROR_ROUTE_RETENTION_DAYS", DEFAULT_ROUTE_RETENTION_DAYS);
}

/** Rows strictly older than this many days are eligible for deletion. */
export function dayCutoff(now: Date, days: number): Date {
    return new Date(now.getTime() - days * 86_400_000);
}

/** Rows strictly older than this instant are eligible for deletion. */
export function ttlCutoff(now: Date, hours: number): Date {
    return new Date(now.getTime() - hours * 3_600_000);
}

/** Minimal SQL surface the runner needs, so tests can inject a fake. */
export interface RetentionSqlClient {
    execute(query: SQL): Promise<{ rowCount?: number | null; rows?: unknown[] }>;
}

/** Deletes a bounded batch of rows older than `cutoff`; returns rows removed. */
export interface RetentionExecutor {
    deleteBatch(step: RetentionStep, cutoff: Date, limit: number): Promise<number>;
}

/**
 * A time-based delete step: deletes rows in `table` whose `timeColumn` is older
 * than `cutoff`, in bounded batches. `where` adds an extra predicate (e.g. "the
 * day is already rolled up") to the batched sub-select.
 */
export interface RetentionStep {
    /** Stable id (the table name) used in summaries and logs. */
    id: string;
    /** Human-readable label for the Ops page. */
    label: string;
    /** The table whose rows this step prunes. */
    table: string;
    /** Timestamp column used for the TTL comparison. */
    timeColumn: string;
    /** Rows strictly older than this instant are eligible for deletion. */
    cutoff: (now: Date) => Date;
    /** Optional extra predicate for the batched delete. */
    where?: SQL;
}

/**
 * A non-delete pass run once per tick (close lost runs, roll up finished days).
 * `run` returns the number of rows it touched, which counts toward the budget.
 */
export interface RetentionPrepareStep {
    id: string;
    label: string;
    kind: "prepare";
    run: (now: Date) => Promise<number>;
}

export type RegisteredRetentionStep = RetentionStep | RetentionPrepareStep;

export function isPrepareStep(step: RegisteredRetentionStep): step is RetentionPrepareStep {
    return (step as RetentionPrepareStep).kind === "prepare";
}

/**
 * The registry, run in order. Order matters: runs must be closed (`lost`) and
 * rolled up before their detail rows are deleted, so `agent_runs` pruning only
 * touches days already present in `agent_run_daily`.
 */
export const RETENTION_STEPS: readonly RegisteredRetentionStep[] = [
    {
        id: "idempotency_keys",
        label: "Idempotency keys",
        table: "idempotency_keys",
        timeColumn: "created_at",
        cutoff: (now) => ttlCutoff(now, idempotencyTtlHours()),
    },
    {
        id: "agent_runs_lost",
        label: "Close lost runs",
        kind: "prepare",
        run: (now) => closeLostRuns(now),
    },
    {
        id: "agent_run_daily_rollup",
        label: "Roll up finished runs",
        kind: "prepare",
        run: (now) => rollupFinishedRuns(now),
    },
    {
        id: "agent_runs",
        label: "Agent runs",
        table: "agent_runs",
        timeColumn: "started_at",
        cutoff: (now) => dayCutoff(now, runRetentionDays()),
        // An attributed run is only pruned once its day has been rolled up to
        // agent_run_daily. An unattributed row (a finish whose start was lost)
        // has no rollup to wait for — the rollup groups by agent_id and skips
        // nulls — so it is pruned on its TTL alone and never accumulates.
        where: sql`(
            ${agentRuns.agentId} IS NULL OR EXISTS (
                SELECT 1 FROM agent_run_daily d
                WHERE d.company_id = ${agentRuns.companyId}
                  AND d.agent_id = ${agentRuns.agentId}
                  AND d.day = date_trunc('day', ${agentRuns.startedAt})::date
            )
        )`,
    },
    {
        id: "message_routes",
        label: "Delivery verdicts",
        table: "message_routes",
        timeColumn: "decided_at",
        cutoff: (now) => dayCutoff(now, routeRetentionDays()),
    },
    {
        id: "agent_run_daily",
        label: "Run rollups",
        table: "agent_run_daily",
        timeColumn: "day",
        cutoff: (now) => dayCutoff(now, RUN_DAILY_RETENTION_DAYS),
    },
];

export interface RetentionStepResult {
    table: string;
    deleted: number;
    /** True when the step ran out of its per-tick budget before finishing. */
    exhausted: boolean;
    /** Present when the step threw; the rest of the run still proceeds. */
    error?: string;
}

export interface RetentionSummary {
    startedAt: string;
    durationMs: number;
    steps: RetentionStepResult[];
}

/** Real executor: one parameterized, id-bounded DELETE per batch. */
export function createDbExecutor(client: RetentionSqlClient): RetentionExecutor {
    return {
        async deleteBatch(step, cutoff, limit) {
            const table = sql.identifier(step.table);
            const column = sql.identifier(step.timeColumn);
            const olderThan = sql`${column} < ${cutoff}`;
            const predicate = step.where ? sql`${olderThan} AND ${step.where}` : olderThan;
            const result = await client.execute(sql`
                DELETE FROM ${table}
                WHERE id IN (
                    SELECT id FROM ${table}
                    WHERE ${predicate}
                    ORDER BY ${column}
                    LIMIT ${limit}
                )
            `);
            return result.rowCount ?? 0;
        },
    };
}

export interface RunRetentionOptions {
    now?: Date;
    budgetRows?: number;
    budgetMs?: number;
}

export interface RunRetentionDeps {
    executor: RetentionExecutor;
    /** Wall clock in ms; injectable for deterministic budget tests. */
    clock?: () => number;
    /** Persist the summary; skipped when absent. */
    saveSummary?: (summary: RetentionSummary) => Promise<void>;
    /** Override the registry (tests only). Defaults to `RETENTION_STEPS`. */
    steps?: readonly RegisteredRetentionStep[];
}

/**
 * Run every registered step in order under a shared per-tick budget. Returns
 * the run summary; individual step failures are recorded, not thrown, so one
 * bad table never blocks the others.
 */
export async function runRetention(
    options: RunRetentionOptions = {},
    deps: RunRetentionDeps,
): Promise<RetentionSummary> {
    const now = options.now ?? new Date();
    const clock = deps.clock ?? (() => Date.now());
    const budgetRows = options.budgetRows ?? DEFAULT_RETENTION_BUDGET_ROWS;
    const budgetMs = options.budgetMs ?? DEFAULT_RETENTION_BUDGET_MS;
    const steps = deps.steps ?? RETENTION_STEPS;

    const startedAtMs = clock();
    let rowsUsed = 0;
    const results: RetentionStepResult[] = [];

    for (const step of steps) {
        if (rowsUsed >= budgetRows || clock() - startedAtMs >= budgetMs) {
            // The tick is spent; defer this and every later step to the next run.
            results.push({ table: step.id, deleted: 0, exhausted: true });
            continue;
        }

        if (isPrepareStep(step)) {
            let affected = 0;
            let error: string | undefined;
            try {
                affected = await step.run(now);
                rowsUsed += affected;
            } catch (cause) {
                error = cause instanceof Error ? cause.message : String(cause);
            }
            results.push({ table: step.id, deleted: affected, exhausted: false, ...(error ? { error } : {}) });
            continue;
        }

        let deleted = 0;
        let exhausted = false;
        let error: string | undefined;
        try {
            const cutoff = step.cutoff(now);
            for (;;) {
                const rowsRemaining = budgetRows - rowsUsed;
                if (rowsRemaining <= 0 || clock() - startedAtMs >= budgetMs) {
                    exhausted = true;
                    break;
                }
                const limit = Math.min(RETENTION_BATCH_SIZE, rowsRemaining);
                const removed = await deps.executor.deleteBatch(step, cutoff, limit);
                deleted += removed;
                rowsUsed += removed;
                // A short batch means no rows older than the cutoff remain.
                if (removed < limit) break;
            }
        } catch (cause) {
            error = cause instanceof Error ? cause.message : String(cause);
        }
        results.push({ table: step.id, deleted, exhausted, ...(error ? { error } : {}) });
    }

    const summary: RetentionSummary = {
        startedAt: now.toISOString(),
        durationMs: clock() - startedAtMs,
        steps: results,
    };
    if (deps.saveSummary) await deps.saveSummary(summary);
    return summary;
}

/** Key in the instance_settings KV table holding the recent run summaries. */
export const RETENTION_SUMMARY_KEY = "retention:runs";
/** Keep this many runs for the Ops page; older entries are dropped. */
export const RETENTION_HISTORY_LIMIT = 50;

/** Read the most recent retention summaries (newest first) for the Ops page. */
export async function getRecentRetentionRuns(): Promise<RetentionSummary[]> {
    const [row] = await db
        .select({ value: instanceSettings.value })
        .from(instanceSettings)
        .where(eq(instanceSettings.key, RETENTION_SUMMARY_KEY))
        .limit(1);
    const value = row?.value;
    return Array.isArray(value) ? (value as RetentionSummary[]) : [];
}

/** Prepend a run summary, keeping the history bounded. */
export async function saveRetentionSummary(summary: RetentionSummary): Promise<void> {
    const history = await getRecentRetentionRuns();
    const value = [summary, ...history].slice(0, RETENTION_HISTORY_LIMIT);
    await db
        .insert(instanceSettings)
        .values({ key: RETENTION_SUMMARY_KEY, value, updatedAt: new Date() })
        .onConflictDoUpdate({
            target: instanceSettings.key,
            set: { value, updatedAt: new Date() },
        });
}

/** Cross-instance lock id; held for the session so only one instance prunes. */
const RETENTION_LOCK_KEY = 1937006964;

/**
 * Scheduled entry point. Takes a session-level advisory lock on a dedicated
 * connection so only one instance prunes at a time, then runs every batch in
 * autocommit: each DELETE commits on its own, so a long run never pins row
 * locks, dead tuples or WAL in one big transaction. Records the summary after.
 * Never throws — a retention failure must not break the monitor loop.
 */
export async function runScheduledRetention(now = new Date()): Promise<RetentionSummary | null> {
    let summary: RetentionSummary | null = null;
    try {
        const client = await db.$client.connect();
        let locked = false;
        try {
            const lock = await client.query<{ locked: boolean }>(
                "SELECT pg_try_advisory_lock($1, 1) AS locked", [RETENTION_LOCK_KEY],
            );
            locked = Boolean(lock.rows[0]?.locked);
            if (!locked) return null;
            summary = await runRetention(
                { now },
                { executor: createDbExecutor(drizzle(client) as unknown as RetentionSqlClient) },
            );
        } finally {
            if (locked) await client.query("SELECT pg_advisory_unlock($1, 1)", [RETENTION_LOCK_KEY]).catch(() => undefined);
            client.release();
        }
    } catch (error) {
        console.error("Retention run failed:", error);
        return null;
    }

    if (summary) {
        try {
            await saveRetentionSummary(summary);
        } catch (error) {
            console.error("Retention summary save failed:", error);
        }
    }
    return summary;
}
