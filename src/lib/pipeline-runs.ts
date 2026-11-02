// Starting and closing automation runs, and Emperor's own scheduler.
//
// One service for every way a run starts: Run now (POST /api/pipelines/[id]/run),
// the run_automation MCP tool and the scheduler tick (runScheduledPipelines).
// A run started here hands the work to the runner agent as a task (the normal
// task path, so the agent is woken); the run closes when the agent reports it
// through the runs API, or when that task is done or failed
// (closePipelineRunsForTask, called after the task_updated broadcast).
//
// Agents that schedule an automation from their own runtime keep doing so:
// Emperor only fires automations whose scheduledBy is 'emperor'.

import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, pipelineRuns, pipelines, projects, taskEvents, tasks } from "@/db/schema";
import { createTaskForProject } from "@/lib/openclaw/tasks";
import { DEFAULT_PROJECT_GOAL, ensureDefaultProject } from "@/lib/default-project";
import { recordAudit, SYSTEM_ACTOR, type AuditActor } from "@/lib/audit";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { normalizeAgentRef, resolveAgentId } from "@/lib/mcp";
import { splitProjectTitle } from "@/lib/project-title";
import { TASK_TITLE_MAX } from "@/lib/input-limits";
import { companyTimezoneFrom, computeNextRunAt, cronExpression, emperorScheduleProblem } from "@/lib/pipeline-schedule";
import { runStatusForTaskState, type PipelineRunSource, type PipelineStep } from "@/lib/pipelines";

type PipelineRow = typeof pipelines.$inferSelect;
type PipelineRunRow = typeof pipelineRuns.$inferSelect;

export type PipelineRunErrorCode =
    | "not_found" | "not_active" | "no_agent" | "agent_not_found" | "agent_inactive" | "already_running" | "project_denied" | "start_error";

/** A run that cannot start, with the HTTP status the routes answer and a plain reason. */
export class PipelineRunError extends Error {
    constructor(readonly code: PipelineRunErrorCode, message: string, readonly status: number, readonly run?: PipelineRunRow) {
        super(message);
        this.name = "PipelineRunError";
    }
}

export type TriggeredBy = { type: "user" | "agent"; id: string } | null;

export type StartPipelineRunInput = {
    companyId: string;
    pipelineId: string;
    /** The runner: an agent id or name. Defaults to the automation's own agent. */
    agentRef?: string | null;
    /** Start even though a run of this automation is still running. */
    force?: boolean;
    source: Extract<PipelineRunSource, "manual" | "schedule" | "api">;
    triggeredBy: TriggeredBy;
    /** For the activity log and the task's history. */
    actor: AuditActor;
    /**
     * May the caller create a task in this project? `null` = the company's
     * "General" project, which does not exist yet. Omitted for the scheduler
     * (the system may always use it).
     */
    mayUseProject?: (projectId: string | null) => Promise<boolean>;
    /** The slot a scheduled run is for (shown in the task brief). */
    scheduledFor?: Date | null;
    now?: Date;
};

export type StartedPipelineRun = { run: PipelineRunRow; taskId: string; agentId: string; pipeline: PipelineRow };

/** Test seam: a failure injected between recording a run and handing out its task. */
export const pipelineRunTestHooks: { beforeTask: (() => Promise<void>) | null } = { beforeTask: null };

async function loadPipeline(companyId: string, pipelineId: string): Promise<PipelineRow | null> {
    const [row] = await db.select().from(pipelines).where(
        and(eq(pipelines.id, pipelineId), eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt)),
    ).limit(1);
    return row ?? null;
}

/** The agent that will run it: named, else the automation's own. Must exist and not be paused. */
async function resolveRunner(companyId: string, pipeline: PipelineRow, agentRef?: string | null) {
    const ref = agentRef ? normalizeAgentRef(agentRef) : null;
    const target = ref || pipeline.ownerAgentId;
    if (!target) {
        throw new PipelineRunError("no_agent", "No agent runs this automation. Choose an agent to run it.", 422);
    }
    let agentId: string;
    try {
        agentId = ref ? await resolveAgentId(companyId, ref) : target;
    } catch {
        throw new PipelineRunError("agent_not_found", `Agent not found: ${ref}`, 404);
    }
    const [agent] = await db.select({ id: agents.id, name: agents.name, budgetStatus: agents.budgetStatus, deletedAt: agents.deletedAt })
        .from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).limit(1);
    if (!agent || agent.deletedAt) {
        throw new PipelineRunError("agent_not_found", "The agent that runs this automation no longer exists. Choose another agent.", 404);
    }
    if (agent.budgetStatus === "paused") {
        throw new PipelineRunError("agent_inactive", `${agent.name} is paused. Resume it or choose another agent.`, 422);
    }
    return agent;
}

/**
 * The project the run's task goes to: the automation's own, else the company's
 * "General" project. The caller must be allowed to create tasks there.
 */
async function resolveRunProject(companyId: string, pipeline: PipelineRow, mayUseProject?: StartPipelineRunInput["mayUseProject"]) {
    const denied = () => new PipelineRunError("project_denied", "You can't create tasks in the project this automation's runs go to.", 403);
    if (pipeline.projectId) {
        const [own] = await db.select({ id: projects.id, goal: projects.goal }).from(projects)
            .where(and(eq(projects.id, pipeline.projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt))).limit(1);
        if (own) {
            if (mayUseProject && !(await mayUseProject(own.id))) throw denied();
            return { id: own.id, name: splitProjectTitle(own.goal).name };
        }
    }
    const [general] = await db.select({ id: projects.id }).from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.goal, DEFAULT_PROJECT_GOAL), isNull(projects.deletedAt))).limit(1);
    if (mayUseProject && !(await mayUseProject(general?.id ?? null))) throw denied();
    return { id: general?.id ?? null, name: null };
}

function triggerSentence(pipeline: Pick<PipelineRow, "trigger" | "triggerConfig">): string {
    const cron = cronExpression(pipeline.triggerConfig);
    if (pipeline.trigger === "cron") return cron ? `On a schedule (cron: ${cron})` : "On a schedule";
    if (pipeline.trigger === "event") {
        const cfg = pipeline.triggerConfig as Record<string, unknown> | null;
        return typeof cfg?.event === "string" ? `When this happens: ${cfg.event}` : "When an event happens";
    }
    return "When someone runs it";
}

/**
 * What the runner agent reads: why, the steps, and how to report the run.
 * English, agent-facing. Only the automation's own fields and the project the
 * task lives in: nothing the agent would not see on the task anyway.
 */
export function pipelineRunTaskBrief(input: {
    pipeline: Pick<PipelineRow, "id" | "name" | "purpose" | "trigger" | "triggerConfig" | "stepsJson" | "runtimeRef">;
    runId: string;
    source: PipelineRunSource;
    projectName?: string | null;
    scheduledFor?: Date | null;
}): string {
    const { pipeline } = input;
    const steps = Array.isArray(pipeline.stepsJson) ? pipeline.stepsJson as PipelineStep[] : [];
    const started = input.source === "schedule"
        ? `Started by Emperor's schedule${input.scheduledFor ? ` for ${input.scheduledFor.toISOString()}` : ""}.`
        : input.source === "manual" ? "Started from the app (Run now)." : "Started through the Emperor API.";
    const lines = [
        `Run the automation "${pipeline.name}" once, now. ${started}`,
        "",
        `Purpose: ${pipeline.purpose || "(not documented)"}`,
        `Trigger: ${triggerSentence(pipeline)}`,
    ];
    if (input.projectName) lines.push(`Project: ${input.projectName}`);
    if (pipeline.runtimeRef) lines.push(`In your runtime: ${pipeline.runtimeRef}`);
    lines.push("", "Steps:");
    if (steps.length === 0) lines.push("1. (no steps registered)");
    steps.forEach((step, index) => {
        lines.push(`${index + 1}. ${step.name}${step.description ? ` - ${step.description}` : ""}${step.gate ? " (needs human approval before continuing)" : ""}`);
    });
    lines.push(
        "",
        `This is run ${input.runId}. When it finishes, report it: POST /api/mcp/pipelines/${pipeline.id}/runs with`,
        `{ "runId": "${input.runId}", "status": "succeeded" | "failed" | "partial", "summary": "...", "stats": { "taskIds": [...], "artifactIds": [...] } }`,
        "then close this task. Closing this task (done or failed) also closes the run.",
    );
    return lines.join("\n");
}

function runTaskTitle(name: string): string {
    const prefix = "Run automation: ";
    const max = Math.min(TASK_TITLE_MAX, 120) - prefix.length;
    return prefix + (name.length > max ? `${name.slice(0, max - 1)}…` : name);
}

async function runningRunOf(executor: Pick<typeof db, "select">, pipelineId: string): Promise<PipelineRunRow | null> {
    const [run] = await executor.select().from(pipelineRuns)
        .where(and(eq(pipelineRuns.pipelineId, pipelineId), eq(pipelineRuns.status, "running")))
        .orderBy(desc(pipelineRuns.startedAt)).limit(1);
    return run ?? null;
}

/** The automation's "last run" follows a run that closed, but only if it still is the last one. */
async function syncLastRunStatus(pipelineId: string, run: { startedAt: Date; status: string }) {
    await db.update(pipelines).set({ lastRunStatus: run.status, updatedAt: new Date() })
        .where(and(eq(pipelines.id, pipelineId), eq(pipelines.lastRunAt, run.startedAt)));
}

/** Undo a scheduled run that never reached its agent: the row and its count go; the scheduler records the slot. */
async function discardRun(run: PipelineRunRow, pipelineId: string): Promise<void> {
    await db.transaction(async (tx) => {
        const deleted = await tx.delete(pipelineRuns).where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"))).returning({ id: pipelineRuns.id });
        if (deleted.length === 0) return;
        await tx.update(pipelines).set({ runCount: sql`GREATEST(${pipelines.runCount} - 1, 0)`, updatedAt: new Date() }).where(eq(pipelines.id, pipelineId));
    });
}

async function failRun(run: PipelineRunRow, pipelineId: string, summary: string): Promise<void> {
    const [failed] = await db.update(pipelineRuns).set({ status: "failed", summary: summary.slice(0, 1000), endedAt: new Date() })
        .where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"))).returning();
    if (failed) {
        await syncLastRunStatus(pipelineId, failed);
        await broadcastMcpEvent(failed.companyId, { type: "pipeline_run_updated", pipelineId, runId: failed.id, status: failed.status });
    }
}

/**
 * Start one run: checks the automation is active, picks the runner and the
 * project, refuses a second concurrent run unless `force`, then records the
 * run and hands the work to the agent as a task assigned to it
 * (createTaskForProject wakes it). Anything that fails after the run is
 * recorded closes it as failed, so a run is never left running without a task.
 */
export async function startPipelineRun(input: StartPipelineRunInput): Promise<StartedPipelineRun> {
    const pipeline = await loadPipeline(input.companyId, input.pipelineId);
    if (!pipeline) throw new PipelineRunError("not_found", "Automation not found", 404);
    if (pipeline.status !== "active") {
        const word = pipeline.status === "paused" ? "paused" : pipeline.status === "draft" ? "a draft" : "retired";
        throw new PipelineRunError("not_active", `This automation is ${word}. Only an active automation can run.`, 409);
    }
    const agent = await resolveRunner(input.companyId, pipeline, input.agentRef);
    const project = await resolveRunProject(input.companyId, pipeline, input.mayUseProject);
    const projectId = project.id ?? await ensureDefaultProject(input.companyId, input.actor);

    // One check-and-insert per automation at a time, so two clicks (or two
    // instances) cannot both see "nothing running" and start twice. The
    // automation's run count and last run move in the same transaction.
    const run = await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`pipeline-run:${pipeline.id}`}))`);
        const running = await runningRunOf(tx, pipeline.id);
        if (running && !input.force) {
            throw new PipelineRunError("already_running", "A run of this automation is still running.", 409, running);
        }
        const [inserted] = await tx.insert(pipelineRuns).values({
            companyId: input.companyId,
            pipelineId: pipeline.id,
            agentId: agent.id,
            status: "running",
            source: input.source,
            triggeredByType: input.triggeredBy?.type ?? null,
            triggeredById: input.triggeredBy?.id ?? null,
            statsJson: {},
            ...(input.now ? { startedAt: input.now } : {}),
        }).returning();
        await tx.update(pipelines).set({
            runCount: sql`${pipelines.runCount} + 1`,
            lastRunAt: inserted.startedAt,
            lastRunStatus: "running",
            updatedAt: new Date(),
        }).where(eq(pipelines.id, pipeline.id));
        return inserted;
    });

    let taskId: string | null = null;
    let withTask: PipelineRunRow;
    try {
        if (pipelineRunTestHooks.beforeTask) await pipelineRunTestHooks.beforeTask();
        const { task } = await createTaskForProject({
            companyId: input.companyId,
            projectId,
            taskType: "automation_run",
            inputJson: {
                title: runTaskTitle(pipeline.name),
                description: pipelineRunTaskBrief({ pipeline, runId: run.id, source: input.source, scheduledFor: input.scheduledFor, projectName: project.name }),
                pipelineId: pipeline.id,
                pipelineRunId: run.id,
            },
            assignedAgentId: agent.id,
            source: input.source === "schedule" ? "pipeline_schedule" : "pipeline_run",
            actorType: input.actor.type,
            actorId: input.actor.id,
        });
        taskId = task.id;
        [withTask] = await db.update(pipelineRuns).set({ taskId, statsJson: { taskIds: [taskId] } })
            .where(eq(pipelineRuns.id, run.id)).returning();
    } catch (error) {
        const reason = `Could not hand the run to the agent: ${error instanceof Error ? error.message : String(error)}`;
        // A scheduled slot that never reached the agent leaves no run of its
        // own: the scheduler records it once per streak (recordScheduleOutcome),
        // so a handoff that fails every tick is one counted row, then a pause.
        // Once a task exists the run stays and is closed as failed.
        const discard = input.source === "schedule" && taskId === null;
        await (discard ? discardRun(run, pipeline.id) : failRun(run, pipeline.id, reason))
            .catch((closeError) => console.error("Failed to close an automation run that could not start:", closeError));
        throw new PipelineRunError("start_error", reason, 500);
    }
    if (!taskId) throw new PipelineRunError("start_error", "Could not hand the run to the agent", 500);

    // The task may already be closed (a fast agent) before taskId was written:
    // its task_updated found no run then, so close it now.
    const [taskNow] = await db.select({ id: tasks.id, state: tasks.state, outputJson: tasks.outputJson }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (taskNow && runStatusForTaskState(taskNow.state)) await closePipelineRunsForTask(input.companyId, taskNow);

    await recordAudit({
        companyId: input.companyId,
        actor: input.actor,
        action: "pipeline.run_started",
        target: { type: "pipeline", id: pipeline.id },
        after: { name: pipeline.name, runId: run.id, taskId, source: input.source, agentId: agent.id },
        meta: { label: pipeline.name },
    });
    await broadcastMcpEvent(input.companyId, { type: "pipeline_run_updated", pipelineId: pipeline.id, runId: run.id, status: withTask.status });
    const [current] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.id, run.id)).limit(1);
    return { run: current ?? withTask, taskId, agentId: agent.id, pipeline };
}

/** A short closing line from the task: its result summary, else its last note. Best effort. */
async function taskClosingSummary(companyId: string, task: { id: string; outputJson?: unknown }): Promise<string | null> {
    const output = task.outputJson && typeof task.outputJson === "object" ? task.outputJson as Record<string, unknown> : null;
    for (const key of ["summary", "result", "message"]) {
        const value = output?.[key];
        if (typeof value === "string" && value.trim()) return value.trim().slice(0, 1000);
    }
    const [note] = await db.select({ payloadJson: taskEvents.payloadJson }).from(taskEvents)
        .where(and(eq(taskEvents.companyId, companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.eventType, "task_note")))
        .orderBy(desc(taskEvents.createdAt)).limit(1);
    const text = (note?.payloadJson as { note?: unknown } | undefined)?.note;
    return typeof text === "string" && text.trim() ? text.trim().slice(0, 1000) : null;
}

/**
 * A task reached done/failed: close the still-running run that handed it out
 * (pipeline_runs.task_id, indexed). Called after every task_updated broadcast.
 */
export async function closePipelineRunsForTask(companyId: string, task: { id: string; state: string; outputJson?: unknown }): Promise<number> {
    const status = runStatusForTaskState(task.state);
    if (!status) return 0;
    const open = await db.select({ id: pipelineRuns.id, pipelineId: pipelineRuns.pipelineId, summary: pipelineRuns.summary }).from(pipelineRuns).where(and(
        eq(pipelineRuns.taskId, task.id),
        eq(pipelineRuns.companyId, companyId),
        eq(pipelineRuns.status, "running"),
    ));
    if (open.length === 0) return 0;
    const summary = await taskClosingSummary(companyId, task);
    let closed = 0;
    for (const run of open) {
        const [updated] = await db.update(pipelineRuns).set({
            status,
            summary: run.summary ?? summary ?? (status === "succeeded" ? "The task was completed." : "The task failed."),
            endedAt: new Date(),
        }).where(and(eq(pipelineRuns.id, run.id), eq(pipelineRuns.status, "running"))).returning();
        if (!updated) continue;
        closed++;
        await syncLastRunStatus(run.pipelineId, updated);
        await broadcastMcpEvent(companyId, { type: "pipeline_run_updated", pipelineId: run.pipelineId, runId: updated.id, status: updated.status });
    }
    return closed;
}

// ─── Next run ───────────────────────────────────────────────────────────────

export async function companyTimezone(companyId: string): Promise<string | null> {
    const [company] = await db.select({ agentRoutineJson: companies.agentRoutineJson }).from(companies)
        .where(eq(companies.id, companyId)).limit(1);
    return companyTimezoneFrom(company?.agentRoutineJson);
}

/** The next slot for a pipeline as it stands now (null when not an active cron automation). */
export async function nextRunAtFor(companyId: string, pipeline: { status: string; trigger: string; triggerConfig: unknown }, now = new Date()): Promise<Date | null> {
    return computeNextRunAt(pipeline, await companyTimezone(companyId), now);
}

/** Why Emperor could not keep this automation's schedule; null when it can (or does not schedule it). */
export async function emperorScheduleProblemFor(companyId: string, pipeline: { trigger: string; triggerConfig: unknown; scheduledBy: string }): Promise<string | null> {
    if (pipeline.scheduledBy !== "emperor" || pipeline.trigger !== "cron") return null;
    return emperorScheduleProblem(pipeline.triggerConfig, await companyTimezone(companyId));
}

// ─── Emperor's scheduler ────────────────────────────────────────────────────

/** Emperor-scheduled runs one company may start in one tick; the rest stay due for the next tick. */
export const SCHEDULER_RUNS_PER_COMPANY_PER_TICK = 20;
/** Consecutive failed starts (no agent able to run it) before Emperor pauses the automation. */
export const SCHEDULER_FAILURES_BEFORE_PAUSE = 3;

/** Start failures that repeat until someone fixes them: after a streak of these Emperor pauses the automation. */
const PAUSE_AFTER_STREAK = new Set(["no_agent", "agent_not_found", "agent_inactive", "start_error"]);

export type SchedulerOutcome = {
    pipelineId: string;
    outcome: "started" | "skipped" | "failed" | "initialized" | "paused" | "deferred" | "lost_claim";
};

/** Emperor stops an automation it cannot run, says why, and records it in the activity log. */
async function pauseBySystem(pipeline: PipelineRow, reason: string) {
    const [paused] = await db.update(pipelines).set({ status: "paused", pausedReason: reason.slice(0, 500), nextRunAt: null, updatedAt: new Date() })
        .where(and(eq(pipelines.id, pipeline.id), eq(pipelines.status, "active"))).returning({ id: pipelines.id });
    if (!paused) return;
    await recordAudit({
        companyId: pipeline.companyId,
        actor: SYSTEM_ACTOR,
        action: "pipeline.paused",
        target: { type: "pipeline", id: pipeline.id },
        before: { status: "active" },
        after: { name: pipeline.name, status: "paused" },
        meta: { label: pipeline.name, reason },
    });
    await broadcastMcpEvent(pipeline.companyId, { type: "pipeline_run_updated", pipelineId: pipeline.id });
}

/**
 * A slot that did not start a run (skipped, or failed to start). Repeats of the
 * same outcome update the latest such row (statsJson.repeat, lastAt) instead of
 * adding one row per slot. Returns how many times in a row it happened.
 */
async function recordScheduleOutcome(pipeline: PipelineRow, status: "skipped" | "failed", reasonCode: string, summary: string, agentId: string | null, now: Date): Promise<number> {
    const [latest] = await db.select().from(pipelineRuns).where(eq(pipelineRuns.pipelineId, pipeline.id))
        .orderBy(desc(pipelineRuns.startedAt), desc(pipelineRuns.createdAt)).limit(1);
    const stats = (latest?.statsJson ?? {}) as { reasonCode?: unknown; repeat?: unknown; streakClosed?: unknown };
    if (latest && latest.status === status && latest.source === "schedule" && stats.reasonCode === reasonCode && stats.streakClosed !== true) {
        const repeat = (typeof stats.repeat === "number" ? stats.repeat : 1) + 1;
        await db.update(pipelineRuns).set({ endedAt: now, summary, statsJson: { ...stats, repeat, lastAt: now.toISOString() } })
            .where(eq(pipelineRuns.id, latest.id));
        await broadcastMcpEvent(pipeline.companyId, { type: "pipeline_run_updated", pipelineId: pipeline.id, runId: latest.id, status });
        return repeat;
    }
    const [run] = await db.insert(pipelineRuns).values({
        companyId: pipeline.companyId,
        pipelineId: pipeline.id,
        agentId,
        status,
        source: "schedule",
        summary,
        statsJson: { reasonCode, repeat: 1 },
        startedAt: now,
        endedAt: now,
    }).returning();
    // A skipped slot leaves the previous (still running) run as the last one.
    if (status === "failed") {
        await db.update(pipelines).set({ lastRunAt: run.startedAt, lastRunStatus: "failed", updatedAt: new Date() }).where(eq(pipelines.id, pipeline.id));
    }
    await broadcastMcpEvent(pipeline.companyId, { type: "pipeline_run_updated", pipelineId: pipeline.id, runId: run.id, status });
    return 1;
}

/**
 * Turning an automation on again starts its failure streak over: the next
 * failed or skipped slot gets a row of its own (count 1) instead of adding to
 * the streak that led to the pause. Called by every resume path.
 */
export async function closeScheduleStreak(pipelineId: string): Promise<void> {
    await db.update(pipelineRuns)
        .set({ statsJson: sql`${pipelineRuns.statsJson} || '{"streakClosed": true}'::jsonb` })
        .where(and(eq(pipelineRuns.pipelineId, pipelineId), sql`${pipelineRuns.statsJson} ? 'reasonCode'`, sql`NOT (${pipelineRuns.statsJson} @> '{"streakClosed": true}'::jsonb)`));
}

async function startScheduledSlot(pipeline: PipelineRow, slot: Date, now: Date): Promise<SchedulerOutcome["outcome"]> {
    try {
        await startPipelineRun({
            companyId: pipeline.companyId,
            pipelineId: pipeline.id,
            source: "schedule",
            triggeredBy: null,
            actor: SYSTEM_ACTOR,
            scheduledFor: slot,
            now,
        });
        return "started";
    } catch (error) {
        if (error instanceof PipelineRunError && error.code === "already_running") {
            await recordScheduleOutcome(pipeline, "skipped", "already_running", "Previous run still running", error.run?.agentId ?? pipeline.ownerAgentId, now);
            return "skipped";
        }
        if (error instanceof PipelineRunError && (error.code === "not_active" || error.code === "not_found")) return "lost_claim";
        const code = error instanceof PipelineRunError ? error.code : "start_error";
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof PipelineRunError)) console.error(`Scheduled run of automation ${pipeline.id} failed:`, error);
        const repeat = await recordScheduleOutcome(pipeline, "failed", code, `Not started: ${message}`, null, now);
        if (PAUSE_AFTER_STREAK.has(code) && repeat >= SCHEDULER_FAILURES_BEFORE_PAUSE) {
            await pauseBySystem(pipeline, `Paused after ${repeat} scheduled runs could not start: ${message}`);
            return "paused";
        }
        return "failed";
    }
}

/**
 * One scheduler pass: fire every active cron automation that Emperor schedules
 * and whose nextRunAt is due, oldest slot first. Multi-instance safe: a slot is
 * claimed by moving nextRunAt forward with a compare-and-set on its old value,
 * and only the instance whose update matched fires it. Missed slots (downtime)
 * fire at most once, then nextRunAt jumps to the next future slot. At most
 * SCHEDULER_RUNS_PER_COMPANY_PER_TICK slots per company per pass; the rest are
 * left unclaimed (still due) for the next pass. One automation's failure never
 * stops the others. Called by the lifecycle monitor every 60s; tests call it
 * directly with a fake `now`.
 */
export async function runScheduledPipelines(now = new Date()): Promise<SchedulerOutcome[]> {
    const outcomes: SchedulerOutcome[] = [];
    const scheduled = and(
        eq(pipelines.status, "active"),
        eq(pipelines.trigger, "cron"),
        eq(pipelines.scheduledBy, "emperor"),
        isNull(pipelines.deletedAt),
    );
    const timezones = new Map<string, string | null>();
    const tzOf = async (companyId: string) => {
        if (!timezones.has(companyId)) timezones.set(companyId, await companyTimezone(companyId));
        return timezones.get(companyId) ?? null;
    };

    // No slot yet (switched to Emperor by a path that did not set one): give it
    // its first slot without firing, or pause it when its schedule is unusable.
    const uninitialized = await db.select().from(pipelines).where(and(scheduled, isNull(pipelines.nextRunAt)))
        .orderBy(asc(pipelines.updatedAt)).limit(200);
    for (const pipeline of uninitialized) {
        try {
            const problem = emperorScheduleProblem(pipeline.triggerConfig, await tzOf(pipeline.companyId), now);
            if (problem) {
                await recordScheduleOutcome(pipeline, "failed", "invalid_schedule", problem, null, now);
                await pauseBySystem(pipeline, problem);
                outcomes.push({ pipelineId: pipeline.id, outcome: "paused" });
                continue;
            }
            const next = computeNextRunAt(pipeline, await tzOf(pipeline.companyId), now);
            const [set] = await db.update(pipelines).set({ nextRunAt: next })
                .where(and(eq(pipelines.id, pipeline.id), isNull(pipelines.nextRunAt))).returning({ id: pipelines.id });
            if (set) outcomes.push({ pipelineId: pipeline.id, outcome: "initialized" });
        } catch (error) {
            console.error(`Scheduler could not set up automation ${pipeline.id}:`, error);
        }
    }

    // Due slots per company, so one busy company cannot starve the others:
    // each company is read separately, oldest slot first, bounded.
    const dueCompanies = await db.selectDistinct({ companyId: pipelines.companyId }).from(pipelines)
        .where(and(scheduled, lte(pipelines.nextRunAt, now))).limit(1000);
    const due: PipelineRow[] = [];
    for (const { companyId } of dueCompanies) {
        due.push(...await db.select().from(pipelines).where(and(scheduled, eq(pipelines.companyId, companyId), lte(pipelines.nextRunAt, now)))
            .orderBy(asc(pipelines.nextRunAt)).limit(SCHEDULER_RUNS_PER_COMPANY_PER_TICK * 2));
    }
    const startedPerCompany = new Map<string, number>();
    for (const pipeline of due) {
        try {
            const used = startedPerCompany.get(pipeline.companyId) ?? 0;
            if (used >= SCHEDULER_RUNS_PER_COMPANY_PER_TICK) {
                outcomes.push({ pipelineId: pipeline.id, outcome: "deferred" });
                continue;
            }
            const slot = pipeline.nextRunAt!;
            const tz = await tzOf(pipeline.companyId);
            const problem = emperorScheduleProblem(pipeline.triggerConfig, tz, now);
            const next = problem ? null : computeNextRunAt(pipeline, tz, now);
            const [claimed] = await db.update(pipelines).set({ nextRunAt: next }).where(and(
                eq(pipelines.id, pipeline.id),
                eq(pipelines.nextRunAt, slot),
                eq(pipelines.status, "active"),
                isNull(pipelines.deletedAt),
            )).returning({ id: pipelines.id });
            if (!claimed) {
                outcomes.push({ pipelineId: pipeline.id, outcome: "lost_claim" });
                continue;
            }
            if (problem) {
                await recordScheduleOutcome(pipeline, "failed", "invalid_schedule", problem, null, now);
                await pauseBySystem(pipeline, problem);
                outcomes.push({ pipelineId: pipeline.id, outcome: "paused" });
                continue;
            }
            // At most once: the slot is claimed before the run starts, so a crash
            // between the claim and startScheduledSlot loses that slot (it is not
            // retried) rather than ever starting it twice.
            const outcome = await startScheduledSlot(pipeline, slot, now);
            // Paused or retired since it was read: no run started, no cap used.
            if (outcome !== "lost_claim") startedPerCompany.set(pipeline.companyId, used + 1);
            outcomes.push({ pipelineId: pipeline.id, outcome });
        } catch (error) {
            console.error(`Scheduler failed on automation ${pipeline.id}:`, error);
            outcomes.push({ pipelineId: pipeline.id, outcome: "failed" });
        }
    }
    return outcomes;
}

/**
 * Whether this process runs the scheduler tick. Off under tests and `next dev`
 * (NODE_ENV test/development) so a development database never starts real
 * runs, unless EMPEROR_PIPELINE_SCHEDULER=on; `off` stops it anywhere.
 */
export function schedulerDisabledInThisProcess(env: Record<string, string | undefined> = process.env): boolean {
    const flag = env.EMPEROR_PIPELINE_SCHEDULER?.trim().toLowerCase();
    if (flag === "off") return true;
    if (flag === "on") return false;
    return env.NODE_ENV === "test" || env.NODE_ENV === "development";
}

/** Tasks of a run, for links in the UI. */
export function runTaskIds(run: { statsJson: unknown; taskId?: string | null }): string[] {
    const ids = (run.statsJson as { taskIds?: unknown } | null)?.taskIds;
    const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
    return run.taskId && !list.includes(run.taskId) ? [run.taskId, ...list] : list;
}
