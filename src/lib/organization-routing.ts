import { and, asc, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, messageThreads, projects, taskEvents, tasks, threadMessages } from "@/db/schema";
import { appendThreadMessage, ensureDirectThread } from "@/lib/control-plane";
import { mcpAccessForAgent, mcpMayReachAgent, mcpMayUseProject } from "@/lib/mcp-access";
import { isOrganizationConfigured, loadOrganizationCached, organizationNames } from "@/lib/organization";
import { organizationBriefing, pickChartManager, type OrgPerson } from "@/lib/organization-briefing";
import { TASK_STATES } from "@/lib/task-state";
import { quotedPromptText, sanitizePromptText, taskTitle } from "@/lib/task-wake";

/**
 * Work flows up the org chart. When an agent sets a task done or blocked, its
 * chart manager for the task's team is told once per state change, with a
 * short note; the stall sweep escalates to that manager first. This routes and
 * informs only: it never blocks or reassigns, and reporting lines grant no
 * permission.
 */

type LoadedOrganization = Awaited<ReturnType<typeof loadOrganizationCached>>;
type TaskRow = typeof tasks.$inferSelect;
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A second report for the same task and state inside this window is a retry, not news. */
export const ORG_REPORT_DEDUPE_MS = 10 * 60_000;
/** At most one report per manager per window wakes it; later ones wait quietly in its chat. */
export const ORG_REPORT_WAKE_WINDOW_MS = 15 * 60_000;
const DETAIL_MAX_CHARS = 300;

/** The agent that created the task (its first task_generated event), if an agent did. */
export async function taskCreatorAgentId(companyId: string, taskId: string): Promise<string | null> {
    const [creator] = await db.select({ actorId: taskEvents.actorId }).from(taskEvents)
        .where(and(eq(taskEvents.companyId, companyId), eq(taskEvents.taskId, taskId), eq(taskEvents.eventType, "task_generated"), eq(taskEvents.actorType, "agent")))
        .orderBy(asc(taskEvents.createdAt)).limit(1);
    return creator?.actorId ?? null;
}

/**
 * The chart teams a task belongs to, most specific first: a team group linked
 * to its project, then teams of the project lead, then of the task's creator.
 * There is no project→team field, so these are the signals the data has.
 */
export async function taskContextTeamIds(companyId: string, task: Pick<TaskRow, "id" | "projectId">, org: LoadedOrganization, creatorAgentId?: string | null): Promise<string[]> {
    const chartTeams = new Set(org.teams.map((team) => team.id));
    if (!chartTeams.size) return [];
    const [linked, [project], creator] = await Promise.all([
        db.select({ id: messageThreads.id }).from(messageThreads).where(and(eq(messageThreads.companyId, companyId), eq(messageThreads.projectId, task.projectId), eq(messageThreads.type, "group"), isNull(messageThreads.archivedAt))),
        db.select({ leadAgentId: projects.leadAgentId }).from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, companyId))).limit(1),
        creatorAgentId !== undefined ? Promise.resolve(creatorAgentId) : taskCreatorAgentId(companyId, task.id),
    ]);
    const teamsOf = (agentId: string | null | undefined) => agentId ? org.teams.filter((team) => team.members.some((m) => m.kind === "agent" && m.id === agentId)).map((team) => team.id) : [];
    return [...new Set([...linked.map((row) => row.id).filter((id) => chartTeams.has(id)), ...teamsOf(project?.leadAgentId), ...teamsOf(creator)])];
}

/**
 * An agent's chart manager for this task's team (else its first reporting
 * line), or null. Only live managers count: a deleted agent still on the chart
 * is skipped, so callers fall back to the project lead or the creator.
 */
export async function chartManagerForTask(companyId: string, agentId: string, task: Pick<TaskRow, "id" | "projectId">, options: { org?: LoadedOrganization; creatorAgentId?: string | null } = {}): Promise<OrgPerson | null> {
    if (!options.org && !(await isOrganizationConfigured(companyId))) return null;
    const org = options.org ?? await loadOrganizationCached(companyId);
    if (!org.configured) return null;
    const briefing = organizationBriefing(org.leader, org.teams, agentId, org.config.nodes, organizationNames(org));
    const live = briefing.managers.filter(({ manager }) => manager.kind === "human" ? org.people.some((p) => p.id === manager.id) : org.roster.some((a) => a.id === manager.id));
    if (!live.length) return null;
    return pickChartManager(live, await taskContextTeamIds(companyId, task, org, options.creatorAgentId));
}

/** The message a chart manager gets. Pure, so it is unit-tested; task text is quoted, never instructions. */
export function managerReportText(input: { taskId: string; title: string; projectName: string; workerName: string; state: "done" | "blocked"; detail: string | null; redacted?: boolean; quietSince?: number }): string {
    const quiet = input.quietSince ? [`Also waiting in this chat: ${input.quietSince} earlier org chart report${input.quietSince === 1 ? "" : "s"}.`] : [];
    if (input.redacted) return [`Org chart report: a task of someone who reports to you is now ${input.state} ([task](emperor://task/${input.taskId})). Open it for the details.`, ...quiet].join("\n");
    const clean = (value: string) => sanitizePromptText(value).replace(/[[\]]/g, "");
    const lines = [
        `Org chart report: "${quotedPromptText(input.workerName)}" set [${clean(input.title)}](emperor://task/${input.taskId}) to ${input.state}.`,
        `- Project: "${quotedPromptText(input.projectName)}"`,
    ];
    if (input.detail) lines.push(`- ${input.state === "blocked" ? "Blocker" : "Handoff"}: "${quotedPromptText(input.detail.slice(0, DETAIL_MAX_CHARS))}"`);
    lines.push(input.state === "blocked"
        ? "You are their manager for this work: unblock it, reassign it, or escalate up your chain. Reply on the task, not here; no acknowledgement is needed."
        : "You are their manager for this work: review it if needed and report upward only when it matters to your own manager. No acknowledgement is needed.");
    return [...lines, ...quiet].join("\n");
}

/** Who must not get the report: the actor, people already on the task, humans. Pure. */
export function shouldReportToManager(manager: OrgPerson | null, skip: { actorAgentId: string | null; assigneeAgentId: string | null; creatorAgentId: string | null }): manager is OrgPerson {
    if (!manager || manager.kind !== "agent") return false;
    return manager.id !== skip.actorAgentId && manager.id !== skip.assigneeAgentId && manager.id !== skip.creatorAgentId;
}

/** Wake now, or post quietly: only the first report per manager inside the window wakes it. Pure. */
export function reportShouldWake(lastWakingAtMs: number | null, nowMs: number, windowMs = ORG_REPORT_WAKE_WINDOW_MS): boolean {
    return lastWakingAtMs === null || nowMs - lastWakingAtMs >= windowMs;
}

export type TaskOutcomeReport = { companyId: string; task: TaskRow; previousState: string; actorAgentId: string | null; detail?: string | null };

const inFlight = new Set<Promise<void>>();

/**
 * Report off the request path: the task change already committed, so a slow
 * or failing report never delays or fails it. Errors are logged inside.
 */
export function queueTaskOutcomeReport(input: TaskOutcomeReport): void {
    const state = input.task.state;
    if ((state !== TASK_STATES.done && state !== TASK_STATES.blocked) || input.previousState === state || !input.actorAgentId) return;
    const job = reportTaskOutcomeToManager(input).finally(() => inFlight.delete(job));
    inFlight.add(job);
}

/** Wait for queued reports (tests, graceful shutdown). */
export async function settleTaskOutcomeReports(): Promise<void> {
    while (inFlight.size) await Promise.allSettled([...inFlight]);
}

/**
 * Tell the acting agent's chart manager that a task became done or blocked. Called
 * only on that state transition, by an agent. Skipped when the manager is the
 * actor, the assignee or the task's creator (they already know), or a human
 * (people keep the inbox and notifications), and for a repeat of the same
 * report within ORG_REPORT_DEDUPE_MS. Only the first report per manager in
 * ORG_REPORT_WAKE_WINDOW_MS wakes it; later ones are posted to its chat
 * without waking it and are counted in its next waking report. A manager who
 * cannot see the project gets only the link; one who cannot reach the worker
 * does not get the worker's name. Never throws.
 */
export async function reportTaskOutcomeToManager(input: TaskOutcomeReport): Promise<void> {
    const { companyId, task } = input;
    const state = task.state === TASK_STATES.done ? "done" : task.state === TASK_STATES.blocked ? "blocked" : null;
    if (!state || input.previousState === task.state || !input.actorAgentId) return;
    // The agent that made the change is the one reporting up its own line.
    const workerId = input.actorAgentId;
    try {
        if (!(await isOrganizationConfigured(companyId))) return;
        const creatorAgentId = await taskCreatorAgentId(companyId, task.id);
        const manager = await chartManagerForTask(companyId, workerId, task, { org: await loadOrganizationCached(companyId), creatorAgentId });
        if (!shouldReportToManager(manager, { actorAgentId: input.actorAgentId, assigneeAgentId: task.assignedAgentId, creatorAgentId })) return;
        const [access, [project], [worker], detail] = await Promise.all([
            mcpAccessForAgent(companyId, manager.id),
            db.select({ goal: projects.goal }).from(projects).where(and(eq(projects.id, task.projectId), eq(projects.companyId, companyId))).limit(1),
            db.select({ name: agents.name }).from(agents).where(and(eq(agents.id, workerId), eq(agents.companyId, companyId))).limit(1),
            input.detail !== undefined ? Promise.resolve(input.detail) : taskOutcomeDetail(companyId, task, state),
        ]);
        // One manager at a time: the dedupe and wake checks and the post are atomic.
        await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`org-report:${companyId}:${manager.id}`}))`);
            const recent = await tx.select({ createdAt: threadMessages.createdAt, deliveryState: threadMessages.deliveryState, metadataJson: threadMessages.metadataJson }).from(threadMessages).where(and(
                eq(threadMessages.companyId, companyId),
                eq(threadMessages.targetAgentId, manager.id),
                gte(threadMessages.createdAt, new Date(Date.now() - Math.max(ORG_REPORT_DEDUPE_MS, ORG_REPORT_WAKE_WINDOW_MS))),
                sql`${threadMessages.metadataJson}->>'orgReport' = 'true'`,
            )).orderBy(desc(threadMessages.createdAt));
            const meta = (row: (typeof recent)[number]) => (row.metadataJson ?? {}) as Record<string, unknown>;
            if (recent.some((row) => meta(row).taskId === task.id && meta(row).state === state && Date.now() - row.createdAt.getTime() < ORG_REPORT_DEDUPE_MS)) return;
            const lastWaking = recent.find((row) => meta(row).wakes === true);
            const wake = reportShouldWake(lastWaking ? lastWaking.createdAt.getTime() : null, Date.now());
            const quietSince = wake ? await countQuietReports(companyId, manager.id, tx) : 0;
            const text = managerReportText({
                taskId: task.id,
                title: taskTitle(task),
                projectName: project?.goal ?? "this project",
                workerName: mcpMayReachAgent(access, workerId) ? worker?.name ?? "A teammate" : "A teammate",
                state,
                detail: detail?.trim() || null,
                redacted: !mcpMayUseProject(access, task.projectId),
                quietSince,
            });
            const thread = await ensureDirectThread(companyId, manager.id, null, tx);
            await appendThreadMessage({
                companyId,
                threadId: thread.id,
                senderType: "system",
                targetAgentId: manager.id,
                text,
                // "queued" wakes the manager; "resolved" is already handled, so it waits in the chat.
                deliveryState: wake ? "queued" : "resolved",
                metadataJson: { orgReport: true, taskId: task.id, state, reportedBy: workerId, wakes: wake },
            }, tx);
        });
    } catch (error) {
        console.warn("[org-report] could not tell the chart manager:", error instanceof Error ? error.message : error);
    }
}

/** Quiet reports since the manager's last waking one (the next waking report mentions them). */
async function countQuietReports(companyId: string, managerId: string, executor: typeof db | Tx = db): Promise<number> {
    const [lastWaking] = await executor.select({ createdAt: threadMessages.createdAt }).from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId), eq(threadMessages.targetAgentId, managerId),
        sql`${threadMessages.metadataJson}->>'orgReport' = 'true'`, sql`${threadMessages.metadataJson}->>'wakes' = 'true'`,
    )).orderBy(desc(threadMessages.createdAt)).limit(1);
    const [row] = await executor.select({ count: sql<number>`count(*)::int` }).from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId), eq(threadMessages.targetAgentId, managerId),
        sql`${threadMessages.metadataJson}->>'orgReport' = 'true'`, sql`${threadMessages.metadataJson}->>'wakes' = 'false'`,
        ...(lastWaking ? [gte(threadMessages.createdAt, lastWaking.createdAt)] : []),
    ));
    return Number(row?.count ?? 0);
}

/** The blocker reason, else the latest task note: what the manager needs to act on. */
async function taskOutcomeDetail(companyId: string, task: TaskRow, state: "done" | "blocked"): Promise<string | null> {
    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
    if (state === "blocked" && typeof input.blockedReason === "string" && input.blockedReason.trim()) return input.blockedReason;
    const [note] = await db.select({ payload: taskEvents.payloadJson }).from(taskEvents)
        .where(and(eq(taskEvents.companyId, companyId), eq(taskEvents.taskId, task.id), inArray(taskEvents.eventType, ["task_note", "task_handoff"])))
        .orderBy(desc(taskEvents.createdAt)).limit(1);
    const text = note?.payload && typeof note.payload === "object" ? (note.payload as Record<string, unknown>).note : null;
    return typeof text === "string" ? text : null;
}

/**
 * Who a stalled task escalates to, in order: the assignee's chart manager
 * (an agent that may see the project), the project lead, the task's creator.
 * Never the assignee itself; a human is always notified separately. Pure.
 */
export function stallEscalationTarget(candidates: readonly (string | null | undefined)[], assigneeAgentId: string): string | null {
    return candidates.find((id): id is string => Boolean(id) && id !== assigneeAgentId) ?? null;
}

/** The chart manager to escalate a stalled task to, only when it may see the task's project. */
export async function stallChartManager(companyId: string, task: Pick<TaskRow, "id" | "projectId">, assigneeAgentId: string, options: { org: LoadedOrganization; creatorAgentId: string | null }): Promise<string | null> {
    const manager = await chartManagerForTask(companyId, assigneeAgentId, task, options);
    if (manager?.kind !== "agent") return null;
    return mcpMayUseProject(await mcpAccessForAgent(companyId, manager.id), task.projectId) ? manager.id : null;
}
