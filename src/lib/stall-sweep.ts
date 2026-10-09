import { and, asc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companies, projects, taskEvents, tasks, threadMessages } from "@/db/schema";
import { appendThreadMessage, ensureDirectThread } from "@/lib/control-plane";
import { companyAdminIds, notify } from "@/lib/notifications";
import { SLA_TRACKED_TASK_STATES } from "@/lib/task-state";
import { sanitizePromptText } from "@/lib/task-wake";

/**
 * Stall sweep: tasks assigned to an agent that have not moved (no note/update)
 * for a while get one targeted nudge to the owner; if still stale after another
 * window, the project lead agent (or the task creator) is told and a human
 * notification is raised. Deduped through task-events timestamps so it never
 * spams: nudge once, escalate once, then stay quiet until the task updates.
 *
 * A sweep can find many stale tasks at once (e.g. the first run after deploy
 * over an old backlog), so the messages are coalesced: ONE nudge message per
 * agent listing its stale tasks, ONE escalation message per escalation target,
 * and ONE human notification per company. Every task still gets its own
 * stall event so the per-task dedupe is unchanged.
 *
 * The dedupe is folded into the main query (correlated `max(created_at)` over
 * task events, only counting events at or after the task's last update), so the
 * sweep is one query, not N+1. A separate horizon drops abandoned backlog: a
 * task that has not moved for longer than the max-age window is never nudged or
 * escalated (the dashboard still shows it).
 */

export const DEFAULT_STALL_SWEEP_HOURS = 4;
export const STALL_NUDGE_EVENT = "stall_nudge";
export const STALL_ESCALATION_EVENT = "stall_escalation";
export const DEFAULT_STALL_MAX_AGE_DAYS = 7;
/** At most this many task lines are listed in a coalesced message. */
export const MAX_STALL_TASK_LINES = 8;

export function stallSweepHours(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.EMPEROR_STALL_SWEEP_HOURS);
    return Number.isFinite(value) && value >= 1 && value <= 24 * 7 ? value : DEFAULT_STALL_SWEEP_HOURS;
}

/**
 * The backlog horizon: tasks whose `updatedAt` is older than this many days are
 * treated as abandoned and never nudged/escalated. Clamped to 1..365 days.
 */
export function stallMaxAgeDays(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.EMPEROR_STALL_MAX_AGE_DAYS);
    if (!Number.isFinite(value)) return DEFAULT_STALL_MAX_AGE_DAYS;
    return Math.min(365, Math.max(1, Math.round(value)));
}

export type StallStage = "nudge" | "escalate" | "none";

/** Pure decision for one task, so the stages are unit-tested without a DB. */
export function stallStage(
    nowMs: number,
    updatedAtMs: number,
    hours: number,
    lastNudgeAtMs: number | null,
    lastEscalationAtMs: number | null,
): StallStage {
    const windowMs = hours * 3_600_000;
    if (nowMs - updatedAtMs < windowMs) return "none";
    if (lastEscalationAtMs !== null) return "none";
    if (lastNudgeAtMs === null) return "nudge";
    if (nowMs - lastNudgeAtMs >= windowMs) return "escalate";
    return "none";
}

/** One task inside a coalesced message. The title is already sanitized. */
export type StallTaskLine = { id: string; title: string };

/** A due task, keyed by the agent that should receive its message. */
export interface StallGroupItem {
    companyId: string;
    /** The agent the message goes to (assignee for nudges, escalation target). */
    targetKey: string;
    id: string;
    title: string;
}

function cleanTitle(title: string): string {
    return title.replace(/[[\]]/g, "");
}

/** The numbered task list, capped at {@link MAX_STALL_TASK_LINES} lines. */
function listLines(tasks: StallTaskLine[]): string[] {
    const shown = tasks.slice(0, MAX_STALL_TASK_LINES);
    const lines = shown.map((t, i) => ` ${i + 1}. [${cleanTitle(t.title)}](emperor://task/${t.id})`);
    if (tasks.length > MAX_STALL_TASK_LINES) {
        lines.push(`…and ${tasks.length - MAX_STALL_TASK_LINES} more`);
    }
    return lines;
}

/** ONE nudge message listing an agent's stale tasks. Pure, so it is unit-tested. */
export function nudgeText(tasks: StallTaskLine[]): string {
    if (tasks.length === 0) return "";
    if (tasks.length === 1) {
        const [t] = tasks;
        return `Your task [${cleanTitle(t.title)}](emperor://task/${t.id}) has not moved in a while. Update it (a note with progress or the blocker), and if you're stuck say so on the task and ask the specific person.`;
    }
    return [
        "These tasks have not moved in a while:",
        "",
        ...listLines(tasks),
        "",
        "Update each (a note with progress or the blocker), and if you're stuck say so on the task and ask the specific person.",
    ].join("\n");
}

/** ONE escalation message listing an escalation target's stale tasks. Pure. */
export function escalationText(tasks: StallTaskLine[]): string {
    if (tasks.length === 0) return "";
    if (tasks.length === 1) {
        const [t] = tasks;
        return `Escalation: the task [${cleanTitle(t.title)}](emperor://task/${t.id}) is still stale after a nudge. Check on it and reassign or unblock it.`;
    }
    return [
        "Escalation: these tasks are still stale after a nudge:",
        "",
        ...listLines(tasks),
        "",
        "Check on them and reassign or unblock them.",
    ].join("\n");
}

/** Group due tasks by their (company, target agent), preserving order. Pure. */
export function groupStallTasks(items: StallGroupItem[]): Map<string, { companyId: string; targetKey: string; tasks: StallTaskLine[] }> {
    const map = new Map<string, { companyId: string; targetKey: string; tasks: StallTaskLine[] }>();
    for (const item of items) {
        const key = `${item.companyId}\u0000${item.targetKey}`;
        const bucket = map.get(key) ?? { companyId: item.companyId, targetKey: item.targetKey, tasks: [] };
        bucket.tasks.push({ id: item.id, title: item.title });
        map.set(key, bucket);
    }
    return map;
}

async function recordEvent(companyId: string, taskId: string, eventType: string): Promise<void> {
    await db.insert(taskEvents).values({
        companyId,
        taskId,
        eventType,
        actorType: "system",
        actorId: null,
        payloadJson: { at: new Date().toISOString() },
    });
}

function taskDisplayTitle(inputJson: unknown, taskType: string): string {
    const input = inputJson && typeof inputJson === "object" ? inputJson as Record<string, unknown> : {};
    const raw = typeof input.title === "string" && input.title.trim() ? input.title.trim() : taskType;
    return sanitizePromptText(raw).replace(/[[\]]/g, "");
}

async function postNudge(companyId: string, agentId: string, tasks: StallTaskLine[]): Promise<void> {
    const thread = await ensureDirectThread(companyId, agentId, null);
    await appendThreadMessage({
        companyId,
        threadId: thread.id,
        senderType: "system",
        targetAgentId: agentId,
        text: nudgeText(tasks),
        deliveryState: "queued",
        metadataJson: { stallNudge: true, taskIds: tasks.map((t) => t.id) },
    });
}

async function postEscalation(companyId: string, agentId: string, tasks: StallTaskLine[]): Promise<void> {
    const thread = await ensureDirectThread(companyId, agentId, null);
    await appendThreadMessage({
        companyId,
        threadId: thread.id,
        senderType: "system",
        targetAgentId: agentId,
        text: escalationText(tasks),
        deliveryState: "queued",
        metadataJson: { stallEscalation: true, taskIds: tasks.map((t) => t.id) },
    });
}

/** The latest stall event for a task that occurred at or after its last update. */
const lastStallEventAt = (eventType: string) =>
    sql<Date | null>`(SELECT max(te.created_at) FROM task_events te WHERE te.task_id = ${tasks.id} AND te.event_type = ${eventType} AND te.created_at >= ${tasks.updatedAt})`;

/** Run the stall sweep once. Returns the number of coalesced messages posted. */
export async function runStallSweep(now = new Date()): Promise<number> {
    // All app instances share this lock. A concurrent monitor skips this run.
    return db.transaction(async tx => {
        const result = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(1937006962, 1) AS locked`);
        if (!result.rows[0]?.locked) return 0;
        return runLockedStallSweep(now);
    });
}

async function runLockedStallSweep(now: Date): Promise<number> {
    const hours = stallSweepHours();
    const maxAgeDays = stallMaxAgeDays();
    const windowMs = hours * 3_600_000;
    const cutoff = new Date(now.getTime() - windowMs);
    const horizonCutoff = new Date(now.getTime() - maxAgeDays * 24 * 3_600_000);

    const lastNudge = lastStallEventAt(STALL_NUDGE_EVENT);
    const lastEscalation = lastStallEventAt(STALL_ESCALATION_EVENT);

    const rows = await db.select({
        id: tasks.id,
        companyId: tasks.companyId,
        projectId: tasks.projectId,
        state: tasks.state,
        inputJson: tasks.inputJson,
        taskType: tasks.taskType,
        assignedAgentId: tasks.assignedAgentId,
        updatedAt: tasks.updatedAt,
        lastNudgeAt: lastNudge,
        lastEscalationAt: lastEscalation,
    }).from(tasks)
        .innerJoin(companies, eq(companies.id, tasks.companyId))
        .innerJoin(agents, and(
            eq(agents.id, tasks.assignedAgentId),
            eq(agents.companyId, tasks.companyId),
            isNull(agents.deletedAt),
        ))
        .where(and(
            isNull(tasks.deletedAt),
            sql`COALESCE(${companies.agentRoutineJson}->'stallRemindersEnabled', 'true'::jsonb) <> 'false'::jsonb`,
            inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]),
            lt(tasks.updatedAt, cutoff),
            // Abandoned backlog: never nudge/escalate a task older than the horizon.
            gte(tasks.updatedAt, horizonCutoff),
            // Escalation is one-shot; a nudge is due when none has happened yet
            // or the last one is already a full window old.
            sql`${lastEscalation} IS NULL`,
            sql`(${lastNudge} IS NULL OR ${lastNudge} < ${cutoff})`,
        ));

    const recentReminders = await db.select({companyId:threadMessages.companyId,agentId:threadMessages.targetAgentId}).from(threadMessages).where(and(
        gte(threadMessages.createdAt, cutoff), eq(threadMessages.senderType, "system"),
        sql`(${threadMessages.metadataJson}->>'stallNudge' = 'true' OR ${threadMessages.metadataJson}->>'stallEscalation' = 'true')`,
    ));
    const coolingAgents = new Set(recentReminders.filter(row=>row.agentId).map(row=>`${row.companyId}\u0000${row.agentId}`));
    const recentEscalations = await db.select({companyId:taskEvents.companyId}).from(taskEvents).where(and(eq(taskEvents.eventType,STALL_ESCALATION_EVENT),gte(taskEvents.createdAt,cutoff)));
    const coolingCompanies = new Set(recentEscalations.map(row=>row.companyId));

    const nudgeItems: StallGroupItem[] = [];
    const escalateItems: StallGroupItem[] = [];
    const escalateEvents: Array<{ companyId: string; taskId: string }> = [];
    const escalatedByCompany = new Map<string, number>();

    for (const task of rows) {
        if (!task.assignedAgentId) continue;
        const title = taskDisplayTitle(task.inputJson, task.taskType);
        // The SQL filter above guarantees a nudge is due; escalate when a nudge
        // was already sent and a fresh task update has not reset the cycle.
        const stage: StallStage = task.lastNudgeAt === null ? "nudge" : "escalate";

        // Re-check the assignee/state right before posting: a task reassigned or
        // closed between the query and here must not be nudged or escalated.
        const [stillOpen] = await db.select({ state: tasks.state, assignedAgentId: tasks.assignedAgentId, updatedAt: tasks.updatedAt }).from(tasks)
            .where(and(eq(tasks.id, task.id), eq(tasks.companyId, task.companyId), isNull(tasks.deletedAt))).limit(1);
        if (!stillOpen || stillOpen.updatedAt.getTime() !== task.updatedAt.getTime() || stillOpen.assignedAgentId !== task.assignedAgentId || !(SLA_TRACKED_TASK_STATES as readonly string[]).includes(stillOpen.state)) {
            continue;
        }

        if (stage === "nudge") {
            if (coolingAgents.has(`${task.companyId}\u0000${task.assignedAgentId}`)) continue;
            nudgeItems.push({ companyId: task.companyId, targetKey: task.assignedAgentId, id: task.id, title });
            continue;
        }

        if (coolingCompanies.has(task.companyId)) continue;

        // Escalate: tell the project lead agent, else the task's creator agent,
        // and always raise a human notification.
        const [lead] = await db.select({ leadAgentId: projects.leadAgentId }).from(projects)
            .where(and(eq(projects.id, task.projectId), eq(projects.companyId, task.companyId), isNull(projects.deletedAt))).limit(1);
        let escalationTarget: string | null = lead?.leadAgentId ?? null;
        if (!escalationTarget) {
            const [creator] = await db.select({ actorId: taskEvents.actorId, actorType: taskEvents.actorType }).from(taskEvents)
                .where(and(eq(taskEvents.companyId, task.companyId), eq(taskEvents.taskId, task.id), eq(taskEvents.eventType, "task_generated"), eq(taskEvents.actorType, "agent")))
                .orderBy(asc(taskEvents.createdAt)).limit(1);
            escalationTarget = creator?.actorId ?? null;
        }
        if (escalationTarget && coolingAgents.has(`${task.companyId}\u0000${escalationTarget}`)) continue;
        escalateEvents.push({ companyId: task.companyId, taskId: task.id });
        escalatedByCompany.set(task.companyId, (escalatedByCompany.get(task.companyId) ?? 0) + 1);
        if (escalationTarget && escalationTarget !== task.assignedAgentId) {
            escalateItems.push({ companyId: task.companyId, targetKey: escalationTarget, id: task.id, title });
        }
    }

    let acted = 0;

    for (const group of groupStallTasks(nudgeItems).values()) {
        await postNudge(group.companyId, group.targetKey, group.tasks);
        acted += 1;
    }

    for (const group of groupStallTasks(escalateItems).values()) {
        await postEscalation(group.companyId, group.targetKey, group.tasks);
        acted += 1;
    }

    // ONE human notification per company per sweep, instead of one per task.
    for (const [companyId, count] of escalatedByCompany) {
        try {
            await notify(companyId, await companyAdminIds(companyId), {
                kind: "stall",
                title: `${count} task${count === 1 ? "" : "s"} stalled`,
                body: `No update for more than ${hours} hour${hours === 1 ? "" : "s"}.`,
                link: "/projects",
                sourceType: "company",
                sourceId: companyId,
                dedupeKey: `stall-sweep:${companyId}`,
            });
        } catch (error) {
            console.warn("[stall-sweep] human notification failed:", error instanceof Error ? error.message : error);
        }
    }

    // Record the per-task stall events last, so the next sweep's dedupe query
    // sees them (nudge or escalation, regardless of whether a target existed).
    for (const item of nudgeItems) {
        await recordEvent(item.companyId, item.id, STALL_NUDGE_EVENT);
    }
    for (const item of escalateEvents) {
        await recordEvent(item.companyId, item.taskId, STALL_ESCALATION_EVENT);
    }

    return acted;
}
