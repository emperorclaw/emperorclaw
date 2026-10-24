import { and, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
    agentRuns,
    agents,
    approvalTaskLinks,
    approvals,
    artifacts,
    companyMembers,
    projects,
    taskEvents,
    tasks,
    threadMessages,
    messageThreads,
    users,
} from "@/db/schema";
import { agentAvatarSrc } from "@/lib/avatar";
import { deriveAppearance, type CharacterAppearance } from "@/lib/character/model";
import { isPrivateDirectThread, userMayUseThread } from "@/lib/direct-chat-mode";
import { isAgentPairThread } from "@/lib/groups";
import { splitProjectTitle } from "@/lib/project-title";
import { approvalInRun, scopedAgentIds, taskHref, taskVisibleToScope } from "@/lib/task-story";
import type { TaskViewer } from "@/lib/task-story-reads";
import {
    buildWorkTimeline,
    eventKindFor,
    TIMELINE_EVENT_CAP,
    TIMELINE_SPAN_CAP,
    type BuildEventSource,
    type BuildRunSource,
    type EdgeEventInput,
    type EdgeRunInput,
    type WorkTimeline,
} from "@/lib/work-timeline";

/**
 * Read side of the company Timeline (/timeline). Everything is
 * company-scoped, and a restricted member's scope is applied on BOTH axes:
 *
 *  - agents: `scopedAgentIds(viewer.scope)` — an empty allow-list shows no
 *    agent rows, never every agent (fail closed). The scoped (and not deleted)
 *    agent rows are the ONLY agents the response may name: runs, task events,
 *    approvals, artifacts and assignees of any other agent are dropped (in SQL
 *    where possible, and again by `agentCanonical` and the builder);
 *  - tasks: `taskVisibleToScope` — a task is visible through its project's
 *    customer, so internal (customer-less) projects are hidden from restricted
 *    members exactly as on the board and the task page.
 *
 * Soft-deleted tasks and projects never appear: a run whose task (or the
 * task's project) is deleted is dropped entirely, as on the task page.
 *
 * People are named by display name, or "Teammate" — never by email.
 *
 * Privacy: a run whose thread is a PRIVATE direct thread the viewer does not
 * own never appears (not even as a bar) — the same `userMayUseThread` rule the
 * task story uses. A run on the viewer's own private thread does. A run with
 * no task (a chat run) only appears as a "Chat" bar when the viewer may read
 * that thread. The task title/outcome a bar carries never leaks a private
 * thread's transcript. Task-level markers follow the same rule (see
 * `privateOnlyTaskIds`).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADMIN_ROLES = new Set(["owner", "admin", "instance_admin"]);
// Raw rows are pulled generously (newest first, scope applied in SQL where
// possible), then visibility-filtered, then capped. Hitting this limit on any
// query reports `capped: true`.
const RAW_ROW_LIMIT = 4000;
const UNNAMED_PERSON = "Teammate";
const DAY_MS = 86_400_000;

/** The page's default window: the last 7 days, ending now (computed here, not in the render). */
export function defaultTimelineWindow(nowMs = Date.now()): { fromMs: number; toMs: number; nowMs: number } {
    return { fromMs: nowMs - 7 * DAY_MS, toMs: nowMs, nowMs };
}

export interface TimelineQuery {
    fromMs: number;
    toMs: number;
    agentId?: string | null;
    projectId?: string | null;
    customerId?: string | null;
    nowMs?: number;
}

interface ThreadInfo {
    id: string;
    type: string;
    title: string | null;
    description: string | null;
    createdByType: string | null;
    ownerUserId: string | null;
    isPrivate: boolean;
    directAgentId: string | null;
}

interface TaskInfo {
    title: string;
    projectId: string;
    projectName: string;
    customerId: string | null;
}

function field(inputJson: unknown, key: string): string | null {
    if (!inputJson || typeof inputJson !== "object") return null;
    const value = (inputJson as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function taskTitle(inputJson: unknown, taskType: string): string {
    return field(inputJson, "title") ?? field(inputJson, "prompt") ?? taskType;
}

/** "Chat with X", "Group", "Team chat", or the thread's title. */
function threadLabel(thread: ThreadInfo | undefined, agentName: (id: string | null) => string | null): string | null {
    if (!thread) return null;
    if (thread.type === "team") return "Team chat";
    if (thread.type === "group") return thread.title?.trim() || "Group";
    if (thread.type === "direct") return `Chat with ${agentName(thread.directAgentId) ?? "agent"}`;
    return thread.title?.trim() || "Chat";
}

function threadHref(thread: ThreadInfo | undefined): string | null {
    if (!thread) return null;
    if (thread.type === "group") return `/messages?group=${encodeURIComponent(thread.id)}`;
    if (thread.type === "direct" && thread.directAgentId) return `/messages?agent=${encodeURIComponent(thread.directAgentId)}`;
    if (thread.type === "team") return "/messages";
    return null;
}

export async function loadWorkTimeline(companyId: string, viewer: TaskViewer, query: TimelineQuery): Promise<WorkTimeline> {
    const nowMs = query.nowMs ?? Date.now();
    const fromMs = query.fromMs;
    const toMs = query.toMs;
    const from = new Date(fromMs);
    const to = new Date(toMs);
    const agentScope = scopedAgentIds(viewer.scope);
    const scoped = viewer.scope != null;
    // Malformed ids are ignored here (the route rejects them with a 400).
    const agentFilter = query.agentId && UUID_RE.test(query.agentId) ? query.agentId : null;
    const projectFilter = query.projectId && UUID_RE.test(query.projectId) ? query.projectId : null;
    const customerFilter = query.customerId && UUID_RE.test(query.customerId) ? query.customerId : null;
    const param: TaskParamFilter = { projectId: projectFilter, customerId: customerFilter };
    let rawCapped = false;
    const noteLimit = <T,>(rows: T[]): T[] => {
        if (rows.length >= RAW_ROW_LIMIT) rawCapped = true;
        return rows;
    };

    // ── Actors: agents (scoped) and people (for names and assignees) ──────
    type AgentRow = { id: string; name: string; avatarUrl: string | null; avatarAppearance: CharacterAppearance | null };
    const [agentRows, memberRows] = await Promise.all([
        agentScope && agentScope.length === 0
            ? Promise.resolve([] as AgentRow[])
            : db.select({
                id: agents.id,
                name: agents.name,
                avatarUrl: agents.avatarUrl,
                avatarAppearance: agents.avatarAppearance,
            }).from(agents)
                .where(and(
                    eq(agents.companyId, companyId),
                    isNull(agents.deletedAt),
                    agentScope ? inArray(agents.id, agentScope) : undefined,
                    agentFilter ? eq(agents.id, agentFilter) : undefined,
                ))
                .orderBy(agents.name),
        db.select({ id: companyMembers.id, userId: users.id, displayName: users.displayName })
            .from(companyMembers)
            .innerJoin(users, eq(users.id, companyMembers.userId))
            .where(eq(companyMembers.companyId, companyId)),
    ]);

    // The visible agents: scoped, not deleted, and matching the agent filter.
    const visibleAgentIds = agentRows.map((a) => a.id);
    const agentName = new Map(agentRows.map((a) => [a.id, a.name]));
    const memberIdToUserId = new Map(memberRows.map((m) => [m.id, m.userId]));
    const userIdToName = new Map<string, string>();
    for (const m of memberRows) userIdToName.set(m.userId, m.displayName?.trim() || UNNAMED_PERSON);

    // Only visible agents and company members ever become canonical ids; any
    // other id resolves to null and whatever named it is dropped.
    const agentCanonical = (id: string | null | undefined) => (id && agentName.has(id) ? `agent:${id}` : null);
    const humanUserId = (id: string | null | undefined) => {
        if (!id) return null;
        // Human ids arrive as either a user id (actors, resolvers) or a
        // company_members id (assignees); normalize both to the user id.
        const userId = memberIdToUserId.get(id) ?? id;
        return userIdToName.has(userId) ? userId : null;
    };

    // ── Runs (left-joined to tasks for scope + param filtering) ───────────
    // Scope, deletion and the filters are applied in SQL so the raw limit is
    // spent on rows the viewer may see; newest first, so a cut keeps the
    // latest work. A run whose task or project is deleted is dropped entirely.
    const paramFiltersTasks = Boolean(projectFilter || customerFilter);
    const taskScope = scopedTaskPredicate(viewer);
    const taskRunCondition = taskScope.none ? sql`false` : and(
        isNotNull(tasks.id),
        isNull(tasks.deletedAt),
        isNull(projects.deletedAt),
        taskScope.condition,
        projectFilter ? eq(tasks.projectId, projectFilter) : undefined,
        customerFilter ? eq(projects.customerId, customerFilter) : undefined,
    );
    const runRows = visibleAgentIds.length === 0 ? [] : noteLimit(await db.select({
        id: agentRuns.id,
        agentId: agentRuns.agentId,
        taskId: agentRuns.taskId,
        threadId: agentRuns.threadId,
        triggerKind: agentRuns.triggerKind,
        triggerMessageId: agentRuns.triggerMessageId,
        status: agentRuns.status,
        exitReason: agentRuns.exitReason,
        startedAt: agentRuns.startedAt,
        endedAt: agentRuns.endedAt,
        durationMs: agentRuns.durationMs,
        inputTokens: agentRuns.inputTokens,
        outputTokens: agentRuns.outputTokens,
        costCents: agentRuns.costCents,
        toolCalls: agentRuns.toolCalls,
        model: agentRuns.model,
        taskProjectId: tasks.projectId,
        taskCustomerId: projects.customerId,
    })
        .from(agentRuns)
        .leftJoin(tasks, and(eq(tasks.id, agentRuns.taskId), eq(tasks.companyId, companyId)))
        .leftJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(
            eq(agentRuns.companyId, companyId),
            lt(agentRuns.startedAt, to),
            or(isNull(agentRuns.endedAt), gte(agentRuns.endedAt, from)),
            inArray(agentRuns.agentId, visibleAgentIds),
            // A project/customer filter never matches a chat run.
            paramFiltersTasks ? taskRunCondition : or(isNull(agentRuns.taskId), taskRunCondition),
        ))
        .orderBy(desc(agentRuns.startedAt))
        .limit(RAW_ROW_LIMIT));

    // Defense in depth: the same rules again, in code.
    const taskMatchesParam = (taskId: string | null, projectId: string | null, customerId: string | null) => {
        if (!taskId) return !paramFiltersTasks;
        if (projectFilter && projectId !== projectFilter) return false;
        if (customerFilter && customerId !== customerFilter) return false;
        return true;
    };
    const visibleRunRows = runRows.filter((run) => {
        if (!run.agentId || !agentName.has(run.agentId)) return false;
        if (run.taskId && !taskVisibleToScope({ customerId: run.taskCustomerId }, viewer.scope)) return false;
        return taskMatchesParam(run.taskId, run.taskProjectId, run.taskCustomerId);
    });

    // ── Events: task_events + approvals + artifacts ────────────────────────
    const [eventRows, approvalRows, artifactRows] = await Promise.all([
        loadEventRows(companyId, viewer, from, to, param, visibleAgentIds).then(noteLimit),
        loadApprovalRows(companyId, viewer, from, to, param, visibleAgentIds).then(noteLimit),
        loadArtifactRows(companyId, viewer, from, to, param, visibleAgentIds).then(noteLimit),
    ]);

    // ── Threads + trigger messages (privacy + edges) ──────────────────────
    // Thread linkage of every task a marker names (any time, not just this
    // window), for the private-only rule below.
    const markerTaskIds = [...new Set([...eventRows, ...approvalRows, ...artifactRows].map((r) => r.taskId).filter((id): id is string => Boolean(id)))];
    const markerTaskRuns = markerTaskIds.length === 0 ? [] : await db.selectDistinct({ taskId: agentRuns.taskId, threadId: agentRuns.threadId })
        .from(agentRuns)
        .where(and(eq(agentRuns.companyId, companyId), inArray(agentRuns.taskId, markerTaskIds)));

    const threadIds = [...new Set([...visibleRunRows, ...markerTaskRuns].map((r) => r.threadId).filter((id): id is string => Boolean(id && UUID_RE.test(id))))];
    const triggerMessageIds = [...new Set(visibleRunRows.map((r) => r.triggerMessageId).filter((id): id is string => Boolean(id && UUID_RE.test(id))))];
    const [threadRows, triggerMessages] = await Promise.all([
        threadIds.length === 0 ? Promise.resolve([] as ThreadInfo[]) : db.select({
            id: messageThreads.id,
            type: messageThreads.type,
            title: messageThreads.title,
            description: messageThreads.description,
            createdByType: messageThreads.createdByType,
            ownerUserId: messageThreads.ownerUserId,
            isPrivate: messageThreads.isPrivate,
            directAgentId: messageThreads.directAgentId,
        }).from(messageThreads).where(and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, threadIds))),
        triggerMessageIds.length === 0 ? Promise.resolve([] as { id: string; senderType: string; senderId: string | null }[]) : db.select({
            id: threadMessages.id,
            senderType: threadMessages.senderType,
            senderId: threadMessages.senderId,
        }).from(threadMessages).where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.id, triggerMessageIds))),
    ]);
    const threadById = new Map(threadRows.map((t) => [t.id, t]));
    const triggerByMessageId = new Map(triggerMessages.map((m) => [m.id, m]));

    const threadReadable = (thread: ThreadInfo | undefined): boolean => {
        if (!thread) return true;
        if (!userMayUseThread(thread, viewer.userId)) return false;
        if (thread.type === "group" && isAgentPairThread(thread) && !ADMIN_ROLES.has(viewer.role)) return false;
        return true;
    };
    const runThreadHidden = (thread: ThreadInfo | undefined): boolean => {
        // A private direct thread the viewer does not own: never even a bar.
        return Boolean(thread && isPrivateDirectThread(thread) && thread.ownerUserId !== viewer.userId);
    };

    const keptRunRows = visibleRunRows.filter((run) => {
        const thread = run.threadId ? threadById.get(run.threadId) : undefined;
        if (runThreadHidden(thread)) return false;
        // Chat runs appear only when the viewer may read the thread.
        if (!run.taskId && !threadReadable(thread)) return false;
        return true;
    });

    // Private-only tasks. Tasks carry no thread of their own, so a task asked
    // for in someone's private direct chat is recognisable only by its runs.
    // Rule: a task with at least one run on a private direct thread the viewer
    // does not own, and NO run anywhere else (another thread, or no thread),
    // is that other person's private work — its notes, assignments, approvals,
    // files and handoffs are dropped, exactly like its bars. A task with any
    // run the viewer could see, or with no runs at all (board work), keeps its
    // markers: it is visible on the board and the task page anyway.
    const privateOnlyTaskIds = new Set<string>();
    {
        const linkage = new Map<string, { hidden: boolean; open: boolean }>();
        for (const run of [...markerTaskRuns, ...visibleRunRows]) {
            if (!run.taskId) continue;
            const entry = linkage.get(run.taskId) ?? { hidden: false, open: false };
            const thread = run.threadId ? threadById.get(run.threadId) : undefined;
            if (runThreadHidden(thread)) entry.hidden = true;
            else entry.open = true;
            linkage.set(run.taskId, entry);
        }
        for (const [taskId, entry] of linkage) {
            if (entry.hidden && !entry.open) privateOnlyTaskIds.add(taskId);
        }
    }
    const markerVisible = (taskId: string | null) => Boolean(taskId) && !privateOnlyTaskIds.has(taskId as string);

    // ── Task info (title, project short name) for bars and events ─────────
    const taskIds = [...new Set(keptRunRows.map((r) => r.taskId).filter((id): id is string => Boolean(id)))];
    const taskInfoRows = taskIds.length === 0 ? [] : await db.select({
        id: tasks.id,
        projectId: tasks.projectId,
        taskType: tasks.taskType,
        inputJson: tasks.inputJson,
        goal: projects.goal,
        customerId: projects.customerId,
    }).from(tasks).leftJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, taskIds), isNull(tasks.deletedAt)));
    const taskInfo = new Map<string, TaskInfo>();
    for (const t of taskInfoRows) {
        taskInfo.set(t.id, { title: taskTitle(t.inputJson, t.taskType), projectId: t.projectId, projectName: splitProjectTitle(t.goal).name || "Project", customerId: t.customerId });
    }

    // ── Pending approvals for runOutcome (needs_you) ───────────────────────
    const pendingApprovals = taskIds.length === 0 ? [] : await db.select({
        taskId: approvalTaskLinks.taskId,
        requestedAt: approvals.requestedAt,
    }).from(approvalTaskLinks)
        .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
        .where(and(eq(approvalTaskLinks.companyId, companyId), eq(approvals.companyId, companyId), eq(approvals.status, "pending"), inArray(approvalTaskLinks.taskId, taskIds)));
    const pendingAtByTask = new Map<string, number[]>();
    for (const a of pendingApprovals) {
        const list = pendingAtByTask.get(a.taskId) ?? [];
        list.push(a.requestedAt.getTime());
        pendingAtByTask.set(a.taskId, list);
    }

    // Build the humans registry (people who acted OR were assigned).
    const humans = new Map<string, string>(); // canonical userId -> name
    const registerHuman = (id: string | null | undefined) => {
        const userId = humanUserId(id);
        if (!userId) return null;
        humans.set(userId, userIdToName.get(userId) ?? UNNAMED_PERSON);
        return `human:${userId}`;
    };

    const events: BuildEventSource[] = [];
    const edgeEvents: EdgeEventInput[] = [];
    const edgeRuns: EdgeRunInput[] = [];

    for (const row of eventRows) {
        if (!markerVisible(row.taskId)) continue;
        const kind = eventKindFor(row.eventType);
        if (!kind) continue;
        let actorId: string | null = null;
        if (row.actorType === "agent") actorId = agentCanonical(row.actorId);
        else if (row.actorType === "human") actorId = registerHuman(row.actorId);
        if (!actorId) continue; // system events (and actors out of view) have no row to draw on
        events.push({ id: `ev:${row.id}`, actorId, taskId: row.taskId, kind, atMs: row.createdAt.getTime() });

        // An assignee out of view resolves to null: no edge, and no id.
        const assigneeId = assigneeCanonical(row.payloadJson, agentCanonical, registerHuman);
        if (assigneeId) {
            edgeEvents.push({ id: row.id, eventType: row.eventType, actorId, assigneeId, taskId: row.taskId, atMs: row.createdAt.getTime() });
        }
    }

    for (const row of approvalRows) {
        if (!markerVisible(row.taskId)) continue;
        const requester = agentCanonical(row.requesterAgentId);
        if (requester && row.requestedAt.getTime() >= fromMs && row.requestedAt.getTime() <= toMs) {
            events.push({ id: `apr:${row.approvalId}`, actorId: requester, taskId: row.taskId, kind: "approval_requested", atMs: row.requestedAt.getTime() });
        }
        const resolver = row.resolvedAt && row.resolvedAt.getTime() >= fromMs && row.resolvedAt.getTime() <= toMs ? registerHuman(row.resolverUserId) : null;
        if (resolver && row.resolvedAt) {
            events.push({ id: `apd:${row.approvalId}`, actorId: resolver, taskId: row.taskId, kind: "approval_decided", atMs: row.resolvedAt.getTime() });
        }
    }

    for (const row of artifactRows) {
        if (!row.taskId || !markerVisible(row.taskId)) continue;
        const actorId = agentCanonical(row.agentId);
        if (!actorId) continue;
        events.push({ id: `art:${row.id}`, actorId, taskId: row.taskId, kind: "file", atMs: row.createdAt.getTime() });
    }

    // ── Edge runs: runs triggered by another agent's message ──────────────
    for (const run of keptRunRows) {
        if (run.triggerKind !== "message" || !run.triggerMessageId) continue;
        const trigger = triggerByMessageId.get(run.triggerMessageId);
        if (!trigger || trigger.senderType !== "agent" || !trigger.senderId || trigger.senderId === run.agentId) continue;
        const triggerActorId = agentCanonical(trigger.senderId); // sender must be a visible agent
        if (!triggerActorId) continue;
        edgeRuns.push({
            runId: run.id,
            agentId: `agent:${run.agentId}`,
            taskId: run.taskId,
            triggerKind: run.triggerKind,
            triggerActorId,
            startedAtMs: run.startedAt.getTime(),
        });
    }

    // ── Assemble builder inputs ────────────────────────────────────────────
    // keptRunRows is newest first, so the cut keeps the latest runs.
    const runs: BuildRunSource[] = keptRunRows.slice(0, TIMELINE_SPAN_CAP + 1).map((run) => {
        const thread = run.threadId ? threadById.get(run.threadId) : undefined;
        const info = run.taskId ? taskInfo.get(run.taskId) : undefined;
        const pending = pendingAtByTask.get(run.taskId ?? "") ?? [];
        return {
            runId: run.id,
            agentId: `agent:${run.agentId}`,
            taskId: run.taskId,
            taskTitle: run.taskId ? (info?.title ?? null) : null,
            projectName: run.taskId ? (info?.projectName ?? null) : null,
            threadLabel: run.taskId ? null : threadLabel(thread, (id) => agentName.get(id ?? "") ?? null),
            href: run.taskId ? taskHref(run.taskId) : threadHref(thread),
            status: run.status,
            exitReason: run.exitReason,
            pendingApproval: pending.some((at) => approvalInRun(at, { startedAtMs: run.startedAt.getTime(), endedAtMs: run.endedAt?.getTime() ?? null })),
            triggerKind: run.triggerKind,
            startedAtMs: run.startedAt.getTime(),
            endedAtMs: run.endedAt?.getTime() ?? null,
            durationMs: run.durationMs,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
            costCents: run.costCents,
            toolCalls: run.toolCalls,
            model: run.model,
        };
    });

    const humansList = [...humans.entries()].map(([id, name]) => ({ id, name }));
    // Newest events win a cut, matching the builder.
    const cappedEvents = events.sort((a, b) => b.atMs - a.atMs).slice(0, TIMELINE_EVENT_CAP + 1);

    return buildWorkTimeline({
        fromMs,
        toMs,
        nowMs,
        agents: agentRows.map((a) => ({ id: a.id, name: a.name, avatarUrl: agentAvatarSrc({ id: a.id, avatarUrl: a.avatarUrl }), hue: a.avatarAppearance?.hue ?? deriveAppearance(a.id).hue })),
        humans: humansList,
        runs,
        events: cappedEvents,
        edgeEvents,
        edgeRuns,
        scoped,
        rawCapped,
    });
}

/** Resolve a task_events payload's assignee to a canonical actor id, or null (unknown or out of view). */
function assigneeCanonical(
    payloadJson: unknown,
    agentCanonical: (id: string | null | undefined) => string | null,
    registerHuman: (id: string | null | undefined) => string | null,
): string | null {
    const payload = payloadJson && typeof payloadJson === "object" ? payloadJson as Record<string, unknown> : {};
    const assignee = payload.assignee as { type?: unknown; id?: unknown } | null | undefined;
    if (assignee && typeof assignee === "object" && typeof assignee.id === "string") {
        return assignee.type === "agent"
            ? agentCanonical(assignee.id)
            : assignee.type === "human" || assignee.type === "member"
                ? registerHuman(assignee.id)
                : null;
    }
    if (typeof payload.assignedAgentId === "string" && payload.assignedAgentId) return agentCanonical(payload.assignedAgentId);
    return null;
}

interface EventRow {
    id: string;
    taskId: string;
    eventType: string;
    payloadJson: unknown;
    actorType: string;
    actorId: string | null;
    createdAt: Date;
}

interface TaskParamFilter {
    projectId: string | null;
    customerId: string | null;
}

/**
 * The customer-axis filter for a task-scoped table (all of them are joined to
 * tasks and projects). `none` means the restricted scope grants nothing on the
 * customer axis (an empty allow-list), so the caller returns no rows;
 * `condition` is undefined when the viewer is unrestricted.
 */
function scopedTaskPredicate(viewer: TaskViewer): { none: boolean; condition: SQL | undefined } {
    if (!viewer.scope || viewer.scope.mode !== "restricted") return { none: false, condition: undefined };
    const customerIds = viewer.scope.customerIds ?? [];
    if (customerIds.length === 0) return { none: true, condition: undefined };
    return { none: false, condition: inArray(projects.customerId, customerIds) };
}

/** Live (not deleted) task and project, inside the viewer's scope and the page filters. */
function liveTaskConditions(condition: SQL | undefined, param: TaskParamFilter): (SQL | undefined)[] {
    return [
        isNull(tasks.deletedAt),
        isNull(projects.deletedAt),
        condition,
        param.projectId ? eq(tasks.projectId, param.projectId) : undefined,
        param.customerId ? eq(projects.customerId, param.customerId) : undefined,
    ];
}

async function loadEventRows(companyId: string, viewer: TaskViewer, from: Date, to: Date, param: TaskParamFilter, visibleAgentIds: string[]): Promise<EventRow[]> {
    const { none, condition } = scopedTaskPredicate(viewer);
    if (none) return [];
    return db.select({
        id: taskEvents.id,
        taskId: taskEvents.taskId,
        eventType: taskEvents.eventType,
        payloadJson: taskEvents.payloadJson,
        actorType: taskEvents.actorType,
        actorId: taskEvents.actorId,
        createdAt: taskEvents.createdAt,
    }).from(taskEvents)
        .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(
            eq(taskEvents.companyId, companyId),
            gte(taskEvents.createdAt, from),
            lte(taskEvents.createdAt, to),
            // An agent's event only when that agent is visible.
            visibleAgentIds.length === 0
                ? ne(taskEvents.actorType, "agent")
                : or(ne(taskEvents.actorType, "agent"), inArray(taskEvents.actorId, visibleAgentIds)),
            ...liveTaskConditions(condition, param),
        ))
        .orderBy(desc(taskEvents.createdAt))
        .limit(RAW_ROW_LIMIT);
}

async function loadApprovalRows(companyId: string, viewer: TaskViewer, from: Date, to: Date, param: TaskParamFilter, visibleAgentIds: string[]) {
    const { none, condition } = scopedTaskPredicate(viewer);
    if (none) return [];
    return db.select({
        approvalId: approvals.id,
        taskId: approvalTaskLinks.taskId,
        requesterAgentId: approvals.requesterAgentId,
        resolverUserId: approvals.resolverUserId,
        requestedAt: approvals.requestedAt,
        resolvedAt: approvals.resolvedAt,
    }).from(approvalTaskLinks)
        .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
        .innerJoin(tasks, eq(tasks.id, approvalTaskLinks.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(
            eq(approvalTaskLinks.companyId, companyId),
            eq(approvals.companyId, companyId),
            lt(approvals.requestedAt, to),
            or(isNull(approvals.resolvedAt), gte(approvals.resolvedAt, from)),
            // Something to draw: a visible requester, or a person's decision.
            visibleAgentIds.length === 0
                ? isNotNull(approvals.resolverUserId)
                : or(inArray(approvals.requesterAgentId, visibleAgentIds), isNotNull(approvals.resolverUserId)),
            ...liveTaskConditions(condition, param),
        ))
        .orderBy(desc(approvals.requestedAt))
        .limit(RAW_ROW_LIMIT);
}

async function loadArtifactRows(companyId: string, viewer: TaskViewer, from: Date, to: Date, param: TaskParamFilter, visibleAgentIds: string[]) {
    const { none, condition } = scopedTaskPredicate(viewer);
    if (none || visibleAgentIds.length === 0) return [];
    return db.select({
        id: artifacts.id,
        taskId: artifacts.taskId,
        agentId: artifacts.agentId,
        createdAt: artifacts.createdAt,
    }).from(artifacts)
        .innerJoin(tasks, eq(tasks.id, artifacts.taskId))
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(
            eq(artifacts.companyId, companyId),
            isNull(artifacts.deletedAt),
            gte(artifacts.createdAt, from),
            lte(artifacts.createdAt, to),
            inArray(artifacts.agentId, visibleAgentIds),
            ...liveTaskConditions(condition, param),
        ))
        .orderBy(desc(artifacts.createdAt))
        .limit(RAW_ROW_LIMIT);
}
