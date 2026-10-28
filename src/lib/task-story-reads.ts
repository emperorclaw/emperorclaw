import { and, desc, eq, inArray, isNull, lt, or, type SQL } from "drizzle-orm";
import { db } from "@/db";
import {
    agentRequests,
    agentRuns,
    agents,
    approvalTaskLinks,
    approvals,
    artifacts,
    companyMembers,
    customers,
    messageThreads,
    projects,
    taskEvents,
    tasks,
    threadMessages,
    users,
} from "@/db/schema";
import { loadThreadVisibility, PRIVATE_ACTIVITY, PRIVATE_RUN_ERROR } from "@/lib/agent-activity";
import { userMayUseThread } from "@/lib/direct-chat-mode";
import { isAgentPairThread } from "@/lib/groups";
import { resolveMemberScope, type MemberScope } from "@/lib/member-scope";
import { agentsNotUsableBy } from "@/lib/agent-access-server";
import type { Role } from "@/lib/role-matrix";
import type { GuardContext } from "@/lib/roles";
import { buildRunLive, loadRunEventsTail, type RunLive } from "@/lib/run-events";
import { runThreadLink } from "@/lib/run-ledger-copy";
import { loadStallSignals } from "@/lib/stall-signal-reads";
import {
    approvalInRun,
    describeTaskEvent,
    excerpt,
    mergeStory,
    pageStory,
    runOutcome,
    scopedAgentIds,
    taskVisibleToScope,
    TASK_STORY_PAGE_SIZE,
    type StoryApprovalEntry,
    type StoryArtifactEntry,
    type StoryEntry,
    type StoryEventEntry,
    type StoryMessageEntry,
    type StoryNames,
    type StoryRunEntry,
} from "@/lib/task-story";

/**
 * Read side of the task page (/projects/tasks/[id]). Everything is
 * company-scoped. A task outside the viewer's member scope reads as missing
 * (null → 404), exactly like a task of another company. Runs and messages from
 * a private chat the viewer is not part of stay in the story, without their
 * text, thread or error.
 */

const ADMIN_ROLES = new Set(["owner", "admin", "instance_admin"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TaskViewer {
    userId: string | null;
    /** company_members.id, when the viewer is a member (assigned-to-me check). */
    memberId: string | null;
    role: string;
    scope: MemberScope | null;
}

/**
 * The viewer's membership in this company: role, member id and fresh scope
 * (the DB copy, not the JWT one). Owners, admins and instance admins are never
 * scoped, as in member-scope.loadMemberScope.
 */
export async function loadTaskViewer(companyId: string, userId: string | null): Promise<TaskViewer> {
    if (!userId) return { userId: null, memberId: null, role: "viewer", scope: null };
    const [member] = await db
        .select({ id: companyMembers.id, role: companyMembers.role, scopeJson: companyMembers.scopeJson, instanceRole: users.instanceRole })
        .from(companyMembers)
        .innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
        .limit(1);
    // Not a member of this company: nothing in scope (fail closed).
    if (!member) return { userId, memberId: null, role: "viewer", scope: { mode: "restricted", agentIds: [], customerIds: [], projectIds: [] } };
    const unscoped = member.instanceRole === "instance_admin" || ADMIN_ROLES.has(member.role);
    return { userId, memberId: member.id, role: member.role, scope: unscoped ? null : await resolveMemberScope(companyId, userId, member.scopeJson) };
}

/**
 * The viewer from the central role guard (lib/roles.ts requireRole): role and
 * member scope come from the DB, only the membership id is looked up here.
 */
export async function taskViewerFromGuard(ctx: GuardContext): Promise<TaskViewer> {
    const [member] = await db.select({ id: companyMembers.id }).from(companyMembers)
        .where(and(eq(companyMembers.companyId, ctx.companyId), eq(companyMembers.userId, ctx.userId))).limit(1);
    return { userId: ctx.userId, memberId: member?.id ?? null, role: ctx.role, scope: ctx.scope };
}

export interface TaskHeader {
    id: string;
    title: string;
    description: string | null;
    state: string;
    priority: number;
    taskType: string;
    blockedReason: string | null;
    humanApprovalRequired: boolean;
    createdAt: string;
    updatedAt: string;
    projectId: string;
    projectName: string;
    customerId: string | null;
    customerName: string | null;
    owner: { type: "agent" | "human"; id: string; name: string } | null;
    approval: { pending: number; latest: { status: string; at: string; resolverName: string | null } | null };
}

export interface TaskLiveRun {
    live: RunLive;
    agentName: string | null;
    private: boolean;
    lastUsefulAt: string;
    threadHref: string | null;
}

export interface TaskLiveView {
    runs: TaskLiveRun[];
    state: string;
    serverNow: string;
}

export interface TaskStoryView {
    task: TaskHeader;
    entries: StoryEntry[];
    hasMore: boolean;
    nextBefore: string | null;
    live: TaskLiveView;
    /** For the page's reassign control. Empty for viewers who cannot edit. */
    assignees: { agents: { id: string; name: string }[]; members: { id: string; name: string }[] };
}

type TaskRow = {
    id: string;
    projectId: string;
    state: string;
    priority: number;
    taskType: string;
    inputJson: unknown;
    assignedAgentId: string | null;
    assignedMemberId: string | null;
    humanApprovalRequired: boolean;
    createdAt: Date;
    updatedAt: Date;
    projectName: string | null;
    customerId: string | null;
    customerName: string | null;
};

/** The task row plus project and customer, or null when missing, deleted, foreign or out of scope. */
async function loadScopedTask(companyId: string, taskId: string, viewer: TaskViewer): Promise<TaskRow | null> {
    if (!UUID_RE.test(taskId)) return null;
    const [row] = await db
        .select({
            id: tasks.id,
            projectId: tasks.projectId,
            state: tasks.state,
            priority: tasks.priority,
            taskType: tasks.taskType,
            inputJson: tasks.inputJson,
            assignedAgentId: tasks.assignedAgentId,
            assignedMemberId: tasks.assignedMemberId,
            humanApprovalRequired: tasks.humanApprovalRequired,
            createdAt: tasks.createdAt,
            updatedAt: tasks.updatedAt,
            projectName: projects.goal,
            customerId: projects.customerId,
            customerName: customers.name,
        })
        .from(tasks)
        .leftJoin(projects, eq(projects.id, tasks.projectId))
        .leftJoin(customers, eq(customers.id, projects.customerId))
        .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId), isNull(tasks.deletedAt)))
        .limit(1);
    if (!row) return null;
    if (!taskVisibleToScope({ customerId: row.customerId, projectId: row.projectId }, viewer.scope)) return null;
    return row;
}

function inputField(inputJson: unknown, key: string): string | null {
    if (!inputJson || typeof inputJson !== "object") return null;
    const value = (inputJson as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Agents (by id) and members (by member id and by user id) named in the story.
 * An agent limited to other people (0.20) is "🔒 name" for an owner/admin who
 * sees it as metadata and "Private agent" for everyone else, and is never
 * offered as an assignee.
 */
async function loadNames(companyId: string, viewer: TaskViewer): Promise<StoryNames & { agentList: { id: string; name: string }[]; memberList: { id: string; name: string }[] }> {
    const [agentRows, memberRows] = await Promise.all([
        db.select({ id: agents.id, name: agents.name, deletedAt: agents.deletedAt }).from(agents).where(eq(agents.companyId, companyId)),
        db.select({ id: companyMembers.id, userId: users.id, displayName: users.displayName, email: users.email })
            .from(companyMembers)
            .innerJoin(users, eq(users.id, companyMembers.userId))
            .where(eq(companyMembers.companyId, companyId)),
    ]);
    const limited = viewer.userId
        ? await agentsNotUsableBy({ companyId, userId: viewer.userId, role: viewer.role as Role, scope: viewer.scope })
        : { hidden: new Set(agentRows.map((row) => row.id)), metadata: new Set<string>() };
    const shownName = (row: { id: string; name: string }) => !limited.hidden.has(row.id) ? row.name
        : limited.metadata.has(row.id) ? `🔒 ${row.name}` : "Private agent";
    const agentNames = new Map(agentRows.map((row) => [row.id, shownName(row)]));
    const memberNames = new Map<string, string>();
    for (const row of memberRows) {
        const name = row.displayName?.trim() || row.email;
        memberNames.set(row.id, name);
        memberNames.set(row.userId, name);
    }
    return {
        agent: (id) => (id ? agentNames.get(id) ?? null : null),
        member: (id) => (id ? memberNames.get(id) ?? null : null),
        agentList: agentRows.filter((row) => !row.deletedAt && !limited.hidden.has(row.id)).map((row) => ({ id: row.id, name: row.name })),
        memberList: memberRows.map((row) => ({ id: row.id, name: row.displayName?.trim() || row.email })),
    };
}

type ThreadInfo = {
    id: string;
    type: string;
    title: string | null;
    description: string | null;
    createdByType: string | null;
    ownerUserId: string | null;
    isPrivate: boolean;
    directAgentId: string | null;
};

async function loadThreads(companyId: string, ids: readonly (string | null)[]): Promise<Map<string, ThreadInfo>> {
    const unique = [...new Set(ids.filter((id): id is string => Boolean(id && UUID_RE.test(id))))];
    if (unique.length === 0) return new Map();
    const rows = await db
        .select({
            id: messageThreads.id,
            type: messageThreads.type,
            title: messageThreads.title,
            description: messageThreads.description,
            createdByType: messageThreads.createdByType,
            ownerUserId: messageThreads.ownerUserId,
            isPrivate: messageThreads.isPrivate,
            directAgentId: messageThreads.directAgentId,
        })
        .from(messageThreads)
        .where(and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, unique)));
    return new Map(rows.map((row) => [row.id, row]));
}

/** Whether the viewer may read a thread's messages from the human UI (the /api/chat rules). */
function messageThreadReadable(thread: ThreadInfo | undefined, viewer: TaskViewer): boolean {
    if (!thread) return false;
    if (!userMayUseThread(thread, viewer.userId)) return false;
    if (thread.type === "group" && isAgentPairThread(thread) && !ADMIN_ROLES.has(viewer.role)) return false;
    return true;
}

function threadLabel(thread: ThreadInfo | undefined, names: StoryNames, readable: boolean): string {
    if (!thread) return "Chat";
    if (!readable) return "Private chat";
    if (thread.type === "team") return "Team chat";
    if (thread.type === "group") return thread.title?.trim() || "Group";
    if (thread.type === "direct") return `Chat with ${names.agent(thread.directAgentId) ?? "agent"}`;
    return thread.title?.trim() || "Chat";
}

function messageHref(thread: ThreadInfo | undefined): string | null {
    if (!thread) return null;
    if (thread.type === "group") return `/messages?group=${encodeURIComponent(thread.id)}`;
    if (thread.type === "direct" && thread.directAgentId) return `/messages?agent=${encodeURIComponent(thread.directAgentId)}`;
    if (thread.type === "team") return "/messages";
    return null;
}

/**
 * One page of a task's story: newest first, at most `limit` entries older than
 * `before`. Null when the viewer may not see the task.
 */
export async function loadTaskStory(
    companyId: string,
    taskId: string,
    viewer: TaskViewer,
    options: { before?: string | null; limit?: number; now?: Date } = {},
): Promise<TaskStoryView | null> {
    const task = await loadScopedTask(companyId, taskId, viewer);
    if (!task) return null;
    const now = options.now ?? new Date();
    const limit = Math.max(1, Math.min(options.limit ?? TASK_STORY_PAGE_SIZE, 200));
    const beforeMs = options.before ? Date.parse(options.before) : NaN;
    const before = Number.isFinite(beforeMs) ? new Date(beforeMs) : null;
    // Each source contributes at most limit + 1 rows: any entry on this page is
    // among the newest limit + 1 of its own source.
    const perSource = limit + 1;
    const olderThan = (column: Parameters<typeof lt>[0]): SQL | undefined => (before ? lt(column, before) : undefined);
    const agentScope = scopedAgentIds(viewer.scope);

    const [names, eventRows, approvalRows, artifactRows, runRows, requestRows] = await Promise.all([
        loadNames(companyId, viewer),
        db.select().from(taskEvents)
            .where(and(eq(taskEvents.companyId, companyId), eq(taskEvents.taskId, taskId), olderThan(taskEvents.createdAt)))
            .orderBy(desc(taskEvents.createdAt))
            .limit(perSource),
        db.select({
            id: approvals.id,
            status: approvals.status,
            actionType: approvals.actionType,
            rationale: approvals.rationale,
            resolutionNote: approvals.resolutionNote,
            requesterAgentId: approvals.requesterAgentId,
            resolverUserId: approvals.resolverUserId,
            requestedAt: approvals.requestedAt,
            resolvedAt: approvals.resolvedAt,
        })
            .from(approvalTaskLinks)
            .innerJoin(approvals, eq(approvals.id, approvalTaskLinks.approvalId))
            .where(and(eq(approvalTaskLinks.companyId, companyId), eq(approvalTaskLinks.taskId, taskId), eq(approvals.companyId, companyId)))
            .orderBy(desc(approvals.requestedAt))
            .limit(200),
        db.select({
            id: artifacts.id,
            title: artifacts.title,
            originalFilename: artifacts.originalFilename,
            path: artifacts.path,
            kind: artifacts.kind,
            contentType: artifacts.contentType,
            artifactClass: artifacts.artifactClass,
            agentId: artifacts.agentId,
            sizeBytes: artifacts.sizeBytes,
            createdAt: artifacts.createdAt,
        })
            .from(artifacts)
            .where(and(eq(artifacts.companyId, companyId), eq(artifacts.taskId, taskId), isNull(artifacts.deletedAt), olderThan(artifacts.createdAt)))
            .orderBy(desc(artifacts.createdAt))
            .limit(perSource),
        db.select().from(agentRuns)
            .where(and(
                eq(agentRuns.companyId, companyId),
                eq(agentRuns.taskId, taskId),
                agentScope ? inArray(agentRuns.agentId, agentScope) : undefined,
                // The running ones are always loaded: they are pinned live.
                before ? or(lt(agentRuns.startedAt, before), eq(agentRuns.status, "running")) : undefined,
            ))
            .orderBy(desc(agentRuns.startedAt))
            .limit(perSource + 10),
        db.select({ messageId: agentRequests.messageId })
            .from(agentRequests)
            .where(and(eq(agentRequests.companyId, companyId), eq(agentRequests.taskId, taskId)))
            .limit(20),
    ]);

    // Messages linked to the task: its own threads, and the request message that created it.
    const requestMessageIds = requestRows.map((row) => row.messageId).filter((id): id is string => Boolean(id));
    const replyIds = runRows.map((run) => run.replyMessageId).filter((id): id is string => Boolean(id));
    const [linkedMessages, replyMessages] = await Promise.all([
        db.select({
            id: threadMessages.id,
            threadId: threadMessages.threadId,
            senderType: threadMessages.senderType,
            senderId: threadMessages.senderId,
            text: threadMessages.text,
            createdAt: threadMessages.createdAt,
        })
            .from(threadMessages)
            .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
            .where(and(
                eq(threadMessages.companyId, companyId),
                requestMessageIds.length > 0
                    ? or(eq(messageThreads.taskId, taskId), inArray(threadMessages.id, requestMessageIds))
                    : eq(messageThreads.taskId, taskId),
                olderThan(threadMessages.createdAt),
            ))
            .orderBy(desc(threadMessages.createdAt))
            .limit(perSource),
        replyIds.length === 0 ? Promise.resolve([]) : db.select({
            id: threadMessages.id,
            threadId: threadMessages.threadId,
            text: threadMessages.text,
            createdAt: threadMessages.createdAt,
        })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.id, replyIds))),
    ]);

    const threads = await loadThreads(companyId, [
        ...runRows.map((run) => run.threadId),
        ...linkedMessages.map((message) => message.threadId),
        ...replyMessages.map((message) => message.threadId),
    ]);
    const runVisibility = await loadThreadVisibility(companyId, runRows.map((run) => run.threadId), viewer.userId);

    // ── Entries ──
    const eventEntries: StoryEventEntry[] = eventRows.map((row) => ({
        kind: "event",
        id: row.id,
        at: row.createdAt.toISOString(),
        ...describeTaskEvent({
            id: row.id,
            eventType: row.eventType,
            payloadJson: row.payloadJson,
            actorType: row.actorType,
            actorId: row.actorId,
            createdAt: row.createdAt.toISOString(),
        }, names),
    }));

    const approvalEntries: StoryApprovalEntry[] = [];
    for (const row of approvalRows) {
        const base = {
            kind: "approval" as const,
            approvalId: row.id,
            status: row.status,
            actionType: row.actionType,
            requesterName: names.agent(row.requesterAgentId),
            resolverName: names.member(row.resolverUserId),
        };
        approvalEntries.push({ ...base, id: `${row.id}:requested`, at: row.requestedAt.toISOString(), phase: "requested", note: row.rationale?.trim() || null });
        if (row.resolvedAt && row.status !== "pending") {
            approvalEntries.push({ ...base, id: `${row.id}:decided`, at: row.resolvedAt.toISOString(), phase: "decided", note: row.resolutionNote?.trim() || null });
        }
    }
    const pagedApprovals = before ? approvalEntries.filter((entry) => Date.parse(entry.at) < before.getTime()) : approvalEntries;

    const artifactEntries: StoryArtifactEntry[] = artifactRows.map((row) => ({
        kind: "artifact",
        id: row.id,
        at: row.createdAt.toISOString(),
        title: row.title?.trim() || row.originalFilename || row.path?.split("/").pop() || row.kind,
        contentType: row.contentType,
        artifactClass: row.artifactClass,
        agentName: names.agent(row.agentId),
        sizeBytes: row.sizeBytes,
    }));

    const replyById = new Map(replyMessages.map((message) => [message.id, message]));
    const replyIdSet = new Set(replyIds);
    const messageEntries: StoryMessageEntry[] = linkedMessages
        .filter((message) => !replyIdSet.has(message.id))
        .map((message) => {
            const thread = threads.get(message.threadId);
            const readable = messageThreadReadable(thread, viewer);
            const senderLabel = message.senderType === "agent"
                ? names.agent(message.senderId) ?? "Agent"
                : message.senderType === "human"
                    ? names.member(message.senderId) ?? "Someone"
                    : "System";
            return {
                kind: "message",
                id: message.id,
                at: message.createdAt.toISOString(),
                senderLabel,
                threadLabel: threadLabel(thread, names, readable),
                text: readable ? excerpt(message.text, 600) : null,
                href: readable ? messageHref(thread) : null,
            };
        });

    const pendingApprovalTimes = approvalRows
        .filter((row) => row.status === "pending")
        .map((row) => row.requestedAt.getTime());
    const runEntries: StoryRunEntry[] = runRows
        .filter((run) => run.status !== "running")
        .map((run) => {
            const visible = runVisibility.visible(run.threadId);
            const thread = run.threadId ? threads.get(run.threadId) : undefined;
            const reply = run.replyMessageId ? replyById.get(run.replyMessageId) : undefined;
            const replyReadable = reply ? visible && messageThreadReadable(threads.get(reply.threadId), viewer) : false;
            const window = { startedAtMs: run.startedAt.getTime(), endedAtMs: run.endedAt?.getTime() ?? null };
            const pendingApproval = pendingApprovalTimes.some((at) => approvalInRun(at, window));
            return {
                kind: "run",
                id: run.id,
                at: run.startedAt.toISOString(),
                run: {
                    id: run.id,
                    agentId: run.agentId,
                    agentName: names.agent(run.agentId),
                    status: run.status,
                    outcome: runOutcome(run, { pendingApproval }),
                    triggerKind: run.triggerKind,
                    startedAt: run.startedAt.toISOString(),
                    endedAt: run.endedAt?.toISOString() ?? null,
                    durationMs: run.durationMs,
                    inputTokens: run.inputTokens,
                    outputTokens: run.outputTokens,
                    costCents: run.costCents,
                    toolCalls: run.toolCalls,
                    model: run.model,
                    exitReason: run.exitReason,
                    error: run.error ? (visible ? run.error : PRIVATE_RUN_ERROR) : null,
                    private: !visible,
                    threadHref: visible ? runThreadLink({ threadId: run.threadId, threadType: thread?.type ?? null, agentId: run.agentId }) ?? (thread?.type === "team" ? "/messages" : null) : null,
                    threadLabel: thread ? threadLabel(thread, names, visible) : null,
                    reply: run.replyMessageId
                        ? { messageId: run.replyMessageId, excerpt: replyReadable ? excerpt(reply?.text, 280) : null, at: reply?.createdAt.toISOString() ?? null }
                        : null,
                },
            };
        });

    const merged = mergeStory(eventEntries, pagedApprovals, artifactEntries, messageEntries, runEntries);
    const page = pageStory(merged, { limit });

    // ── Live runs (pinned) ──
    const running = runRows.filter((run) => run.status === "running");
    const live = await buildLiveView(companyId, running, runVisibility.visible, threads, names, task.state, now);

    // ── Header ──
    const pending = approvalRows.filter((row) => row.status === "pending").length;
    const latestDecided = approvalRows
        .filter((row) => row.status !== "pending" && row.resolvedAt)
        .sort((a, b) => (b.resolvedAt?.getTime() ?? 0) - (a.resolvedAt?.getTime() ?? 0))[0];
    const owner = task.assignedAgentId
        ? { type: "agent" as const, id: task.assignedAgentId, name: names.agent(task.assignedAgentId) ?? "Agent" }
        : task.assignedMemberId
            ? { type: "human" as const, id: task.assignedMemberId, name: names.member(task.assignedMemberId) ?? "Someone" }
            : null;
    const canEdit = !["viewer"].includes(viewer.role);

    return {
        task: {
            id: task.id,
            title: inputField(task.inputJson, "title") ?? task.taskType,
            description: inputField(task.inputJson, "description") ?? inputField(task.inputJson, "prompt"),
            state: task.state,
            priority: task.priority,
            taskType: task.taskType,
            blockedReason: inputField(task.inputJson, "blockedReason"),
            humanApprovalRequired: task.humanApprovalRequired,
            createdAt: task.createdAt.toISOString(),
            updatedAt: task.updatedAt.toISOString(),
            projectId: task.projectId,
            projectName: task.projectName ?? "Project",
            customerId: task.customerId,
            customerName: task.customerName,
            owner,
            approval: {
                pending,
                latest: latestDecided ? { status: latestDecided.status, at: latestDecided.resolvedAt!.toISOString(), resolverName: names.member(latestDecided.resolverUserId) } : null,
            },
        },
        entries: page.entries,
        hasMore: page.hasMore,
        nextBefore: page.nextBefore,
        live,
        assignees: canEdit
            ? { agents: agentScope ? names.agentList.filter((agent) => agentScope.includes(agent.id)) : names.agentList, members: viewer.scope ? [] : names.memberList }
            : { agents: [], members: [] },
    };
}

async function buildLiveView(
    companyId: string,
    running: (typeof agentRuns.$inferSelect)[],
    visible: (threadId: string | null) => boolean,
    threads: Map<string, ThreadInfo>,
    names: StoryNames,
    state: string,
    now: Date,
): Promise<TaskLiveView> {
    if (running.length === 0) return { runs: [], state, serverNow: now.toISOString() };
    const ids = running.map((run) => run.id);
    const [tails, stalls] = await Promise.all([
        loadRunEventsTail(companyId, ids, 40),
        loadStallSignals(companyId, { runIds: ids, now }),
    ]);
    const stallByRun = new Map(stalls.map((signal) => [signal.runId, signal]));
    return {
        state,
        serverNow: now.toISOString(),
        runs: running.map((run) => {
            const isVisible = visible(run.threadId);
            let live = buildRunLive(run, tails.get(run.id) ?? [], now);
            if (!isVisible) {
                live = {
                    ...live,
                    current: { kind: live.current.kind, summary: PRIVATE_ACTIVITY, sinceMs: live.current.sinceMs },
                    steps: [],
                };
            }
            const thread = run.threadId ? threads.get(run.threadId) : undefined;
            return {
                live,
                agentName: names.agent(run.agentId),
                private: !isVisible,
                lastUsefulAt: stallByRun.get(run.id)?.lastUsefulAt ?? run.startedAt.toISOString(),
                threadHref: isVisible ? runThreadLink({ threadId: run.threadId, threadType: thread?.type ?? null, agentId: run.agentId }) : null,
            };
        }),
    };
}

/** Just the live part, for the page's adaptive poll. Null when the viewer may not see the task. */
export async function loadTaskLive(companyId: string, taskId: string, viewer: TaskViewer, now: Date = new Date()): Promise<TaskLiveView | null> {
    const task = await loadScopedTask(companyId, taskId, viewer);
    if (!task) return null;
    const agentScope = scopedAgentIds(viewer.scope);
    const running = await db.select().from(agentRuns).where(and(
        eq(agentRuns.companyId, companyId),
        eq(agentRuns.taskId, taskId),
        eq(agentRuns.status, "running"),
        agentScope ? inArray(agentRuns.agentId, agentScope) : undefined,
    )).orderBy(desc(agentRuns.startedAt)).limit(5);
    if (running.length === 0) return { runs: [], state: task.state, serverNow: now.toISOString() };
    const [names, threads, visibility] = await Promise.all([
        loadNames(companyId, viewer),
        loadThreads(companyId, running.map((run) => run.threadId)),
        loadThreadVisibility(companyId, running.map((run) => run.threadId), viewer.userId),
    ]);
    return buildLiveView(companyId, running, visibility.visible, threads, names, task.state, now);
}
