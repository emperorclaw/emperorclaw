/**
 * Agent cost brake: data loading, shadow recording and the chatter report.
 * The rules live in cost-brake.ts (pure).
 *
 * Shadow decisions are stored as `ops_events` rows (category `cost_brake`,
 * one per scope episode) and logged as a `[cost-brake] shadow …` console line,
 * so the 7-day shadow review needs no logs and no migration.
 */
import { and, desc, eq, gte, inArray, isNotNull, lt, notInArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, agents, artifacts, opsEvents, taskEvents, threadMessages, messageThreads } from "@/db/schema";
import {
    COST_BRAKE_WINDOW_MS,
    costBrakeLimits,
    costBrakeMode,
    evaluatePairEpisode,
    evaluateTaskScope,
    pairOf,
    runInPairKey,
    shadowLogLine,
    wouldBrakeDedupeKey,
    type A2aRun,
    type CostBrakeLimits,
    type CostBrakeMode,
    type ScopeEvaluation,
} from "@/lib/cost-brake";
import { isLoopGuardResume } from "@/lib/message-routing";

export const COST_BRAKE_OPS_CATEGORY = "cost_brake";

/** Task events that are never progress (the loop guard's list, notes included). */
const NON_PROGRESS_EVENT_TYPES = ["stall_nudge", "stall_escalation", "task_note", "task_handoff"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type FinishedRun = typeof agentRuns.$inferSelect;

const runTokens = sql<number>`(coalesce(${agentRuns.inputTokens}, 0) + coalesce(${agentRuns.outputTokens}, 0))::float8`;

/** a2a runs (trigger message from another agent) matching `where`, since `since`, oldest first. */
async function loadA2aRuns(companyId: string, since: Date, where: SQL | undefined) {
    const rows = await db.select({
        id: agentRuns.id,
        agentId: agentRuns.agentId,
        wakerId: threadMessages.senderId,
        threadId: threadMessages.threadId,
        taskId: agentRuns.taskId,
        tokens: runTokens,
        startedAt: agentRuns.startedAt,
        endedAt: agentRuns.endedAt,
    })
        .from(agentRuns)
        .innerJoin(threadMessages, and(eq(threadMessages.id, agentRuns.triggerMessageId), eq(threadMessages.companyId, agentRuns.companyId)))
        .where(and(
            eq(agentRuns.companyId, companyId),
            gte(agentRuns.startedAt, since),
            isNotNull(agentRuns.agentId),
            eq(threadMessages.senderType, "agent"),
            sql`${threadMessages.senderId} <> ${agentRuns.agentId}::text`,
            where,
        ))
        .orderBy(agentRuns.startedAt)
        .limit(2_000);
    return rows.filter((r): r is typeof r & { agentId: string; wakerId: string } => Boolean(r.agentId && r.wakerId));
}

/** Mark each run that produced core progress (non-note task event or artifact) by its agent. */
async function withProgress(companyId: string, rows: Awaited<ReturnType<typeof loadA2aRuns>>, now: Date): Promise<A2aRun[]> {
    if (rows.length === 0) return [];
    const actors = [...new Set(rows.map((r) => r.agentId))];
    const since = new Date(Math.min(...rows.map((r) => r.startedAt.getTime())));
    const [events, files] = await Promise.all([
        db.select({ actorId: taskEvents.actorId, at: taskEvents.createdAt }).from(taskEvents).where(and(
            eq(taskEvents.companyId, companyId),
            gte(taskEvents.createdAt, since),
            inArray(taskEvents.actorId, actors),
            notInArray(taskEvents.eventType, NON_PROGRESS_EVENT_TYPES),
        )),
        db.select({ actorId: artifacts.createdById, at: artifacts.createdAt }).from(artifacts).where(and(
            eq(artifacts.companyId, companyId),
            gte(artifacts.createdAt, since),
            eq(artifacts.createdByType, "agent"),
            inArray(artifacts.createdById, actors),
        )),
    ]);
    const byActor = new Map<string, number[]>();
    for (const e of [...events, ...files]) {
        if (!e.actorId) continue;
        const list = byActor.get(e.actorId) ?? [];
        list.push(e.at.getTime());
        byActor.set(e.actorId, list);
    }
    return rows.map((r) => {
        const start = r.startedAt.getTime();
        const end = (r.endedAt ?? now).getTime();
        return {
            id: r.id,
            agentId: r.agentId,
            wakerId: r.wakerId,
            threadId: r.threadId,
            taskId: r.taskId,
            tokens: Number(r.tokens) || 0,
            startedAt: start,
            endedAt: r.endedAt ? r.endedAt.getTime() : null,
            progressed: (byActor.get(r.agentId) ?? []).some((at) => at >= start && at <= end),
        };
    });
}

/**
 * Human messages and Resume markers in the given threads since `since`. A
 * Resume only counts on a system message: the key is reserved, and an agent
 * post carrying it is never honored.
 */
async function threadResets(companyId: string, threadIds: string[], since: Date): Promise<number[]> {
    if (threadIds.length === 0) return [];
    const rows = await db.select({ senderType: threadMessages.senderType, metadataJson: threadMessages.metadataJson, at: threadMessages.createdAt })
        .from(threadMessages)
        .where(and(
            eq(threadMessages.companyId, companyId),
            inArray(threadMessages.threadId, threadIds),
            gte(threadMessages.createdAt, since),
            or(
                eq(threadMessages.senderType, "human"),
                and(eq(threadMessages.senderType, "system"), sql`(${threadMessages.metadataJson}->>'loopGuardResume' = 'true' or (${threadMessages.metadataJson}->'costBrakeResume') is not null)`),
            ),
        ));
    return rows
        .filter((r) => r.senderType === "human" || isLoopGuardResume(r.metadataJson, r.senderType) || isCostBrakeResume(r.metadataJson, r.senderType))
        .map((r) => r.at.getTime());
}

/** A cost-brake Resume marker (reserved key; system messages only). */
export function isCostBrakeResume(metadata: unknown, senderType: string | null | undefined): boolean {
    if ((senderType || "").toLowerCase() !== "system") return false;
    if (!metadata || typeof metadata !== "object") return false;
    const value = (metadata as Record<string, unknown>).costBrakeResume;
    return value !== undefined && value !== null && value !== false;
}

/** A task's human touches and state changes since `since`, plus its state before it. */
async function taskHistory(companyId: string, taskId: string, since: Date) {
    const stateExpr = sql<string | null>`${taskEvents.payloadJson}->>'state'`;
    const [rows, [before]] = await Promise.all([
        db.select({ actorType: taskEvents.actorType, eventType: taskEvents.eventType, state: stateExpr, at: taskEvents.createdAt })
            .from(taskEvents)
            .where(and(eq(taskEvents.companyId, companyId), eq(taskEvents.taskId, taskId), gte(taskEvents.createdAt, since))),
        db.select({ state: stateExpr })
            .from(taskEvents)
            .where(and(
                eq(taskEvents.companyId, companyId), eq(taskEvents.taskId, taskId), lt(taskEvents.createdAt, since),
                sql`${taskEvents.payloadJson}->>'state' is not null`,
            ))
            .orderBy(desc(taskEvents.createdAt))
            .limit(1),
    ]);
    const humanTouches = rows.filter((r) => r.actorType === "human").map((r) => r.at.getTime());
    const stateChanges = rows
        .filter((r) => r.state && !NON_PROGRESS_EVENT_TYPES.includes(r.eventType))
        .map((r) => ({ at: r.at.getTime(), state: r.state as string }));
    return { humanTouches, stateChanges, initialState: before?.state ?? null };
}

/**
 * Evaluate the cost brake for a run that just finished (shadow mode). A run
 * that was not woken by another agent is not a2a and is skipped. Returns the
 * evaluations (pair, and task when the run has one); never throws.
 */
export async function evaluateCostBrakeAfterRun(
    run: FinishedRun,
    options: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<ScopeEvaluation[] | null> {
    const env = options.env ?? process.env;
    const mode: CostBrakeMode = costBrakeMode(env);
    if (mode === "off" || !run.agentId || !run.triggerMessageId) return null;
    try {
        const [trigger] = await db.select({ senderType: threadMessages.senderType, senderId: threadMessages.senderId, threadId: threadMessages.threadId })
            .from(threadMessages)
            .where(and(eq(threadMessages.id, run.triggerMessageId), eq(threadMessages.companyId, run.companyId)))
            .limit(1);
        if (!trigger || trigger.senderType !== "agent" || !trigger.senderId || trigger.senderId === run.agentId || !UUID_RE.test(trigger.senderId)) {
            return null;
        }
        const now = options.now ?? new Date();
        const windowStart = new Date(now.getTime() - COST_BRAKE_WINDOW_MS);
        const limits = costBrakeLimits(env);
        const [agentA, agentB] = pairOf(run.agentId, trigger.senderId);
        const taskId = run.taskId ?? null;

        const pairRows = await loadA2aRuns(run.companyId, windowStart, or(
            and(eq(agentRuns.agentId, agentA), eq(threadMessages.senderId, agentB)),
            and(eq(agentRuns.agentId, agentB), eq(threadMessages.senderId, agentA)),
        ));
        const pairRuns = await withProgress(run.companyId, pairRows.filter((r) => runInPairKey(r, agentA, agentB, taskId)), now);

        // Renewal sources: the threads the episode ran in (and the trigger's).
        const pairThreads = [...new Set([trigger.threadId, ...pairRuns.map((r) => r.threadId)].filter((id): id is string => Boolean(id)))];
        const history = taskId ? await taskHistory(run.companyId, taskId, windowStart) : null;
        const pairResets = [...await threadResets(run.companyId, pairThreads, windowStart), ...(history?.humanTouches ?? [])];

        const evaluations: ScopeEvaluation[] = [evaluatePairEpisode({
            agentA, agentB, taskId, runs: pairRuns,
            renewal: { resets: pairResets, stateChanges: history?.stateChanges, initialState: history?.initialState },
            limits, windowStart: windowStart.getTime(),
        })];

        if (taskId && history) {
            const taskRows = await loadA2aRuns(run.companyId, windowStart, eq(agentRuns.taskId, taskId));
            const taskRuns = await withProgress(run.companyId, taskRows, now);
            const [taskThread] = await db.select({ id: messageThreads.id }).from(messageThreads)
                .where(and(eq(messageThreads.companyId, run.companyId), eq(messageThreads.taskId, taskId))).limit(1);
            const taskThreads = [...new Set([trigger.threadId, taskThread?.id, ...taskRuns.map((r) => r.threadId)].filter((id): id is string => Boolean(id)))];
            const taskResets = [...await threadResets(run.companyId, taskThreads, windowStart), ...history.humanTouches];
            evaluations.push(evaluateTaskScope({ taskId, agentA, agentB, runs: taskRuns, resets: taskResets, limits, windowStart: windowStart.getTime() }));
        }

        for (const evaluation of evaluations) {
            if (evaluation.level !== "hard") continue;
            await recordShadowWouldBrake(run.companyId, evaluation, { runId: run.id, threadId: trigger.threadId, limits });
        }
        return evaluations;
    } catch (error) {
        console.warn("[cost-brake] evaluation failed:", error instanceof Error ? error.message : error);
        return null;
    }
}

const pendingEvaluations = new Set<Promise<unknown>>();

/**
 * Evaluate the cost brake for a finished run in the background, so the run
 * finish never waits on it (the server is a long-lived Node process). Never
 * throws or rejects.
 */
export function scheduleCostBrakeEvaluation(run: FinishedRun): void {
    const pending = evaluateCostBrakeAfterRun(run).catch((error: unknown) => {
        console.warn("[cost-brake] background evaluation failed:", error instanceof Error ? error.message : error);
        return null;
    });
    pendingEvaluations.add(pending);
    void pending.finally(() => pendingEvaluations.delete(pending));
}

/** Wait for the background evaluations started so far (tests). */
export async function waitForCostBrakeEvaluations(): Promise<void> {
    while (pendingEvaluations.size > 0) await Promise.all([...pendingEvaluations]);
}

/**
 * Record one would-brake decision per scope episode (advisory lock + "already
 * recorded" check, like the loop-guard notice). Returns true when a new row
 * was written.
 */
async function recordShadowWouldBrake(
    companyId: string,
    evaluation: ScopeEvaluation,
    context: { runId: string; threadId: string | null; limits: CostBrakeLimits },
): Promise<boolean> {
    const dedupeKey = wouldBrakeDedupeKey(evaluation);
    const written = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`cost-brake:${companyId}:${dedupeKey}`}))`);
        const [existing] = await tx.select({ id: opsEvents.id }).from(opsEvents).where(and(
            eq(opsEvents.category, COST_BRAKE_OPS_CATEGORY),
            eq(opsEvents.companyId, companyId),
            sql`${opsEvents.metadataJson}->>'dedupeKey' = ${dedupeKey}`,
        )).limit(1);
        if (existing) return false;
        await tx.insert(opsEvents).values({
            level: "info",
            category: COST_BRAKE_OPS_CATEGORY,
            source: "cost-brake",
            message: `Shadow: would brake ${evaluation.scope} (${evaluation.reasons.join(", ")})`,
            companyId,
            metadataJson: {
                mode: "shadow",
                decision: "would_brake",
                dedupeKey,
                scope: evaluation.scope,
                key: evaluation.key,
                agentA: evaluation.agentA,
                agentB: evaluation.agentB,
                taskId: evaluation.taskId,
                threadId: context.threadId,
                runId: context.runId,
                reasons: evaluation.reasons,
                usedTokens: evaluation.usedTokens,
                limitTokens: evaluation.limitTokens,
                stallTurns: evaluation.stallTurns,
                stallLimit: evaluation.stallLimit,
                runs: evaluation.runs,
                softPct: context.limits.softPct,
                episodeStart: new Date(evaluation.episodeStart).toISOString(),
            },
        });
        return true;
    });
    if (written) console.info(shadowLogLine(evaluation, { companyId, runId: context.runId, threadId: context.threadId }));
    return written;
}

export interface AgentChatterRow {
    agentA: { id: string; name: string | null };
    agentB: { id: string; name: string | null };
    runs: number;
    tokens: number;
    costCents: number;
    noProgressTokens: number;
    wouldBrakeCount: number;
}

export interface AgentChatterReport {
    mode: CostBrakeMode;
    limits: CostBrakeLimits;
    days: number;
    since: string;
    pairs: AgentChatterRow[];
}

/**
 * Per-pair a2a chatter over the last `days` days (design §2 query): runs,
 * tokens, reported cents, tokens of runs that moved nothing, and the number
 * of shadow would-brake decisions involving the pair.
 */
export async function loadAgentChatter(companyId: string, options: { days?: number; now?: Date; env?: Record<string, string | undefined> } = {}): Promise<AgentChatterReport> {
    const days = Math.min(Math.max(Math.trunc(options.days ?? 14), 1), 90);
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const env = options.env ?? process.env;

    const runAgent = sql`${agentRuns.agentId}::text`;
    const lo = sql<string>`least(${runAgent}, ${threadMessages.senderId})`;
    const hi = sql<string>`greatest(${runAgent}, ${threadMessages.senderId})`;
    const runEnd = sql`coalesce(${agentRuns.endedAt}, ${agentRuns.startedAt} + interval '1 hour')`;
    const moved = sql`(exists (
        select 1 from task_events e
        where e.company_id = ${agentRuns.companyId} and e.actor_id = ${agentRuns.agentId}
          and e.created_at between ${agentRuns.startedAt} and ${runEnd}
          and e.event_type not in ('stall_nudge', 'stall_escalation', 'task_note', 'task_handoff')
    ) or exists (
        select 1 from artifacts f
        where f.company_id = ${agentRuns.companyId} and f.created_by_type = 'agent' and f.created_by_id = ${agentRuns.agentId}
          and f.created_at between ${agentRuns.startedAt} and ${runEnd}
    ))`;

    const rows = await db.select({
        agentA: lo,
        agentB: hi,
        runs: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${runTokens}), 0)::float8`,
        costCents: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)::float8`,
        noProgressTokens: sql<number>`coalesce(sum(${runTokens}) filter (where not ${moved}), 0)::float8`,
    })
        .from(agentRuns)
        .innerJoin(threadMessages, and(eq(threadMessages.id, agentRuns.triggerMessageId), eq(threadMessages.companyId, agentRuns.companyId)))
        .where(and(
            eq(agentRuns.companyId, companyId),
            gte(agentRuns.startedAt, since),
            isNotNull(agentRuns.agentId),
            eq(threadMessages.senderType, "agent"),
            sql`${threadMessages.senderId} <> ${agentRuns.agentId}::text`,
        ))
        .groupBy(lo, hi)
        .orderBy(sql`4 desc`)
        .limit(200);

    const brakes = await db.select({
        agentA: sql<string>`${opsEvents.metadataJson}->>'agentA'`,
        agentB: sql<string>`${opsEvents.metadataJson}->>'agentB'`,
        count: sql<number>`count(*)::int`,
    })
        .from(opsEvents)
        .where(and(eq(opsEvents.category, COST_BRAKE_OPS_CATEGORY), eq(opsEvents.companyId, companyId), gte(opsEvents.createdAt, since)))
        .groupBy(sql`1`, sql`2`);
    const brakeCount = new Map(brakes.map((b) => [`${b.agentA}:${b.agentB}`, Number(b.count) || 0]));

    const ids = [...new Set(rows.flatMap((r) => [r.agentA, r.agentB]).filter((id) => UUID_RE.test(id)))];
    const names = ids.length > 0
        ? new Map((await db.select({ id: agents.id, name: agents.name }).from(agents)
            .where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)))).map((a) => [a.id, a.name]))
        : new Map<string, string>();

    return {
        mode: costBrakeMode(env),
        limits: costBrakeLimits(env),
        days,
        since: since.toISOString(),
        pairs: rows.map((r) => ({
            agentA: { id: r.agentA, name: names.get(r.agentA) ?? null },
            agentB: { id: r.agentB, name: names.get(r.agentB) ?? null },
            runs: Number(r.runs) || 0,
            tokens: Number(r.tokens) || 0,
            costCents: Number(r.costCents) || 0,
            noProgressTokens: Number(r.noProgressTokens) || 0,
            wouldBrakeCount: brakeCount.get(`${r.agentA}:${r.agentB}`) ?? 0,
        })),
    };
}
