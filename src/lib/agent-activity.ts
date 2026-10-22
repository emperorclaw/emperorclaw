import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, agents, messageThreads, tasks, threadMessages, threadParticipants } from "@/db/schema";
import { OFFLINE_AFTER_MS } from "@/lib/agent-health";
import { taskTitle } from "@/lib/emperor-entities";
import { deriveLiveState, toPlainText, type LiveState } from "@/lib/live-feed";
import { TASK_STATES } from "@/lib/task-state";

/**
 * "What is each agent doing right now" for the web app: one snapshot per
 * agent joining the live status line, the open run in the run ledger, the
 * claimed task, the last finished run and the agent's last visible message.
 *
 * Unlike the live feed (a firmware contract for physical screens) this is
 * built for a signed-in member, so privacy follows the viewer: activity and
 * messages from team and group threads are visible, and so are those from
 * threads the viewer takes part in. Anything else only says the agent is busy
 * in a private chat.
 */

const PUBLIC_THREAD_TYPES = ["team", "group"] as const;
export const PRIVATE_ACTIVITY = "Working in a private chat";
const ACTIVITY_MAX = 200;
const MESSAGE_MAX = 160;
/** Last finished run and last message are only looked for this far back. */
const RECENT_MS = 30 * 24 * 60 * 60 * 1000;

export interface AgentNow {
    agentId: string;
    state: LiveState;
    /** The bridge's live status line (current tool, "thinking: …", elapsed time). */
    activity: string | null;
    /** The thread the agent is typing in, when the viewer may open it. */
    activityThreadId: string | null;
    /** The open run in the run ledger, if any. */
    run: {
        id: string;
        startedAt: string;
        triggerKind: string;
        taskId: string | null;
        threadId: string | null;
        runtimeKind: string | null;
    } | null;
    task: { id: string; title: string } | null;
    lastRun: {
        id: string;
        status: string;
        startedAt: string;
        endedAt: string | null;
        durationMs: number | null;
        tokens: number | null;
        costCents: number | null;
        toolCalls: number | null;
        error: string | null;
    } | null;
    lastMessage: { threadId: string; text: string; createdAt: string } | null;
    lastSeenAt: string | null;
}

export interface TypingRow {
    agentId: string;
    threadId: string;
    threadType: string;
    typingUntil: Date;
    activity: string | null;
}

/**
 * Pick each agent's freshest status line, redacting threads the viewer may
 * not see. A row with text wins over a bare typing row; otherwise the later
 * typingUntil wins.
 */
export function pickActivity(rows: readonly TypingRow[], viewerThreadIds: ReadonlySet<string>): Map<string, { activity: string | null; threadId: string | null; until: number }> {
    const out = new Map<string, { activity: string | null; threadId: string | null; until: number }>();
    for (const row of rows) {
        const visible = (PUBLIC_THREAD_TYPES as readonly string[]).includes(row.threadType) || viewerThreadIds.has(row.threadId);
        const raw = row.activity?.trim() ? row.activity.trim() : null;
        const activity = raw ? (visible ? raw.slice(0, ACTIVITY_MAX) : PRIVATE_ACTIVITY) : null;
        const until = row.typingUntil.getTime();
        const current = out.get(row.agentId);
        if (!current || (activity && !current.activity) || (Boolean(activity) === Boolean(current.activity) && until > current.until)) {
            out.set(row.agentId, { activity, threadId: visible ? row.threadId : null, until });
        }
    }
    return out;
}

export const PRIVATE_RUN_ERROR = "Run failed";

/** Whether the viewer may see a thread: public types, or one they take part in. */
export function threadVisibleToViewer(threadId: string | null, threadType: string | null | undefined, viewerThreadIds: ReadonlySet<string>): boolean {
    if (!threadId) return true;
    if (threadType && (PUBLIC_THREAD_TYPES as readonly string[]).includes(threadType)) return true;
    return viewerThreadIds.has(threadId);
}

/**
 * Redact the run fields that leak a private thread: its id (on the open run)
 * and the raw error text (on the last run, which can quote the conversation).
 */
export function redactRunForViewer<T extends { threadId: string | null; error?: string | null }>(run: T, visible: boolean): T {
    if (visible) return run;
    return { ...run, threadId: null, ...(run.error != null ? { error: PRIVATE_RUN_ERROR } : {}) };
}

/** Threads the viewer may read: public types, or ones they participate in (SQL predicate on message_threads). */
function viewerCanSee(viewerUserId: string | null) {
    const isPublic = inArray(messageThreads.type, [...PUBLIC_THREAD_TYPES]);
    if (!viewerUserId) return isPublic;
    return or(isPublic, sql`exists (
        select 1 from ${threadParticipants} vp
        where vp.thread_id = ${messageThreads.id}
          and vp.participant_type = 'human'
          and vp.participant_ref = ${viewerUserId}
    )`)!;
}

export async function loadAgentActivity(companyId: string, options: {
    viewerUserId: string | null;
    /** Restrict to these agents (member scope); undefined = all company agents. */
    agentIds?: readonly string[];
    now?: Date;
}): Promise<AgentNow[]> {
    const now = options.now ?? new Date();
    const recentSince = new Date(now.getTime() - RECENT_MS);

    const agentConds = [eq(agents.companyId, companyId), isNull(agents.deletedAt)];
    if (options.agentIds) {
        if (options.agentIds.length === 0) return [];
        agentConds.push(inArray(agents.id, [...options.agentIds]));
    }
    const agentRows = await db.select({ id: agents.id, lastSeenAt: agents.lastSeenAt }).from(agents).where(and(...agentConds));
    if (agentRows.length === 0) return [];
    const ids = agentRows.map((a) => a.id);

    const [typingRows, runningRows, lastRunRows, taskRows, messageRows] = await Promise.all([
        db.select({
            agentId: threadParticipants.participantId,
            threadId: threadParticipants.threadId,
            threadType: messageThreads.type,
            typingUntil: threadParticipants.typingUntil,
            activity: threadParticipants.currentActivity,
        }).from(threadParticipants)
            .innerJoin(messageThreads, eq(messageThreads.id, threadParticipants.threadId))
            .where(and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                inArray(threadParticipants.participantId, ids),
                gt(threadParticipants.typingUntil, now),
            )),
        db.selectDistinctOn([agentRuns.agentId], {
            id: agentRuns.id,
            agentId: agentRuns.agentId,
            startedAt: agentRuns.startedAt,
            triggerKind: agentRuns.triggerKind,
            taskId: agentRuns.taskId,
            threadId: agentRuns.threadId,
            runtimeKind: agentRuns.runtimeKind,
        }).from(agentRuns)
            .where(and(eq(agentRuns.companyId, companyId), inArray(agentRuns.agentId, ids), eq(agentRuns.status, "running")))
            .orderBy(agentRuns.agentId, desc(agentRuns.startedAt)),
        db.selectDistinctOn([agentRuns.agentId], {
            id: agentRuns.id,
            agentId: agentRuns.agentId,
            status: agentRuns.status,
            startedAt: agentRuns.startedAt,
            endedAt: agentRuns.endedAt,
            durationMs: agentRuns.durationMs,
            inputTokens: agentRuns.inputTokens,
            outputTokens: agentRuns.outputTokens,
            costCents: agentRuns.costCents,
            toolCalls: agentRuns.toolCalls,
            error: agentRuns.error,
            threadId: agentRuns.threadId,
        }).from(agentRuns)
            .where(and(
                eq(agentRuns.companyId, companyId),
                inArray(agentRuns.agentId, ids),
                ne(agentRuns.status, "running"),
                gt(agentRuns.startedAt, recentSince),
            ))
            .orderBy(agentRuns.agentId, desc(agentRuns.startedAt)),
        db.selectDistinctOn([tasks.assignedAgentId], {
            id: tasks.id,
            agentId: tasks.assignedAgentId,
            title: sql<string | null>`${tasks.inputJson}->>'title'`,
            taskType: tasks.taskType,
        }).from(tasks)
            .where(and(
                eq(tasks.companyId, companyId),
                isNull(tasks.deletedAt),
                eq(tasks.state, TASK_STATES.inProgress),
                inArray(tasks.assignedAgentId, ids),
            ))
            .orderBy(tasks.assignedAgentId, desc(tasks.priority), desc(tasks.updatedAt)),
        db.selectDistinctOn([threadMessages.senderId], {
            agentId: threadMessages.senderId,
            threadId: threadMessages.threadId,
            text: sql<string>`left(${threadMessages.text}, 2000)`,
            createdAt: threadMessages.createdAt,
        }).from(threadMessages)
            .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
            .where(and(
                eq(threadMessages.companyId, companyId),
                eq(threadMessages.senderType, "agent"),
                inArray(threadMessages.senderId, ids),
                gt(threadMessages.createdAt, recentSince),
                sql`(${threadMessages.metadataJson} -> 'runtimeControl') is null`,
                viewerCanSee(options.viewerUserId),
            ))
            .orderBy(threadMessages.senderId, desc(threadMessages.createdAt)),
    ]);

    // One lookup for every thread referenced by typing rows and runs: its type
    // and whether the viewer takes part in it (humans are keyed by participant_ref).
    const threadIds = [...new Set([
        ...typingRows.map((r) => r.threadId),
        ...runningRows.map((r) => r.threadId),
        ...lastRunRows.map((r) => r.threadId),
    ].filter((id): id is string => Boolean(id)))];
    const viewerThreadIds = new Set<string>();
    const threadTypes = new Map<string, string>();
    if (threadIds.length > 0) {
        const viewerUserId = options.viewerUserId;
        const threads = await db.select({
            id: messageThreads.id,
            type: messageThreads.type,
            mine: viewerUserId
                ? sql<boolean>`exists (
                    select 1 from ${threadParticipants} vp
                    where vp.thread_id = ${messageThreads.id}
                      and vp.participant_type = 'human'
                      and vp.participant_ref = ${viewerUserId}
                )`
                : sql<boolean>`false`,
        }).from(messageThreads).where(and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, threadIds)));
        for (const t of threads) {
            threadTypes.set(t.id, t.type);
            if (t.mine) viewerThreadIds.add(t.id);
        }
    }
    const runVisible = (threadId: string | null) => threadVisibleToViewer(threadId, threadId ? threadTypes.get(threadId) : null, viewerThreadIds);
    const live = pickActivity(
        typingRows.flatMap((r) => (r.agentId && r.typingUntil ? [{ agentId: r.agentId, threadId: r.threadId, threadType: r.threadType, typingUntil: r.typingUntil, activity: r.activity }] : [])),
        viewerThreadIds,
    );

    const running = new Map(runningRows.map((r) => [r.agentId!, r]));
    const lastRuns = new Map(lastRunRows.map((r) => [r.agentId!, r]));
    const taskByAgent = new Map(taskRows.map((t) => [t.agentId!, t]));
    const lastMessages = new Map(messageRows.map((m) => [m.agentId!, m]));

    return agentRows.map((a): AgentNow => {
        const l = live.get(a.id);
        const task = taskByAgent.get(a.id);
        const last = lastRuns.get(a.id);
        const msg = lastMessages.get(a.id);
        const online = Boolean(a.lastSeenAt && now.getTime() - a.lastSeenAt.getTime() < OFFLINE_AFTER_MS);
        // An open run on a runtime that stopped checking in is almost surely
        // dead (the lost-run closer only catches it after hours): no timer.
        const run = online || l ? running.get(a.id) : undefined;
        const tokens = last && (last.inputTokens != null || last.outputTokens != null) ? (last.inputTokens ?? 0) + (last.outputTokens ?? 0) : null;
        return {
            agentId: a.id,
            state: deriveLiveState({ typing: Boolean(l), online, hasTaskInProgress: Boolean(task) || Boolean(run) }),
            activity: l?.activity ?? null,
            activityThreadId: l?.threadId ?? null,
            run: run ? redactRunForViewer({
                id: run.id,
                startedAt: run.startedAt.toISOString(),
                triggerKind: run.triggerKind,
                taskId: run.taskId,
                threadId: run.threadId,
                runtimeKind: run.runtimeKind,
            }, runVisible(run.threadId)) : null,
            task: task ? { id: task.id, title: taskTitle({ inputJson: { title: task.title }, taskType: task.taskType }) } : null,
            lastRun: last ? {
                id: last.id,
                status: last.status,
                startedAt: last.startedAt.toISOString(),
                endedAt: last.endedAt?.toISOString() ?? null,
                durationMs: last.durationMs,
                tokens,
                costCents: last.costCents,
                toolCalls: last.toolCalls,
                error: redactRunForViewer({ threadId: last.threadId, error: last.error }, runVisible(last.threadId)).error ?? null,
            } : null,
            lastMessage: msg?.agentId && msg.threadId ? { threadId: msg.threadId, text: toPlainText(msg.text, MESSAGE_MAX), createdAt: msg.createdAt.toISOString() } : null,
            lastSeenAt: a.lastSeenAt?.toISOString() ?? null,
        };
    });
}
