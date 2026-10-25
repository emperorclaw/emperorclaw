import { and, asc, eq, gt, gte, isNotNull, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, projects, taskEvents, tasks, threadMessages } from "@/db/schema";
import { mcpAccessForAgent, mcpMayUseTask, mcpProjectCondition, type McpAgentAccess } from "@/lib/mcp-access";
import {
    needsActivityAttribution,
    pickActivityTask,
    triggerTaskCandidate,
    type RunTaskRule,
    type TriggerMessageInput,
} from "@/lib/run-task-attribution";

/**
 * Database side of run → task attribution (rules in run-task-attribution.ts).
 * Every read is company-scoped, every candidate is validated as a live task of
 * the run's company inside the run agent's data scope, and every write is
 * guarded by `task_id IS NULL`, so an attribution never crosses companies,
 * never reaches outside the agent's scope and never changes a task already set.
 */

/** True when `taskId` is a live task (and live project) of `companyId`. */
export async function liveTaskInCompany(companyId: string, taskId: string): Promise<boolean> {
    const [row] = await db.select({ id: tasks.id })
        .from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(
            eq(tasks.id, taskId),
            eq(tasks.companyId, companyId),
            eq(projects.companyId, companyId),
            isNull(tasks.deletedAt),
            isNull(projects.deletedAt),
        ))
        .limit(1);
    return Boolean(row);
}

/**
 * The run agent's data scope, or null when it cannot be resolved (an unknown
 * or deleted agent): callers then attribute nothing (fail closed).
 */
async function agentAccess(companyId: string, agentId: string): Promise<McpAgentAccess | null> {
    try {
        return await mcpAccessForAgent(companyId, agentId);
    } catch {
        return null;
    }
}

/**
 * True when `taskId` may be filed under a run of `agentId`: a live task of the
 * company whose project is inside the agent's scope (agents.scope_json
 * customers/projects — the check every /api/mcp task route makes before an
 * agent may touch a task).
 */
export async function taskAttributableToAgent(companyId: string, agentId: string | null, taskId: string): Promise<boolean> {
    if (!agentId) return false;
    if (!(await liveTaskInCompany(companyId, taskId))) return false;
    const access = await agentAccess(companyId, agentId);
    return access !== null && (await mcpMayUseTask(companyId, access, taskId));
}

/**
 * A task id the runtime sent itself (run start body / events run header):
 * kept only when it passes the same check as an attributed one. An invalid id
 * is dropped (null, logged) rather than failing the start.
 */
export async function validatedExplicitRunTask(companyId: string, agentId: string, taskId: string | null | undefined): Promise<string | null> {
    if (!taskId) return null;
    let ok = false;
    try {
        ok = await taskAttributableToAgent(companyId, agentId, taskId);
    } catch (err) {
        console.warn("run start task validation failed:", err);
    }
    if (!ok) console.warn(`run start: dropped task ${taskId} for agent ${agentId} (not a live task in the agent's scope)`);
    return ok ? taskId : null;
}

/** Rule (a) from an already loaded trigger message (insertRunStart reads it anyway). */
export async function validatedTriggerTask(
    companyId: string,
    agentId: string | null,
    message: TriggerMessageInput | null | undefined,
): Promise<string | null> {
    const candidate = triggerTaskCandidate(message, { companyId, agentId });
    if (!candidate) return null;
    return (await taskAttributableToAgent(companyId, agentId, candidate)) ? candidate : null;
}

/** Rule (a): load the trigger message (same company only) and validate its task. */
export async function taskFromTriggerMessage(companyId: string, agentId: string | null, triggerMessageId: string | null): Promise<string | null> {
    if (!triggerMessageId) return null;
    const [message] = await db.select({
        companyId: threadMessages.companyId,
        senderType: threadMessages.senderType,
        targetAgentId: threadMessages.targetAgentId,
        metadataJson: threadMessages.metadataJson,
    }).from(threadMessages)
        .where(and(eq(threadMessages.id, triggerMessageId), eq(threadMessages.companyId, companyId)))
        .limit(1);
    return validatedTriggerTask(companyId, agentId, message);
}

/**
 * Rule (c): the live task of this company, inside the agent's scope, the agent
 * acted on most during [startedAt, endedAt]. The live-task and scope checks
 * are part of the query, so the winner is always attributable.
 */
export async function taskFromAgentActivity(companyId: string, agentId: string, startedAt: Date, endedAt: Date): Promise<string | null> {
    if (endedAt.getTime() < startedAt.getTime()) return null;
    const access = await agentAccess(companyId, agentId);
    if (!access) return null;
    const groups = await db.select({
        taskId: taskEvents.taskId,
        events: sql<number>`count(*)::int`,
        lastAt: sql<Date>`max(${taskEvents.createdAt})`,
    }).from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(
            eq(taskEvents.companyId, companyId),
            eq(taskEvents.actorType, "agent"),
            eq(taskEvents.actorId, agentId),
            gte(taskEvents.createdAt, startedAt),
            lte(taskEvents.createdAt, endedAt),
            eq(tasks.companyId, companyId),
            eq(projects.companyId, companyId),
            isNull(tasks.deletedAt),
            isNull(projects.deletedAt),
            mcpProjectCondition(access, tasks.projectId),
        ))
        .groupBy(taskEvents.taskId);
    return pickActivityTask(groups.map((g) => ({ taskId: g.taskId, events: Number(g.events), lastAtMs: new Date(g.lastAt).getTime() })));
}

/**
 * True when the run's agent has another run (same company) whose window
 * overlaps this run's stored window; rule (c) is then skipped (see
 * run-task-attribution.ts; SQL twin of `runWindowsOverlap`). Compared against
 * the stored row rather than JS dates, so the microseconds a JS Date drops
 * never turn back-to-back runs into an overlap. A still-running run is
 * open-ended; a `lost` run does not count (its ended_at is the closer's time).
 */
export async function hasOverlappingRun(companyId: string, runId: string): Promise<boolean> {
    const result = await db.execute(sql`
        SELECT 1 FROM agent_runs r
            JOIN agent_runs o ON o.company_id = r.company_id AND o.agent_id = r.agent_id AND o.id <> r.id
        WHERE r.id = ${runId}::uuid
          AND r.company_id = ${companyId}::uuid
          AND o.status <> 'lost'
          AND o.started_at < COALESCE(r.ended_at, 'infinity'::timestamp)
          AND COALESCE(o.ended_at, 'infinity'::timestamp) > r.started_at
        LIMIT 1`);
    return result.rows.length > 0;
}

export interface AttributableRun {
    id: string;
    companyId: string;
    agentId: string | null;
    taskId: string | null;
    triggerMessageId: string | null;
    startedAt: Date;
    endedAt: Date | null;
}

export interface RunTaskResolution {
    taskId: string;
    rule: RunTaskRule;
}

/**
 * Resolve a run's task with the given rules, in order: (a) the trigger
 * message, then (c) the agent's own task activity in the run window (skipped
 * when another run of the same agent overlaps it). Null when the run already
 * has a task or no rule applies.
 */
export async function resolveRunTask(
    run: AttributableRun,
    rules: readonly RunTaskRule[] = ["trigger_metadata", "task_events"],
): Promise<RunTaskResolution | null> {
    if (run.taskId || !run.agentId) return null;
    if (rules.includes("trigger_metadata") && run.triggerMessageId) {
        const taskId = await taskFromTriggerMessage(run.companyId, run.agentId, run.triggerMessageId);
        if (taskId) return { taskId, rule: "trigger_metadata" };
    }
    if (rules.includes("task_events") && run.endedAt && !(await hasOverlappingRun(run.companyId, run.id))) {
        const taskId = await taskFromAgentActivity(run.companyId, run.agentId, run.startedAt, run.endedAt);
        if (taskId) return { taskId, rule: "task_events" };
    }
    return null;
}

/** Write an attribution; a no-op (false) when the run already has a task or is another company's. */
export async function writeRunTask(companyId: string, runId: string, taskId: string): Promise<boolean> {
    const updated = await db.update(agentRuns)
        .set({ taskId })
        .where(and(eq(agentRuns.id, runId), eq(agentRuns.companyId, companyId), isNull(agentRuns.taskId)))
        .returning({ id: agentRuns.id });
    return updated.length > 0;
}

/**
 * At finish: attribute a run that still has no task (rule c only — rule a ran
 * at start). Returns the task id written, or null.
 */
export async function attributeFinishedRun(run: AttributableRun): Promise<string | null> {
    if (!needsActivityAttribution(run)) return null;
    const resolved = await resolveRunTask(run, ["task_events"]);
    if (!resolved) return null;
    return (await writeRunTask(run.companyId, run.id, resolved.taskId)) ? resolved.taskId : null;
}

// ─── Backfill ───────────────────────────────────────────────────────────────

export const BACKFILL_BATCH_SIZE = 500;

export interface BackfillOptions {
    execute: boolean;
    companyId?: string | null;
    since?: Date | null;
    batchSize?: number;
    /** Called after each batch (progress output). */
    onBatch?: (progress: BackfillCounts) => void;
}

export interface BackfillCounts {
    scanned: number;
    trigger_metadata: number;
    task_events: number;
    unresolved: number;
    /** Rows actually updated (0 on a dry run). */
    written: number;
}

/**
 * Apply rules (a) then (c) — with exactly the live-path checks: system trigger
 * only, agent scope, overlap skip — to every run with no task (optionally one company,
 * optionally started at or after `since`), in keyset batches. A dry run only
 * counts what it would write.
 */
export async function backfillRunTasks(options: BackfillOptions): Promise<BackfillCounts> {
    const batchSize = Math.max(1, Math.min(options.batchSize ?? BACKFILL_BATCH_SIZE, 5_000));
    const counts: BackfillCounts = { scanned: 0, trigger_metadata: 0, task_events: 0, unresolved: 0, written: 0 };
    // Keyset on the id alone: timestamps carry microseconds a JS Date drops, so
    // a (started_at, id) cursor could re-read the last row forever.
    let cursor: string | null = null;
    for (;;) {
        const conditions: (SQL | undefined)[] = [
            isNull(agentRuns.taskId),
            isNotNull(agentRuns.agentId),
            options.companyId ? eq(agentRuns.companyId, options.companyId) : undefined,
            options.since ? gte(agentRuns.startedAt, options.since) : undefined,
        ];
        if (cursor) conditions.push(gt(agentRuns.id, cursor));
        const batch: AttributableRun[] = await db.select({
            id: agentRuns.id,
            companyId: agentRuns.companyId,
            agentId: agentRuns.agentId,
            taskId: agentRuns.taskId,
            triggerMessageId: agentRuns.triggerMessageId,
            startedAt: agentRuns.startedAt,
            endedAt: agentRuns.endedAt,
        }).from(agentRuns)
            .where(and(...conditions))
            .orderBy(asc(agentRuns.id))
            .limit(batchSize);
        if (batch.length === 0) break;
        for (const run of batch) {
            counts.scanned += 1;
            const resolved = await resolveRunTask(run);
            if (!resolved) {
                counts.unresolved += 1;
                continue;
            }
            counts[resolved.rule] += 1;
            if (options.execute && (await writeRunTask(run.companyId, run.id, resolved.taskId))) counts.written += 1;
        }
        cursor = batch[batch.length - 1].id;
        options.onBatch?.({ ...counts });
        if (batch.length < batchSize) break;
    }
    return counts;
}
