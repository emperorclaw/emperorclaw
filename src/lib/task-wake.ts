import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, projects, tasks } from "@/db/schema";
import { appendThreadMessage, ensureDirectThread } from "@/lib/control-plane";
import { getAgentScope, getAllowedProjectIds } from "@/lib/agent-scope";
import { SLA_TRACKED_TASK_STATES } from "@/lib/task-state";

/**
 * Wake-on-assignment: when a task's assignee becomes an agent (create with an
 * agent assignee, reassignment, claim, or reopen to a different agent), post a
 * targeted system message to that agent so it starts the work without waiting
 * for a poll or a @mention. Mirrors the pattern already used by approvals
 * (`tellAgentAboutDecision`) and the daily review (`reviewCompany`): a queued
 * system message in the agent's direct thread with `targetAgentId` set.
 *
 * - No wake when an agent assigns a task to itself.
 * - One wake per assignment event: the callers only invoke this on an assignee
 *   CHANGE, so a retried write (which no longer changes the assignee) is a
 *   no-op, and pending items are de-duplicated by task id.
 * - Bursts are coalesced: the first assignment wakes immediately, and further
 *   assignments to the same agent within a short window are queued on the
 *   agent's `metadataJson` and flushed as one message (by the next assignment
 *   past the window, or by the lifecycle monitor).
 */

export const AGENT_WAKE_COALESCE_MS = 60_000;

export type WakeReason = "assigned" | "reassigned" | "claimed" | "reopened";

export interface WakeTaskSummary {
    id: string;
    title: string;
    projectName: string;
    state: string;
    assignedBy: string;
    acceptanceCriteria: string | null;
}

/** Prompt text that came from task data is collapsed and capped, so a hostile or
 *  enormous title/criteria cannot inject instructions into the agent's prompt. */
const MAX_PROMPT_TEXT_CHARS = 120;

export function sanitizePromptText(value: string): string {
    const clean = value.replace(/\s+/g, " ").trim();
    return clean.length > MAX_PROMPT_TEXT_CHARS ? `${clean.slice(0, MAX_PROMPT_TEXT_CHARS - 1)}…` : clean;
}

export function taskTitle(task: { taskType: string; inputJson: unknown }): string {
    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : task.taskType;
}

export function taskAcceptanceCriteria(task: { inputJson: unknown }): string | null {
    const input = task.inputJson && typeof task.inputJson === "object" ? task.inputJson as Record<string, unknown> : {};
    const raw = [input.acceptanceCriteria, input.acceptance_criteria, input.acceptance, input.criteria, input.description]
        .find((value) => typeof value === "string" && value.trim()) as string | undefined;
    if (!raw) return null;
    return sanitizePromptText(raw);
}

/** The system message an agent receives. Pure, so it is unit-tested. */
export function taskAssignedWakeText(items: WakeTaskSummary[]): string {
    const clean = (value: string) => sanitizePromptText(value).replace(/[[\]]/g, "");
    if (items.length === 1) {
        const [t] = items;
        const lines = [
            `New task assigned to you: [${clean(t.title)}](emperor://task/${t.id})`,
            `- Project: "${clean(t.projectName)}"`,
            `- State: ${clean(t.state).replace(/_/g, " ")}`,
            `- Assigned by: "${clean(t.assignedBy)}"`,
        ];
        if (t.acceptanceCriteria) lines.push(`- Acceptance criteria: "${clean(t.acceptanceCriteria)}"`);
        lines.push("What to do next: set it in_progress when you start, keep a note as you go, and close it only when the acceptance criteria are met.");
        return lines.join("\n");
    }
    const header = `Tasks assigned to you (${items.length}):`;
    const rows = items.map((t, i) => ` ${i + 1}. [${clean(t.title)}](emperor://task/${t.id}) — "${clean(t.projectName)}" (${clean(t.state).replace(/_/g, " ")})`);
    return [header, "", ...rows, "", "For each: set it in_progress when you start, keep a note as you go, and close it only when its acceptance criteria are met."].join("\n");
}

/** A scope-redacted wake: no title/criteria/project, just the task id link. */
export function minimalWakeText(items: WakeTaskSummary[]): string {
    const links = items.map((i) => `[task](emperor://task/${i.id})`).join(", ");
    return `A task was assigned to you (${links}). Open it to see the details.`;
}

/** A scope-redacted item has no title (its details were withheld). */
function isRedacted(item: WakeTaskSummary): boolean {
    return !item.title;
}

/**
 * One message for a (possibly mixed) batch: items with a title render in full,
 * scope-redacted items render as a bare task link. Never emits an empty
 * `[](emperor://task/…)` line.
 */
export function wakeBatchText(items: WakeTaskSummary[]): string {
    if (items.length === 0) return "";
    const clean = (value: string) => sanitizePromptText(value).replace(/[[\]]/g, "");
    const allNormal = items.every((item) => !isRedacted(item));
    if (allNormal) return taskAssignedWakeText(items);
    if (items.length === 1) return minimalWakeText(items);
    const header = `Tasks assigned to you (${items.length}):`;
    const rows = items.map((item, i) => isRedacted(item)
        ? ` ${i + 1}. [task](emperor://task/${item.id})`
        : ` ${i + 1}. [${clean(item.title)}](emperor://task/${item.id}) — "${clean(item.projectName)}" (${clean(item.state).replace(/_/g, " ")})`);
    return [header, "", ...rows, "", "For each: set it in_progress when you start, keep a note as you go, and close it only when its acceptance criteria are met."].join("\n");
}

/**
 * The coalescing decision, extracted so it is unit-tested directly: the first
 * assignment inside the window is queued; an assignment after the window (or
 * with no prior wake) flushes everything queued plus itself in one message.
 */
export interface WakeCoalesceResult {
    action: "queue" | "flush";
    /** The pending queue AFTER this assignment. */
    pending: WakeTaskSummary[];
    /** The batch to send, only when `action === "flush"`. */
    toSend?: WakeTaskSummary[];
}

export function decideWakeCoalescing(input: {
    nowMs: number;
    lastWakeAt: number;
    windowMs: number;
    pending: WakeTaskSummary[];
    task: WakeTaskSummary;
}): WakeCoalesceResult {
    const without = input.pending.filter((p) => p.id !== input.task.id);
    if (input.nowMs - input.lastWakeAt < input.windowMs) {
        return { action: "queue", pending: [...without, input.task] };
    }
    return { action: "flush", pending: [], toSend: [...without, input.task] };
}

/** Drop queued tasks that are no longer assigned to this agent and still open. */
export function filterPendingStillOpen(pending: WakeTaskSummary[], stillOpenIds: ReadonlySet<string>): WakeTaskSummary[] {
    return pending.filter((p) => stillOpenIds.has(p.id));
}

interface AgentWakeState {
    lastWakeAt: number;
    pending: WakeTaskSummary[];
}

function readAgentWakeState(metadataJson: unknown): AgentWakeState | null {
    if (!metadataJson || typeof metadataJson !== "object") return null;
    const raw = (metadataJson as Record<string, unknown>).agentWake;
    if (!raw || typeof raw !== "object") return null;
    const candidate = raw as { lastWakeAt?: unknown; pending?: unknown };
    if (typeof candidate.lastWakeAt !== "number" || !Array.isArray(candidate.pending)) return null;
    return { lastWakeAt: candidate.lastWakeAt, pending: candidate.pending as WakeTaskSummary[] };
}

async function postWakeMessage(companyId: string, agentId: string, items: WakeTaskSummary[], reason: WakeReason): Promise<void> {
    const thread = await ensureDirectThread(companyId, agentId, null);
    await appendThreadMessage({
        companyId,
        threadId: thread.id,
        senderType: "system",
        targetAgentId: agentId,
        text: wakeBatchText(items),
        deliveryState: "queued",
        metadataJson: { taskAssigned: true, taskIds: items.map((i) => i.id), reason },
    });
}

/** Put a failed batch back on the agent's pending queue so it isn't lost. */
async function requeueAgentWakes(companyId: string, agentId: string, items: WakeTaskSummary[]): Promise<void> {
    try {
        // lastWakeAt is dropped, so the next flush (or monitor tick) treats the
        // batch as long-overdue and posts it again rather than losing it.
        await db.execute(sql`
            UPDATE agents
            SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || ${JSON.stringify({ agentWake: { pending: items } })}::jsonb
            WHERE id = ${agentId} AND company_id = ${companyId}
        `);
    } catch (error) {
        console.warn("[task-wake] could not re-queue a failed wake:", error instanceof Error ? error.message : error);
    }
}

async function agentName(companyId: string, agentId: string): Promise<string> {
    const [agent] = await db.select({ name: agents.name }).from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
    return agent?.name ?? "an agent";
}

/** Resolve a task's project display name (goal). */
async function projectName(companyId: string, projectId: string): Promise<string> {
    const [project] = await db.select({ goal: projects.goal }).from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId))).limit(1);
    return project?.goal ?? "this project";
}

/** The still-open tasks, from `pending`, that remain assigned to `agentId`. */
async function stillOpenPendingTaskIds(companyId: string, agentId: string, pending: WakeTaskSummary[]): Promise<Set<string>> {
    const ids = pending.map((p) => p.id);
    if (ids.length === 0) return new Set();
    const rows = await db.select({ id: tasks.id }).from(tasks).where(and(
        eq(tasks.companyId, companyId),
        eq(tasks.assignedAgentId, agentId),
        inArray(tasks.id, ids),
        isNull(tasks.deletedAt),
        inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]),
    ));
    return new Set(rows.map((r) => r.id));
}

export interface WakeAssignmentInput {
    companyId: string;
    task: typeof tasks.$inferSelect;
    /** The agent that caused the change; skipped when it is the new assignee. */
    actorAgentId?: string | null;
    reason: WakeReason;
    assignedByLabel?: string | null;
}

/**
 * Post (or queue) the targeted wake for a task that just got an agent assignee.
 * The wake-state read/modify/write is serialized per agent with an advisory
 * lock and merged via jsonb `||`, so concurrent assignments neither clobber the
 * queue nor overwrite unrelated `metadata_json` keys. Never throws.
 */
export async function wakeAgentOnTaskAssignment(input: WakeAssignmentInput): Promise<void> {
    const { companyId, task, reason } = input;
    const assigneeId = task.assignedAgentId;
    if (!assigneeId) return;
    if (assigneeId === input.actorAgentId) return;
    try {
        const now = Date.now();
        const [assignedBy, project, scopeContext] = await Promise.all([
            input.assignedByLabel ?? (input.actorAgentId ? agentName(companyId, input.actorAgentId) : "a teammate"),
            projectName(companyId, task.projectId),
            (async () => {
                const scope = await getAgentScope(companyId, assigneeId);
                return getAllowedProjectIds(companyId, scope);
            })(),
        ]);
        const inScope = scopeContext === null || scopeContext.has(task.projectId);
        const summary: WakeTaskSummary = inScope
            ? {
                id: task.id,
                title: taskTitle(task),
                projectName: project,
                state: task.state,
                assignedBy,
                acceptanceCriteria: taskAcceptanceCriteria(task),
            }
            : { id: task.id, title: "", projectName: "", state: "", assignedBy: "", acceptanceCriteria: null };

        const { action, toSend } = await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-wake:${companyId}:${assigneeId}`}))`);
            const [agent] = await tx.select({ id: agents.id, metadataJson: agents.metadataJson }).from(agents)
                .where(and(eq(agents.id, assigneeId), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
            if (!agent) return { action: "flush" as const, pending: [] as WakeTaskSummary[], toSend: [] as WakeTaskSummary[] };

            const current = readAgentWakeState(agent.metadataJson);
            const lastWakeAt = current?.lastWakeAt ?? 0;
            const decision = decideWakeCoalescing({
                nowMs: now,
                lastWakeAt,
                windowMs: AGENT_WAKE_COALESCE_MS,
                pending: current?.pending ?? [],
                task: summary,
            });

            await tx.execute(sql`
                UPDATE agents
                SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || ${JSON.stringify({ agentWake: { lastWakeAt: decision.action === "queue" ? lastWakeAt : now, pending: decision.pending } })}::jsonb
                WHERE id = ${assigneeId} AND company_id = ${companyId}
            `);

            return decision;
        });

        if (action === "flush" && toSend && toSend.length > 0) {
            // Drop queued tasks that are no longer assigned/open before posting.
            const stillOpen = await stillOpenPendingTaskIds(companyId, assigneeId, toSend);
            const live = filterPendingStillOpen(toSend, stillOpen);
            if (live.length > 0) {
                try {
                    await postWakeMessage(companyId, assigneeId, live, reason);
                } catch (error) {
                    console.warn("[task-wake] wake post failed; re-queueing:", error instanceof Error ? error.message : error);
                    await requeueAgentWakes(companyId, assigneeId, live);
                }
            }
        }
    } catch (error) {
        console.warn("[task-wake] could not wake the assignee:", error instanceof Error ? error.message : error);
    }
}

/** Flush queued wakes that never got a follow-up assignment (called by the monitor). */
export async function flushPendingAgentWakes(now = new Date()): Promise<number> {
    const nowMs = now.getTime();
    // Only agents with a non-empty pending queue are candidates (SQL filter, so
    // the monitor never loads every agent).
    const rows = await db.select({ id: agents.id, companyId: agents.companyId, metadataJson: agents.metadataJson }).from(agents)
        .where(and(
            isNull(agents.deletedAt),
            sql`${agents.metadataJson}->'agentWake'->'pending' <> '[]'::jsonb`,
        ));
    let sent = 0;
    for (const agent of rows) {
        try {
            const posted = await db.transaction(async (tx) => {
                await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-wake:${agent.companyId}:${agent.id}`}))`);
                const [fresh] = await tx.select({ metadataJson: agents.metadataJson }).from(agents)
                    .where(eq(agents.id, agent.id)).limit(1);
                const current = readAgentWakeState(fresh?.metadataJson);
                if (!current || current.pending.length === 0) return null;
                if (nowMs - current.lastWakeAt < AGENT_WAKE_COALESCE_MS) return null;

                const stillOpen = await stillOpenPendingTaskIds(agent.companyId, agent.id, current.pending);
                const live = filterPendingStillOpen(current.pending, stillOpen);

                await tx.execute(sql`
                    UPDATE agents
                    SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || ${JSON.stringify({ agentWake: { lastWakeAt: nowMs, pending: [] } })}::jsonb
                    WHERE id = ${agent.id} AND company_id = ${agent.companyId}
                `);

                return live;
            });

            if (posted && posted.length > 0) {
                try {
                    await postWakeMessage(agent.companyId, agent.id, posted, "assigned");
                    sent += 1;
                } catch (error) {
                    console.warn("[task-wake] flush post failed; re-queueing:", error instanceof Error ? error.message : error);
                    await requeueAgentWakes(agent.companyId, agent.id, posted);
                }
            }
        } catch (error) {
            console.warn("[task-wake] flush failed:", error instanceof Error ? error.message : error);
        }
    }
    return sent;
}
