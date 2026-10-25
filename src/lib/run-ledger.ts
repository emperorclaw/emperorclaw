import { z } from "zod";
import { and, eq, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agentRunDaily, agentRuns, messageRoutes, threadMessages } from "@/db/schema";
import { redactSensitive } from "@/lib/live-feed-v2";
import type { RouteReason } from "@/lib/message-routing";
import { validatedExplicitRunTask, validatedTriggerTask } from "@/lib/run-task-attribution-store";

/**
 * The run ledger (PR 2): one row per agent turn, written by the runtime that
 * ran it. Everything here is company-scoped at the call site. The validation,
 * the "interesting verdict" rule and the rollup SQL live here (not in the
 * routes) so they are unit-testable without a database.
 */

/** Reject payloads larger than this before parsing (a turn never sends more). */
export const RUN_PAYLOAD_MAX_BYTES = 8 * 1024;
/** Stored errors are redacted then truncated to this many code points. */
export const RUN_ERROR_MAX_CHARS = 500;
/** Raw error strings above this are rejected at the boundary. */
export const RUN_ERROR_RAW_MAX_CHARS = 2_000;

export const RUN_STATUSES = ["running", "succeeded", "failed", "timeout", "cancelled", "blocked", "lost"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** Statuses a runtime may report on finish (start is always `running`). */
export const FINISH_STATUSES = ["succeeded", "failed", "timeout", "cancelled", "blocked"] as const;
export type FinishStatus = (typeof FINISH_STATUSES)[number];
/** Statuses a run never leaves (except `lost` → terminal, a late finish). */
export const TERMINAL_RUN_STATUSES = ["succeeded", "failed", "timeout", "cancelled", "blocked", "lost"] as const;
export const RUNTIME_KINDS = ["hermes", "codex", "openclaw", "other"] as const;
export const TRIGGER_KINDS = ["message", "task", "objective", "other"] as const;

/** A run still `running` after this long is closed as `lost`. */
export const LOST_RUN_AFTER_MS = 2 * 60 * 60 * 1000;
/** Rows touched per lost-run / rolled-up-delete batch. */
export const RUN_LEDGER_BATCH_SIZE = 5_000;
/** `agent_run_daily` is kept far longer than the detail rows it summarizes. */
export const RUN_DAILY_RETENTION_DAYS = 400;

/** A client-reported run timestamp further past than this is replaced by now. */
export const RUN_TIMESTAMP_MAX_PAST_MS = 48 * 60 * 60 * 1000;
/** A client-reported run timestamp further ahead than this is replaced by now. */
export const RUN_TIMESTAMP_MAX_FUTURE_MS = 5 * 60 * 1000;

export function isTerminalRunStatus(status: string): boolean {
    return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * Whether a finish may change a run's status. A repeat finish of a terminal run
 * is a no-op, but `lost` is the one terminal state a late finish may overwrite
 * (the runtime came back after the closer gave up on it).
 */
export function finishAppliesTo(currentStatus: string): boolean {
    return currentStatus === "running" || currentStatus === "lost";
}

/** The instant before which a still-running run counts as lost. */
export function lostRunCutoff(now: Date, timeoutMs: number = LOST_RUN_AFTER_MS): Date {
    return new Date(now.getTime() - timeoutMs);
}

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO-8601 timestamp",
});

const boundedCount = z.number().int().min(0).max(2_000_000_000);

/** POST /api/mcp/agents/runs body. */
export const startRunSchema = z.object({
    id: z.string().uuid(),
    agentId: z.string().min(1).max(200),
    runtimeId: z.string().max(200).nullish(),
    runtimeKind: z.enum(RUNTIME_KINDS).optional(),
    bridgeVersion: z.string().max(100).nullish(),
    triggerKind: z.enum(TRIGGER_KINDS).optional(),
    triggerMessageId: z.string().uuid().nullish(),
    threadId: z.string().uuid().nullish(),
    taskId: z.string().uuid().nullish(),
    startedAt: isoDate.optional(),
});
export type StartRunInput = z.infer<typeof startRunSchema>;

/** PATCH /api/mcp/agents/runs/[id] body. */
export const finishRunSchema = z.object({
    status: z.enum(FINISH_STATUSES),
    endedAt: isoDate.optional(),
    durationMs: boundedCount.nullish(),
    inputTokens: boundedCount.nullish(),
    outputTokens: boundedCount.nullish(),
    costCents: boundedCount.nullish(),
    toolCalls: boundedCount.nullish(),
    replyMessageId: z.string().uuid().nullish(),
    error: z.string().max(RUN_ERROR_RAW_MAX_CHARS).nullish(),
    // run-usage: 2 (bridge 0.9). inputTokens = prompt incl. cached tokens.
    cacheReadTokens: boundedCount.nullish(),
    cacheWriteTokens: boundedCount.nullish(),
    reasoningTokens: boundedCount.nullish(),
    apiCalls: boundedCount.nullish(),
    model: z.string().max(100).nullish(),
    provider: z.string().max(100).nullish(),
    /** Receipt `turn_exit_reason`, e.g. `text_response(finish_reason=stop)`. */
    exitReason: z.string().max(120).nullish(),
    queueMs: boundedCount.nullish(),
    firstTokenMs: boundedCount.nullish(),
    compactions: boundedCount.nullish(),
    /** Events the runtime dropped (spool cap). Added to the server's own count. */
    eventsDropped: boundedCount.nullish(),
});
export type FinishRunInput = z.infer<typeof finishRunSchema>;

/**
 * The run-usage columns a finish may set, in the shape both the update and the
 * recovering insert use (`undefined` leaves a column untouched on update).
 */
export function finishUsageColumns(input: FinishRunInput) {
    return {
        cacheReadTokens: input.cacheReadTokens ?? undefined,
        cacheWriteTokens: input.cacheWriteTokens ?? undefined,
        reasoningTokens: input.reasoningTokens ?? undefined,
        apiCalls: input.apiCalls ?? undefined,
        model: input.model?.trim() || undefined,
        provider: input.provider?.trim() || undefined,
        exitReason: input.exitReason ? (truncateRunError(input.exitReason) ?? undefined) : undefined,
        queueMs: input.queueMs ?? undefined,
        firstTokenMs: input.firstTokenMs ?? undefined,
        compactions: input.compactions ?? undefined,
    };
}

/**
 * Insert a run start (idempotent on id) and return the stored row, or null
 * when the id belongs to another company. Shared by POST /agents/runs and the
 * events endpoint's optional `run` header, so events never depend on the start
 * POST having landed first.
 */
export async function insertRunStart(companyId: string, agentId: string, input: StartRunInput) {
    // The trigger message's own thread wins over a missing or different
    // caller-supplied threadId, so a run is never filed under (and judged
    // visible by) the wrong thread.
    let threadId = input.threadId ?? null;
    // A task id the runtime sent is stored only when it is a live task of this
    // company inside the agent's scope; otherwise it is dropped (and logged),
    // never failing the start, and rule (a) below may still attribute one.
    let taskId = await validatedExplicitRunTask(companyId, agentId, input.taskId);
    if (input.triggerMessageId) {
        const [trigger] = await db.select({
            threadId: threadMessages.threadId,
            companyId: threadMessages.companyId,
            senderType: threadMessages.senderType,
            targetAgentId: threadMessages.targetAgentId,
            metadataJson: threadMessages.metadataJson,
        }).from(threadMessages)
            .where(and(eq(threadMessages.id, input.triggerMessageId), eq(threadMessages.companyId, companyId))).limit(1);
        if (trigger) threadId = trigger.threadId;
        // Rule (a) of run-task-attribution: a run woken by a system "New task
        // assigned to you" notice names that task. Best-effort — attribution
        // never fails a start.
        if (!taskId && trigger) {
            try {
                taskId = await validatedTriggerTask(companyId, agentId, trigger);
            } catch (err) {
                console.warn("run start task attribution failed:", err);
            }
        }
    }
    await db
        .insert(agentRuns)
        .values({
            id: input.id,
            companyId,
            agentId,
            runtimeId: input.runtimeId ?? null,
            runtimeKind: input.runtimeKind ?? "other",
            bridgeVersion: input.bridgeVersion ?? null,
            triggerKind: input.triggerKind ?? "other",
            triggerMessageId: input.triggerMessageId ?? null,
            threadId,
            taskId,
            status: "running",
            // Clamped to [now − 48h, now + 5min]; an out-of-range start falls back to now.
            startedAt: clampRunTimestamp(input.startedAt),
        })
        .onConflictDoNothing({ target: agentRuns.id });

    const [run] = await db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.id, input.id), eq(agentRuns.companyId, companyId)));
    return run ?? null;
}

/** True when the raw body exceeds the size cap (UTF-8 bytes). */
export function payloadTooLarge(raw: string, max: number = RUN_PAYLOAD_MAX_BYTES): boolean {
    return new TextEncoder().encode(raw).length > max;
}

/** Redact secrets, collapse whitespace, then truncate to the storage cap. */
export function truncateRunError(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    const redacted = redactSensitive(raw).replace(/\s+/g, " ").trim();
    if (!redacted) return null;
    const chars = Array.from(redacted);
    if (chars.length <= RUN_ERROR_MAX_CHARS) return redacted;
    return `${chars.slice(0, RUN_ERROR_MAX_CHARS - 3).join("").trimEnd()}...`;
}

/** Duration in ms: the reported value, or endedAt − startedAt when absent. */
export function computeRunDurationMs(startedAt: Date, endedAt: Date, provided?: number | null): number {
    if (provided != null) return Math.max(0, Math.round(provided));
    return Math.max(0, endedAt.getTime() - startedAt.getTime());
}

/**
 * Clamp a client-reported run timestamp into `[now − 48h, now + 5min]`.
 *
 * Runtimes have no trustworthy clock: a wild `startedAt` would otherwise place
 * a run in the wrong rollup day (and the retention job keys off that day
 * forever), and a far-future `endedAt` would distort durations. An unparseable
 * value, an out-of-range value or an absent one all fall back to server "now".
 */
export function clampRunTimestamp(value: string | null | undefined, now: Date = new Date()): Date {
    if (!value) return now;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return now;
    const min = now.getTime() - RUN_TIMESTAMP_MAX_PAST_MS;
    const max = now.getTime() + RUN_TIMESTAMP_MAX_FUTURE_MS;
    if (ms < min || ms > max) return now;
    return new Date(ms);
}

// ─── Interesting delivery verdicts ──────────────────────────────────────────

/**
 * A verdict is stored when it matters for "why didn't agent X reply?": it was
 * addressed, OR it was mentioned/targeted/paired but not addressed — i.e. it
 * lost to the loop guard (`loop_paused`) or to another target (`targeted_other`).
 * `self` and plain `not_addressed` are noise and never stored.
 */
export const INTERESTING_UNADDRESSED_REASONS: readonly RouteReason[] = ["loop_paused", "targeted_other"];

export function isInterestingVerdict(decision: { addressedToYou: boolean; routeReason: RouteReason }): boolean {
    return decision.addressedToYou || INTERESTING_UNADDRESSED_REASONS.includes(decision.routeReason);
}

/** One agent/message decision, as computed by the sync route. */
export interface VerdictRecord {
    messageId: string;
    agentId: string;
    addressed: boolean;
    routeReason: RouteReason;
    agentStreak: number;
    maxTurns: number;
}

export interface MessageRouteRow {
    companyId: string;
    messageId: string;
    agentId: string;
    addressed: boolean;
    routeReason: string;
    agentStreak: number;
    maxTurns: number;
    decidedAt: Date;
}

/** Filter a batch of decisions down to the rows the ledger should keep. */
export function interestingVerdicts(
    companyId: string,
    records: VerdictRecord[],
    decidedAt: Date = new Date(),
): MessageRouteRow[] {
    const rows: MessageRouteRow[] = [];
    for (const record of records) {
        if (!record.addressed && !INTERESTING_UNADDRESSED_REASONS.includes(record.routeReason)) continue;
        rows.push({
            companyId,
            messageId: record.messageId,
            agentId: record.agentId,
            addressed: record.addressed,
            routeReason: record.routeReason,
            agentStreak: record.agentStreak,
            maxTurns: record.maxTurns,
            decidedAt,
        });
    }
    return rows;
}

/**
 * Persist the interesting verdicts from one sync batch in a single upsert
 * keyed on (message_id, agent_id) so a re-decision overwrites the latest one.
 * The `setWhere` clause makes the update a no-op when the verdict is unchanged
 * (same reason/addressed/streak), so a busy sync loop only rewrites a row when
 * the decision actually moved — and `decided_at` keeps the instant of the first
 * decision. Best-effort by contract: the caller wraps this in try/catch.
 */
export async function recordInterestingVerdicts(
    companyId: string,
    records: VerdictRecord[],
    decidedAt: Date = new Date(),
): Promise<number> {
    const rows = interestingVerdicts(companyId, records, decidedAt);
    if (rows.length === 0) return 0;
    await db
        .insert(messageRoutes)
        .values(rows)
        .onConflictDoUpdate({
            target: [messageRoutes.messageId, messageRoutes.agentId],
            set: {
                companyId: sql`excluded.company_id`,
                addressed: sql`excluded.addressed`,
                routeReason: sql`excluded.route_reason`,
                agentStreak: sql`excluded.agent_streak`,
                maxTurns: sql`excluded.max_turns`,
                decidedAt: sql`excluded.decided_at`,
            },
            setWhere: sql`${messageRoutes.routeReason} is distinct from excluded.route_reason
                or ${messageRoutes.addressed} is distinct from excluded.addressed
                or ${messageRoutes.agentStreak} is distinct from excluded.agent_streak`,
        });
    return rows.length;
}

// ─── Rollup ─────────────────────────────────────────────────────────────────

export interface RollupRow {
    companyId: string;
    agentId: string;
    day: string;
    runs: number;
    succeeded: number;
    failed: number;
    timeout: number;
    lost: number;
    p50Ms: number | null;
    p95Ms: number | null;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    toolCalls: number;
}

/**
 * The per-(company, agent, day) aggregate for one complete UTC day. Grouped by
 * select position (1, 2, 3) so the GROUP BY matches the selected expressions
 * exactly — grouping by a *different* day expression is the 42803 trap.
 */
export function dailyRollupQuery(day: string) {
    return db
        .select({
            companyId: agentRuns.companyId,
            agentId: agentRuns.agentId,
            day: sql<string>`date_trunc('day', ${agentRuns.startedAt})::date`,
            runs: sql<number>`count(*)::int`,
            succeeded: sql<number>`(count(*) filter (where ${agentRuns.status} = 'succeeded'))::int`,
            failed: sql<number>`(count(*) filter (where ${agentRuns.status} = 'failed'))::int`,
            timeout: sql<number>`(count(*) filter (where ${agentRuns.status} = 'timeout'))::int`,
            lost: sql<number>`(count(*) filter (where ${agentRuns.status} = 'lost'))::int`,
            p50Ms: sql<number | null>`(percentile_cont(0.5) within group (order by ${agentRuns.durationMs}) filter (where ${agentRuns.durationMs} is not null))::int`,
            p95Ms: sql<number | null>`(percentile_cont(0.95) within group (order by ${agentRuns.durationMs}) filter (where ${agentRuns.durationMs} is not null))::int`,
            inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::int`,
            outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::int`,
            costCents: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)::int`,
            toolCalls: sql<number>`coalesce(sum(${agentRuns.toolCalls}), 0)::int`,
        })
        .from(agentRuns)
        .where(and(
            sql`${agentRuns.agentId} is not null`,
            sql`${agentRuns.status} <> 'running'`,
            sql`date_trunc('day', ${agentRuns.startedAt})::date = ${day}::date`,
        ))
        .groupBy(sql`1`, sql`2`, sql`3`);
}

/**
 * Every complete UTC day with finished runs that has NOT been rolled up yet
 * (oldest first). A day is rolled up exactly once: once an `agent_run_daily`
 * row exists it is never recomputed, so batched/budgeted deletion that stops
 * mid-day can never make the next tick re-roll the day from the surviving rows
 * and shrink the stored totals. The lost-run closer runs before this in the
 * same tick, so most runs of a past day are terminal when it is rolled up.
 * Accepted drift: a run still `running` at that moment (the closer waits 2 h)
 * or one finishing after its day was rolled is not counted in that day's total.
 */
export function rollupDaysQuery(now: Date) {
    const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return db
        .selectDistinct({ day: sql<string>`date_trunc('day', ${agentRuns.startedAt})::date` })
        .from(agentRuns)
        .where(and(
            sql`${agentRuns.agentId} is not null`,
            sql`${agentRuns.status} <> 'running'`,
            lt(agentRuns.startedAt, todayStart),
            sql`not exists (
                select 1 from ${agentRunDaily} d
                where d.company_id = ${agentRuns.companyId}
                  and d.agent_id = ${agentRuns.agentId}
                  and d.day = date_trunc('day', ${agentRuns.startedAt})::date
            )`,
        ))
        .orderBy(sql`date_trunc('day', ${agentRuns.startedAt})::date`);
}

/** Insert rolled-up rows once, keyed on (company, agent, day); existing rows are kept. */
export async function upsertDailyRollups(rows: RollupRow[]): Promise<number> {
    const clean = rows.filter((row) => row.agentId);
    if (clean.length === 0) return 0;
    await db
        .insert(agentRunDaily)
        .values(clean)
        // A rolled-up day is final: never rewrite an existing row (see rollupDaysQuery).
        .onConflictDoNothing({ target: [agentRunDaily.companyId, agentRunDaily.agentId, agentRunDaily.day] });
    return clean.length;
}

// ─── Retention statements ───────────────────────────────────────────────────

/** Close a bounded batch of runs that have been `running` for too long. */
export function closeLostRunsSql(now: Date, batch: number = RUN_LEDGER_BATCH_SIZE): SQL {
    const cutoff = lostRunCutoff(now);
    return sql`
        UPDATE agent_runs SET status = 'lost', ended_at = ${now}
        WHERE status = 'running' AND id IN (
            SELECT id FROM agent_runs
            WHERE status = 'running' AND started_at < ${cutoff}
            ORDER BY started_at
            LIMIT ${batch}
        )`;
}

// ─── Retention passes (called by the registry's prepare steps) ──────────────

/** Close a bounded batch of runs that have been `running` for too long. */
export async function closeLostRuns(now: Date, batch: number = RUN_LEDGER_BATCH_SIZE): Promise<number> {
    const result = await db.execute(closeLostRunsSql(now, batch));
    return Number(result.rowCount ?? 0);
}

/**
 * Roll every complete UTC day that has finished runs into `agent_run_daily`.
 * Each (company, agent, day) is rolled up exactly once — `rollupDaysQuery`
 * skips days that already have a rollup row — so a partially deleted day is
 * never recomputed from its surviving rows.
 */
export async function rollupFinishedRuns(now: Date): Promise<number> {
    const days = await rollupDaysQuery(now);
    let upserted = 0;
    for (const { day } of days) {
        const rows = (await dailyRollupQuery(day)) as RollupRow[];
        if (rows.length > 0) upserted += await upsertDailyRollups(rows);
    }
    return upserted;
}
