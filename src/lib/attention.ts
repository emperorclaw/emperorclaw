/**
 * "Needs me": everything waiting on the signed-in person, built in ONE place.
 * The dashboard's Action inbox, the /inbox page and the Inbox nav badge all
 * call buildAttention, so the badge count is always what the page lists.
 *
 * Entries are already filtered for the viewer: member scope (restricted
 * members see only their agents and customers), private direct chats (never
 * another person's), and agent pair threads (owners and admins only). The
 * ordering and grouping rules are pure and live in src/lib/attention-rules.ts.
 */

import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    agentRequests, agentRuns, agents, companyMembers, customers, incidents, messageThreads, notifications, projects, taskEvents, tasks, threadMessages, threadParticipants, users,
} from "@/db/schema";
import type { SessionWithUserId } from "@/lib/auth";
import { computeCompanyHealth, OFFLINE_AFTER_MS, type CompanyHealth } from "@/lib/agent-health";
import { listPendingDecisions } from "@/lib/approvals";
import { directThreadLink, userMayUseThread } from "@/lib/direct-chat-mode";
import { isAgentPairThread } from "@/lib/groups";
import { getScopedAgentIds, getScopedCustomerIds } from "@/lib/member-scope";
import { requireRole, type GuardContext } from "@/lib/roles";
import { canAdmin, canWrite } from "@/lib/role-matrix";
import { isMissingSchemaError } from "@/lib/schema-compat";
import { TASK_STATES } from "@/lib/task-state";
import { classifyIncident, filterPausedNotices, isIncidentStale, type AttentionEntry, type PausedNotice } from "@/lib/team-scene";
import { loadStallSignals } from "@/lib/stall-signal-reads";
import { stallLabel } from "@/lib/stall-signal";
import { taskHref as taskPageHref } from "@/lib/task-story";
import { describeFailure, fixAudience, type FailureView } from "@/lib/failure-cause";
import { applyAttentionScope, attentionCounts, latestFailedRuns, plainText, workingNowAgentIds, sortAttention, type AttentionCounts, type AttentionScope } from "@/lib/attention-rules";

export * from "@/lib/attention-rules";

/** Who is looking, and what they may see and do. */
export interface AttentionAccess {
    userId: string | null;
    /** Owners, admins and instance admins: may see agent pair threads. */
    isOwnerOrAdmin: boolean;
    /** Everyone but viewers: may use the inline actions. */
    canAct: boolean;
    /** Null for unrestricted members. */
    scope: AttentionScope | null;
}

/** Access from the central role guard: role and member scope both read from the DB. */
export function attentionAccessFromGuard(ctx: GuardContext): AttentionAccess {
    return {
        userId: ctx.userId,
        isOwnerOrAdmin: canAdmin(ctx.role),
        canAct: canWrite(ctx.role),
        scope: ctx.scope ? { agentIds: getScopedAgentIds(ctx.scope), customerIds: getScopedCustomerIds(ctx.scope) } : null,
    };
}

/** Nothing visible, nothing allowed: used when the viewer cannot be resolved. */
const NO_ATTENTION_ACCESS: AttentionAccess = { userId: null, isOwnerOrAdmin: false, canAct: false, scope: { agentIds: [], customerIds: [] } };

/**
 * The signed-in viewer's access. Role and scope come from requireRole (the
 * DB), never the session's login-time copies; the session argument is kept
 * for callers but only identifies who is asking. Fails closed.
 */
export async function attentionAccessForSession(session: SessionWithUserId | null): Promise<AttentionAccess> {
    if (!session?.user?.id) return NO_ATTENTION_ACCESS;
    const ctx = await requireRole("viewer")().catch(() => null);
    if (!ctx || ctx.userId !== session.user.id) return NO_ATTENTION_ACCESS;
    return attentionAccessFromGuard(ctx);
}

/** A reassignment target for the inline Reassign menu. */
export interface AttentionAgent {
    key: string;
    id: string;
    name: string;
    role: string | null;
}

export interface AttentionResult {
    generatedAt: string;
    entries: AttentionEntry[];
    counts: AttentionCounts;
    /** Agents the viewer may reassign work to (already member-scoped). */
    agents: AttentionAgent[];
    /** Agents working now (attention-rules workingNowAgentIds), member-scoped: the Home badge and the dashboard card. */
    workingNow: string[];
}

/** Data the dashboard already loaded, so it is not queried twice. */
export interface AttentionPreload {
    now?: Date;
    health?: CompanyHealth;
    decisions?: Awaited<ReturnType<typeof listPendingDecisions>>;
}

const FAILED_RUN_WINDOW_MS = 24 * 60 * 60 * 1000;
const BLOCKED_TASK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const NOTIFICATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function taskTitle(inputJson: unknown, taskType: string): string {
    const input = inputJson && typeof inputJson === "object" ? inputJson as Record<string, unknown> : {};
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : taskType;
}

function excerpt(text: string, max = 60): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const humanize = (value: string) => value.replace(/_/g, " ");

/** The reason line for a failure: its plain cause, plus the short raw text when the cause is unknown. */
function failureReason(failure: FailureView): string {
    return failure.detail ? `${failure.headline}: ${failure.detail}` : failure.headline;
}

function blockedReasonOf(inputJson: unknown): string | null {
    const input = inputJson && typeof inputJson === "object" ? inputJson as Record<string, unknown> : {};
    return typeof input.blockedReason === "string" && input.blockedReason.trim() ? input.blockedReason.trim() : null;
}

/** A short human reason for a "stuck" incident, from its structured code. */
function shortReason(reasonCode: string): string {
    const code = reasonCode.replace(/_/g, " ").trim();
    if (code === "max retries exceeded") return "task exceeded retries";
    return code;
}

function taskHref(projectId: string | null, taskId: string | null): string {
    if (!projectId) return "/projects";
    return taskId ? `/projects?project=${projectId}&task=${taskId}` : `/projects?project=${projectId}`;
}

/** Notifications predate migration 0046 on old installs: an empty list, never a broken inbox. */
async function tolerateMissingSchema<T>(promise: Promise<T>, fallback: T): Promise<T> {
    try {
        return await promise;
    } catch (error) {
        if (isMissingSchemaError(error)) return fallback;
        throw error;
    }
}

export async function buildAttention(companyId: string, access: AttentionAccess, preload: AttentionPreload = {}): Promise<AttentionResult> {
    const now = preload.now ?? new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    // Failure fixes are filtered for the viewer here: viewers get none, admin-only fixes need an owner or admin.
    const audience = fixAudience(access);

    const scopedAgentIds = access.scope?.agentIds;
    const [agentRows, members, projectRows, customerRows, inProgress, decisions, openIncidents, typing, health, openRuns, recentRuns, blockedTasks, requestRows, mine, stalls] = await Promise.all([
        db.select({ id: agents.id, name: agents.name, role: agents.role, provider: agents.provider, deploymentMode: agents.deploymentMode })
            .from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
        db.select({ id: companyMembers.id, displayName: users.displayName, email: users.email })
            .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
            .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
        db.select({ id: projects.id, goal: projects.goal, customerId: projects.customerId }).from(projects).where(eq(projects.companyId, companyId)),
        db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.companyId, companyId)),
        db.select({ id: tasks.id, assignedAgentId: tasks.assignedAgentId }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.inProgress), isNull(tasks.deletedAt), isNotNull(tasks.assignedAgentId))),
        preload.decisions ?? listPendingDecisions(companyId),
        db.select({ id: incidents.id, summary: incidents.summary, projectId: incidents.projectId, taskId: incidents.taskId, reasonCode: incidents.reasonCode, createdAt: incidents.createdAt, taskState: tasks.state, taskDeletedAt: tasks.deletedAt, taskType: tasks.taskType, inputJson: tasks.inputJson, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(incidents).leftJoin(tasks, and(eq(tasks.id, incidents.taskId), eq(tasks.companyId, companyId)))
            .where(and(eq(incidents.companyId, companyId), eq(incidents.status, "open"), isNull(incidents.deletedAt))).orderBy(desc(incidents.createdAt)).limit(50),
        db.select({ agentId: threadParticipants.participantId }).from(threadParticipants)
            .where(and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"), gte(threadParticipants.typingUntil, now))),
        preload.health ?? computeCompanyHealth(companyId, { now }),
        // A freshly opened run is live evidence: see the dashboard's note.
        db.selectDistinct({ agentId: agentRuns.agentId }).from(agentRuns)
            .where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.status, "running"), gte(agentRuns.startedAt, new Date(now.getTime() - OFFLINE_AFTER_MS)), isNotNull(agentRuns.agentId))),
        db.select({ id: agentRuns.id, agentId: agentRuns.agentId, status: agentRuns.status, startedAt: agentRuns.startedAt, endedAt: agentRuns.endedAt, taskId: agentRuns.taskId, threadId: agentRuns.threadId, error: agentRuns.error, exitReason: agentRuns.exitReason })
            .from(agentRuns).where(and(eq(agentRuns.companyId, companyId), gte(agentRuns.startedAt, new Date(now.getTime() - FAILED_RUN_WINDOW_MS)), isNotNull(agentRuns.agentId)))
            .orderBy(desc(agentRuns.startedAt)).limit(500),
        db.select({ id: tasks.id, projectId: tasks.projectId, state: tasks.state, inputJson: tasks.inputJson, taskType: tasks.taskType, updatedAt: tasks.updatedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [TASK_STATES.failed, TASK_STATES.deadLetter, TASK_STATES.blocked]), isNull(tasks.deletedAt), gte(tasks.updatedAt, new Date(now.getTime() - BLOCKED_TASK_WINDOW_MS))))
            .orderBy(desc(tasks.updatedAt)).limit(50),
        db.select({ id: agentRequests.id, taskId: agentRequests.taskId, source: agentRequests.source, requestedBy: agentRequests.requestedBy })
            .from(agentRequests).where(and(eq(agentRequests.companyId, companyId), isNotNull(agentRequests.taskId), gte(agentRequests.createdAt, new Date(now.getTime() - BLOCKED_TASK_WINDOW_MS)))),
        access.userId
            ? tolerateMissingSchema(db.select({ id: notifications.id, kind: notifications.kind, title: notifications.title, body: notifications.body, link: notifications.link, sourceId: notifications.sourceId, createdAt: notifications.createdAt })
                .from(notifications).where(and(
                    eq(notifications.companyId, companyId), eq(notifications.userId, access.userId), isNull(notifications.readAt),
                    inArray(notifications.kind, ["mention", "decision"]), gte(notifications.createdAt, new Date(now.getTime() - NOTIFICATION_WINDOW_MS)),
                )).orderBy(desc(notifications.createdAt)).limit(30), [])
            : Promise.resolve([]),
        // Runs making no progress (src/lib/stall-signal-reads.ts), narrowed to the member's agents.
        scopedAgentIds && scopedAgentIds.length === 0 ? Promise.resolve([]) : loadStallSignals(companyId, { now, onlyStalled: true, agentIds: scopedAgentIds, limit: 50 }),
    ]);

    const projectById = new Map(projectRows.map((p) => [p.id, p]));
    const customerName = new Map(customerRows.map((c) => [c.id, c.name]));
    const context = (projectId: string | null | undefined) => {
        const project = projectId ? projectById.get(projectId) : undefined;
        return {
            projectId: projectId ?? null,
            area: project?.goal ?? null,
            customerId: project?.customerId ?? null,
            customerName: project?.customerId ? customerName.get(project.customerId) ?? null : null,
        };
    };
    const nameByKey = new Map<string, string>([
        ...agentRows.map((a) => [`agent:${a.id}`, a.name] as const),
        ...members.map((m) => [`human:${m.id}`, m.displayName || m.email] as const),
    ]);
    const assigneeKey = (t: { assignedAgentId: string | null; assignedMemberId: string | null }) =>
        t.assignedAgentId ? `agent:${t.assignedAgentId}` : t.assignedMemberId ? `human:${t.assignedMemberId}` : null;
    const memberName = (key: string | null) => key ? nameByKey.get(key) ?? null : null;
    const canRestart = (agentId: string) => agentRows.some((a) => a.id === agentId && a.provider === "hermes" && a.deploymentMode === "local");
    const typingAgents = new Set(typing.flatMap((t) => t.agentId ? [t.agentId] : []));
    const agentsWithOpenRun = new Set(openRuns.flatMap((r) => r.agentId ? [r.agentId] : []));

    // Latest assignment per incident task: a watchdog incident that predates
    // the task's current assignment belongs to a previous owner.
    const incidentTaskIds = [...new Set(openIncidents.map((i) => i.taskId).filter((id): id is string => Boolean(id)))];

    // Threads that decide what this viewer may see: delivery items and failed
    // runs in private direct chats belong to the chat's owner only.
    const messageIds = health.attention.map((item) => item.messageId);
    const runThreadIds = [...new Set([...recentRuns, ...stalls].flatMap((r) => r.threadId ? [r.threadId] : []))];
    // Tasks behind stalled and failed runs: their current assignee is who a
    // Nudge or Retry goes to (the task may have moved since the run).
    const failedRuns = latestFailedRuns(recentRuns);
    const stallTaskIds = [...new Set([...stalls, ...failedRuns].flatMap((r) => r.taskId ? [r.taskId] : []))];

    const [assignmentEvents, pausedNoticeRows, messageThreadRows, runThreadRows, stallTasks] = await Promise.all([
        incidentTaskIds.length
            ? db.select({ taskId: taskEvents.taskId, createdAt: taskEvents.createdAt })
                .from(taskEvents).where(and(eq(taskEvents.companyId, companyId), inArray(taskEvents.taskId, incidentTaskIds), inArray(taskEvents.eventType, ["task_generated", "task_assigned", "task_reassigned", "task_claimed"])))
                .orderBy(desc(taskEvents.createdAt))
            : Promise.resolve([]),
        db.select({ id: threadMessages.id, threadId: threadMessages.threadId, createdAt: threadMessages.createdAt, description: messageThreads.description, createdByType: messageThreads.createdByType })
            .from(threadMessages).innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
            .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.senderType, "system"), sql`${threadMessages.metadataJson}->>'loopGuard' = 'true'`, gte(threadMessages.createdAt, dayAgo)))
            .orderBy(desc(threadMessages.createdAt)).limit(10),
        messageIds.length
            ? db.select({ messageId: threadMessages.id, threadId: messageThreads.id, type: messageThreads.type, ownerUserId: messageThreads.ownerUserId, isPrivate: messageThreads.isPrivate, directAgentId: messageThreads.directAgentId, senderType: threadMessages.senderType, senderId: threadMessages.senderId, metadataJson: threadMessages.metadataJson })
                .from(threadMessages).innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
                .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.id, messageIds)))
            : Promise.resolve([]),
        runThreadIds.length
            ? db.select({ id: messageThreads.id, type: messageThreads.type, ownerUserId: messageThreads.ownerUserId, isPrivate: messageThreads.isPrivate, directAgentId: messageThreads.directAgentId })
                .from(messageThreads).where(and(eq(messageThreads.companyId, companyId), inArray(messageThreads.id, runThreadIds)))
            : Promise.resolve([]),
        stallTaskIds.length
            ? db.select({ id: tasks.id, projectId: tasks.projectId, inputJson: tasks.inputJson, taskType: tasks.taskType, deletedAt: tasks.deletedAt, assignedAgentId: tasks.assignedAgentId })
                .from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.id, stallTaskIds)))
            : Promise.resolve([]),
    ]);
    const latestAssignmentAt = new Map<string, string>();
    for (const e of assignmentEvents) {
        if (!latestAssignmentAt.has(e.taskId)) latestAssignmentAt.set(e.taskId, e.createdAt.toISOString());
    }

    // A "Resume" marker newer than a notice means the loop is no longer paused.
    const pausedThreadIds = [...new Set(pausedNoticeRows.map((n) => n.threadId))];
    const resumeRows = pausedThreadIds.length
        ? await db.select({ threadId: threadMessages.threadId, createdAt: threadMessages.createdAt })
            .from(threadMessages).where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, pausedThreadIds), sql`${threadMessages.metadataJson}->>'loopGuardResume' = 'true'`))
            .orderBy(desc(threadMessages.createdAt))
        : [];
    const latestResumeByThread = new Map<string, string>();
    for (const r of resumeRows) {
        if (!latestResumeByThread.has(r.threadId)) latestResumeByThread.set(r.threadId, r.createdAt.toISOString());
    }
    const pausedNotices: PausedNotice[] = filterPausedNotices(
        pausedNoticeRows.map((n) => ({
            id: n.id, threadId: n.threadId, createdAt: n.createdAt.toISOString(),
            isPairThread: isAgentPairThread({ description: n.description, createdByType: n.createdByType }),
        })),
        latestResumeByThread,
        access.isOwnerOrAdmin,
    );

    const entries: AttentionEntry[] = [];
    const coveredTasks = new Set<string>();

    // Task problems and watchdog timing signals.
    for (const i of openIncidents) {
        const cls = classifyIncident(i.reasonCode, i.summary);
        const stale = isIncidentStale({
            classification: cls,
            taskState: i.taskState ?? null,
            incidentCreatedAt: i.createdAt.toISOString(),
            currentAssignmentAt: i.taskId ? latestAssignmentAt.get(i.taskId) ?? null : null,
            taskDeleted: i.taskDeletedAt !== null,
        });
        if (stale) continue;
        if (i.taskId) coveredTasks.add(i.taskId);
        const title = i.inputJson || i.taskType ? taskTitle(i.inputJson, i.taskType ?? "task") : excerpt(i.summary);
        const key = assigneeKey({ assignedAgentId: i.assignedAgentId ?? null, assignedMemberId: i.assignedMemberId ?? null });
        const base = {
            id: `incident:${i.id}`, title, memberKey: key, memberName: memberName(key), at: i.createdAt.toISOString(),
            actionLabel: "Open task", href: taskHref(i.projectId, i.taskId), taskId: i.taskId, ...context(i.projectId),
        };
        if (cls === "problem") {
            // A known cause (credits, key, scope...) replaces the watchdog's code; an unknown one keeps it (and Reassign).
            const failure = describeFailure({ texts: [i.summary, i.reasonCode] }, { audience, agentId: i.assignedAgentId ?? null, taskId: i.taskId });
            entries.push(failure.cause === "unknown"
                ? { ...base, kind: "incident", reason: shortReason(i.reasonCode) }
                : { ...base, kind: "incident", reason: failure.headline, failure, agentId: i.assignedAgentId ?? null });
        }
        else if (cls === "late") entries.push({ ...base, kind: "late" });
        else entries.push({ ...base, kind: "not_started", actionRequired: !key });
    }

    // Offline agents with work waiting: unanswered messages (health "down") or
    // in-progress tasks they hold but cannot be working on.
    // A paused budget blocks every turn, so it is listed even while connected.
    const holdsInProgress = new Set(inProgress.flatMap((t) => t.assignedAgentId ? [t.assignedAgentId] : []));
    for (const a of health.agents.filter((h) => !typingAgents.has(h.id)
        && (h.status === "down" || h.budgetStatus === "paused" || (!h.online && !agentsWithOpenRun.has(h.id) && holdsInProgress.has(h.id))))) {
        const offline = !a.online && !agentsWithOpenRun.has(a.id);
        const failure = describeFailure(
            { texts: [a.providerIssue], budgetStatus: a.budgetStatus, offline },
            { audience, agentId: a.id, canRestartRuntime: canRestart(a.id) },
        );
        entries.push({
            id: `agent:${a.id}`, kind: "agent",
            title: failure.cause !== "runtime_offline" ? `${a.name} is blocked` : a.status === "down" ? `${a.name} has no recent connection with work waiting` : `${a.name} is offline with work in progress`,
            reason: failure.headline, failure,
            memberKey: `agent:${a.id}`, memberName: a.name, area: a.role, at: a.lastSeenAt ?? now.toISOString(),
            actionLabel: "Inspect connection", href: `/agents?agent=${a.id}`, agentId: a.id, canRestartRuntime: canRestart(a.id),
        });
    }

    // Approvals: one entry per request, however many tasks it covers.
    for (const { approval, tasks: linked } of decisions.approvals) {
        const first = linked[0];
        const what = first ? taskTitle(first.inputJson, first.taskType) : approval.rationale ? excerpt(approval.rationale, 48) : humanize(approval.actionType);
        const key = approval.requesterAgentId ? `agent:${approval.requesterAgentId}` : null;
        for (const t of linked) coveredTasks.add(t.id);
        entries.push({
            id: `approval:${approval.id}`, kind: "approval",
            title: approval.actionType === "task_done" ? `Approve ${excerpt(what, 52)}` : `Approve ${humanize(approval.actionType)}: ${excerpt(what, 40)}`,
            memberKey: key, memberName: memberName(key), at: approval.requestedAt.toISOString(),
            actionLabel: approval.actionType === "task_done" ? "Review work" : "Review request", href: "/approvals",
            approvalId: approval.id, taskId: first?.id ?? null, taskCount: linked.length,
            detail: approval.rationale ? excerpt(approval.rationale, 180) : null,
            ...context(approval.projectId),
        });
    }
    // Tasks that require approval and have no request yet.
    for (const t of decisions.implicit) {
        const key = assigneeKey(t);
        coveredTasks.add(t.id);
        entries.push({
            id: `approval:task:${t.id}`, kind: "approval", title: `Approve ${excerpt(taskTitle(t.inputJson, t.taskType), 52)}`,
            memberKey: key, memberName: memberName(key), at: t.updatedAt.toISOString(), actionLabel: "Review work", href: "/approvals",
            taskId: t.id, taskCount: 1, ...context(t.projectId),
        });
    }

    // Message delivery: failed or unanswered. A private direct chat is its
    // owner's alone, so nobody else sees (or is linked to) its items.
    const threadByMessage = new Map(messageThreadRows.map((r) => [r.messageId, r]));
    for (const item of health.attention) {
        const thread = threadByMessage.get(item.messageId);
        if (thread && !userMayUseThread(thread, access.userId)) continue;
        const href = thread?.type === "direct" ? directThreadLink(thread.threadId, item.agentId) : item.link;
        let failure: FailureView | null = null;
        if (item.kind === "failed") {
            const runtimeFailure = ((thread?.metadataJson as Record<string, unknown> | null)?.runtimeFailure ?? {}) as { reason?: unknown; at?: unknown };
            // Only the sender may retry a message (src/lib/direct-message-queue.ts).
            const ownMessage = thread?.senderType === "human" && Boolean(access.userId) && thread.senderId === access.userId;
            failure = describeFailure(
                { texts: [typeof runtimeFailure.reason === "string" ? runtimeFailure.reason : null] },
                { audience, agentId: item.agentId, retryMessageId: ownMessage ? item.messageId : null, canRestartRuntime: canRestart(item.agentId), failedAt: typeof runtimeFailure.at === "string" ? runtimeFailure.at : item.since },
            );
        }
        entries.push({
            id: `message:${item.messageId}`, kind: "message",
            title: item.kind === "failed" ? `Message failed: “${excerpt(item.text, 40)}”` : `Awaiting agent response: “${excerpt(item.text, 36)}”`,
            ...(failure ? { reason: failureReason(failure), failure } : {}),
            memberKey: `agent:${item.agentId}`, memberName: item.agentName, area: "Messages", at: item.since,
            actionLabel: item.kind === "failed" ? "Inspect delivery" : "Open chat", href, threadId: thread?.threadId ?? null,
            actionRequired: item.kind === "failed",
        });
    }

    for (const n of pausedNotices) {
        entries.push({
            id: `paused:${n.id}`, kind: "paused", title: "Agents were going back and forth without progress",
            memberKey: null, memberName: null, area: "Team chat", at: n.createdAt,
            actionLabel: "Resume", href: "/messages", threadId: n.threadId,
        });
    }

    // Failed runs: the latest per agent, while it is still the latest.
    const runThreadById = new Map(runThreadRows.map((t) => [t.id, t]));
    const healthById = new Map(health.agents.map((a) => [a.id, a]));
    const runTaskById = new Map(stallTasks.map((t) => [t.id, t]));
    for (const run of failedRuns) {
        if (!run.agentId) continue;
        const thread = run.threadId ? runThreadById.get(run.threadId) : undefined;
        if (thread && !userMayUseThread(thread, access.userId)) continue;
        // An offline-agent entry already covers a dead runtime, and an
        // incident or approval already covers its task.
        if (entries.some((e) => e.kind === "agent" && e.agentId === run.agentId)) continue;
        if (run.taskId && coveredTasks.has(run.taskId)) continue;
        if (run.taskId) coveredTasks.add(run.taskId);
        const name = healthById.get(run.agentId)?.name ?? agentRows.find((a) => a.id === run.agentId)?.name ?? "Agent";
        const failure = describeFailure(
            { texts: [run.error, run.exitReason], runStatus: run.status, budgetStatus: healthById.get(run.agentId)?.budgetStatus },
            {
                audience, agentId: run.agentId, taskId: run.taskId,
                taskAssigneeId: run.taskId ? runTaskById.get(run.taskId)?.assignedAgentId ?? null : null,
                canRestartRuntime: canRestart(run.agentId), failedAt: (run.endedAt ?? run.startedAt).toISOString(),
            },
        );
        entries.push({
            id: `run:${run.id}`, kind: "run_failed", title: `${name}'s last run ${run.status === "timeout" ? "timed out" : run.status === "lost" ? "was lost" : "failed"}`,
            reason: failureReason(failure), failure, memberKey: `agent:${run.agentId}`, memberName: name, area: healthById.get(run.agentId)?.role ?? null,
            at: (run.endedAt ?? run.startedAt).toISOString(), actionLabel: "Open runs", href: `/agents?agent=${run.agentId}`,
            agentId: run.agentId, runId: run.id, canRestartRuntime: canRestart(run.agentId),
        });
    }

    // Failed, dead-lettered or blocked tasks nothing above already covers;
    // an external request's task says where the request came from.
    const requestByTask = new Map(requestRows.flatMap((r) => r.taskId ? [[r.taskId, r] as const] : []));
    for (const t of blockedTasks) {
        if (coveredTasks.has(t.id)) continue;
        coveredTasks.add(t.id);
        const key = assigneeKey(t);
        const request = requestByTask.get(t.id);
        const state = t.state === TASK_STATES.blocked ? "Blocked" : t.state === TASK_STATES.deadLetter ? "Gave up after retries" : "Failed";
        // A blocked reason naming a known cause (out of credits, outside scope...) gets its fix; anything else keeps Reassign.
        const blockedReason = blockedReasonOf(t.inputJson);
        const failure = blockedReason ? describeFailure({ texts: [blockedReason] }, { audience, agentId: t.assignedAgentId, taskId: t.id }) : null;
        const known = failure && failure.cause !== "unknown" ? failure : null;
        const stateLine = known ? `${state}: ${known.headline}` : state;
        entries.push({
            id: request ? `request:${request.id}` : `task:${t.id}`, kind: request ? "request" : "task_blocked",
            title: taskTitle(t.inputJson, t.taskType),
            reason: request ? `${stateLine}. Requested from ${request.requestedBy ? `${request.requestedBy} via ` : ""}${request.source}` : stateLine,
            ...(known ? { failure: known } : {}),
            memberKey: key, memberName: memberName(key), at: t.updatedAt.toISOString(),
            actionLabel: "Open task", href: taskHref(t.projectId, t.id), taskId: t.id, ...context(t.projectId),
        });
    }

    // Runs still open but making no progress: one item per run, linked to its
    // task page. Skipped when the runtime is already reported offline, the
    // task already has an item above, or the run lives in someone else's
    // private chat.
    const stallTaskById = new Map(stallTasks.map((t) => [t.id, t]));
    for (const stall of stalls) {
        if (!stall.agentId) continue;
        const thread = stall.threadId ? runThreadById.get(stall.threadId) : undefined;
        if (thread && !userMayUseThread(thread, access.userId)) continue;
        if (entries.some((e) => e.kind === "agent" && e.agentId === stall.agentId)) continue;
        const task = stall.taskId ? stallTaskById.get(stall.taskId) : undefined;
        if (stall.taskId && (!task || task.deletedAt)) continue;
        if (task && coveredTasks.has(task.id)) continue;
        if (task) coveredTasks.add(task.id);
        const name = healthById.get(stall.agentId)?.name ?? agentRows.find((a) => a.id === stall.agentId)?.name ?? "Agent";
        const stallFailure = describeFailure({ stalled: true, idleMs: stall.idleMs }, { audience, agentId: stall.agentId, taskId: task?.id ?? null, taskAssigneeId: task?.assignedAgentId ?? null });
        entries.push({
            id: `stall:${stall.runId}`, kind: "stalled",
            title: task ? taskTitle(task.inputJson, task.taskType) : `${name} is running with no progress`,
            reason: stallLabel(stall), failure: { ...stallFailure, headline: stallLabel(stall) }, memberKey: `agent:${stall.agentId}`, memberName: name,
            at: stall.lastUsefulAt, actionLabel: task ? "Open task" : "Open agent",
            href: task ? taskPageHref(task.id, stall.runId) : `/agents?agent=${stall.agentId}`,
            agentId: stall.agentId, runId: stall.runId, taskId: task?.id ?? null, canRestartRuntime: canRestart(stall.agentId),
            ...(task ? context(task.projectId) : { area: healthById.get(stall.agentId)?.role ?? null }),
        });
    }

    // Mentions and decisions addressed to this person (already filtered for
    // private chats when they were written: src/lib/notifications.ts).
    for (const n of mine) {
        entries.push({
            id: `notification:${n.id}`, kind: n.kind === "decision" ? "decision" : "mention",
            title: n.title, detail: n.body ? excerpt(plainText(n.body), 180) || null : null,
            memberKey: null, memberName: null, area: "Messages", at: n.createdAt.toISOString(),
            actionLabel: "Open conversation", href: n.link || "/messages", notificationId: n.id,
        });
    }

    const visible = sortAttention(applyAttentionScope(entries, access.scope));
    const scopedAgents = scopedAgentIds ? new Set(scopedAgentIds) : null;
    const workingNow = workingNowAgentIds({
        typing: typingAgents,
        connected: new Set([...health.agents.filter((a) => a.online).map((a) => a.id), ...agentsWithOpenRun]),
        down: new Set(health.agents.filter((a) => a.status === "down").map((a) => a.id)),
        inProgress: inProgress.flatMap((t) => t.assignedAgentId ? [{ agentId: t.assignedAgentId, taskId: t.id }] : []),
        entries,
    }).filter((id) => agentRows.some((a) => a.id === id) && (!scopedAgents || scopedAgents.has(id)));
    return {
        generatedAt: now.toISOString(),
        entries: visible,
        counts: attentionCounts(visible),
        workingNow,
        agents: agentRows
            .filter((a) => !scopedAgents || scopedAgents.has(a.id))
            .map((a) => ({ key: `agent:${a.id}`, id: a.id, name: a.name, role: a.role }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    };
}
