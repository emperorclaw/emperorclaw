import { redirect } from "next/navigation";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    agents, approvals, approvalTaskLinks, companies, companyMembers, incidents, messageThreads, projects, taskEvents, tasks, threadMessages, threadParticipants, tokenUsageLog, users,
} from "@/db/schema";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { computeCompanyHealth } from "@/lib/agent-health";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import { AGENT_PAIR_DESCRIPTION, isAgentPairThread, listGroups } from "@/lib/groups";
import { SetupWizard } from "@/components/setup-wizard";
import { BUSINESS_TYPES } from "@/lib/onboarding-shared";
import { sceneMessagePreview } from "@/lib/observatory";
import { TeamDashboard } from "@/components/team-dashboard/team-dashboard";
import {
    dashboardActivity, attentionUrgency, buildFeed, classifyIncident, DONE_TODAY_MS, filterPausedNotices, isIncidentStale, skillNames,
    type SceneCommunication, type ActivityEvent, type AttentionEntry, type CollaborationEvent, type CostSummary, type DashboardData, type DashboardMember, type DashboardTask, type FeedEvent, type PairThreadActivity, type PausedNotice, type ThroughputSummary,
} from "@/lib/team-scene";

export const dynamic = "force-dynamic";

const BOARD_LIMIT = 100;

function taskTitle(inputJson: unknown, taskType: string): string {
    const input = inputJson && typeof inputJson === "object" ? inputJson as Record<string, unknown> : {};
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : taskType;
}

function excerpt(text: string, max = 60): string {
    const clean = text.replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

const humanize = (value: string) => value.replace(/_/g, " ");

/** A short human reason for a "stuck" incident, from its structured code. */
function shortReason(reasonCode: string): string {
    const code = reasonCode.replace(/_/g, " ").trim();
    if (code === "max retries exceeded") return "task exceeded retries";
    return code;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
    const session = await getValidatedServerSession();
    const params = await searchParams;
    const view: "list" | "pulse" | "scene" | "teams" | undefined = params.view === "teams" ? "teams" : params.view === "list" ? "list" : params.view === "pulse" ? "pulse" : params.view === "scene" ? "scene" : undefined;
    const companyId = await getCompanyId();
    if (!companyId) {
        // A fresh self-hosted install has no company yet. Send the operator to
        // account creation instead of a login form no account can satisfy.
        const [companyCount] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(companies).where(isNull(companies.deletedAt));
        redirect((companyCount?.count ?? 0) === 0 ? "/signup" : "/login");
    }
    const userId = session?.user?.id ?? null;
    const now = new Date();
    const dayAgo = new Date(now.getTime() - DONE_TODAY_MS);
    const weekAgo = new Date(now.getTime() - 7 * DONE_TODAY_MS);

    // Role gating for the inline actions: viewers read only; owners/admins may
    // also open machine-managed pair threads.
    const instanceRole = session?.user?.instanceRole ?? "member";
    const companyRole = session?.user?.companyRole ?? null;
    const canAct = instanceRole === "instance_admin" || companyRole !== "viewer";
    const isOwnerOrAdmin = instanceRole === "instance_admin" || companyRole === "owner" || companyRole === "admin";

    const [[company], [currentUser], members, agentRows, openTasks, pendingApprovals, openIncidents, typing, health, projectRows, recentEvents, usageToday, blockedCount] = await Promise.all([
        db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1),
        userId
            ? db.select({ onboardingCompletedAt: users.onboardingCompletedAt, onboardingDismissedAt: users.onboardingDismissedAt }).from(users).where(eq(users.id, userId)).limit(1)
            : Promise.resolve([]),
        db.select({ id: companyMembers.id, userId: users.id, displayName: users.displayName, email: users.email, roleTitle: users.roleTitle })
            .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
            .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
        db.select({ id: agents.id, name: agents.name, role: agents.role, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance, provider: agents.provider, deploymentMode: agents.deploymentMode, skillsJson: agents.skillsJson, createdAt: agents.createdAt, monthlyBudgetCents: agents.monthlyBudgetCents, monthlyCostCents: agents.monthlyCostCents })
            .from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
        db.select({ id: tasks.id, projectId: tasks.projectId, state: tasks.state, inputJson: tasks.inputJson, taskType: tasks.taskType, slaDueAt: tasks.slaDueAt, priority: tasks.priority, updatedAt: tasks.updatedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.priority), tasks.createdAt),
        db.select({ id: approvals.id, requestedAt: approvals.requestedAt, actionType: approvals.actionType, rationale: approvals.rationale, projectId: approvals.projectId, requesterAgentId: approvals.requesterAgentId, taskInput: tasks.inputJson, taskType: tasks.taskType })
            .from(approvals)
            .leftJoin(approvalTaskLinks, eq(approvalTaskLinks.approvalId, approvals.id))
            .leftJoin(tasks, and(eq(tasks.id, approvalTaskLinks.taskId), eq(tasks.companyId, companyId)))
            .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"))).orderBy(desc(approvals.requestedAt)),
        db.select({ id: incidents.id, summary: incidents.summary, severity: incidents.severity, projectId: incidents.projectId, taskId: incidents.taskId, reasonCode: incidents.reasonCode, createdAt: incidents.createdAt, taskState: tasks.state, taskDeletedAt: tasks.deletedAt, taskType: tasks.taskType, inputJson: tasks.inputJson, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(incidents).leftJoin(tasks, and(eq(tasks.id, incidents.taskId), eq(tasks.companyId, companyId)))
            .where(and(eq(incidents.companyId, companyId), eq(incidents.status, "open"), isNull(incidents.deletedAt))).orderBy(desc(incidents.createdAt)).limit(50),
        db.select({ agentId: threadParticipants.participantId, activity: threadParticipants.currentActivity, threadType: messageThreads.type }).from(threadParticipants)
            .innerJoin(messageThreads, eq(messageThreads.id, threadParticipants.threadId))
            .where(and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"), gte(threadParticipants.typingUntil, now))),
        computeCompanyHealth(companyId, { now }),
        db.select({ id: projects.id, goal: projects.goal }).from(projects).where(eq(projects.companyId, companyId)),
        db.select({ id: taskEvents.id, eventType: taskEvents.eventType, actorType: taskEvents.actorType, actorId: taskEvents.actorId, taskId: taskEvents.taskId, createdAt: taskEvents.createdAt, projectId: tasks.projectId, inputJson: tasks.inputJson, taskType: tasks.taskType, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(taskEvents).innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
            .where(and(eq(taskEvents.companyId, companyId), gte(taskEvents.createdAt, dayAgo))).orderBy(desc(taskEvents.createdAt)).limit(120),
        db.select({ agentId: tokenUsageLog.agentId, costCents: sql<number>`COALESCE(SUM(${tokenUsageLog.costCents}), 0)`.mapWith(Number) })
            .from(tokenUsageLog).where(and(eq(tokenUsageLog.companyId, companyId), gte(tokenUsageLog.reportedAt, dayAgo)))
            .groupBy(tokenUsageLog.agentId),
        db.select({ count: sql<number>`COUNT(*)::int` }).from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [TASK_STATES.failed, TASK_STATES.deadLetter]), isNull(tasks.deletedAt))),
    ]);

    // Done metrics as unbounded SQL aggregates — never a capped row fetch — so
    // "done today / this week", the per-member done count and the median cycle
    // time stay exact on large teams.
    const [doneThisWeekRow, doneTodayRow, doneTodayAgentRows, doneTodayMemberRows, medianCycleRow, sparkRows, doneRecentTasks] = await Promise.all([
        db.select({ count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, weekAgo), isNull(tasks.deletedAt))),
        db.select({ count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt))),
        db.select({ agentId: tasks.assignedAgentId, count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt), isNotNull(tasks.assignedAgentId)))
            .groupBy(tasks.assignedAgentId),
        db.select({ memberId: tasks.assignedMemberId, count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt), isNotNull(tasks.assignedMemberId)))
            .groupBy(tasks.assignedMemberId),
        db.select({ ms: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${tasks.updatedAt} - ${tasks.processingStartedAt}))) * 1000` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, weekAgo), gte(tasks.updatedAt, tasks.processingStartedAt), isNull(tasks.deletedAt), isNotNull(tasks.processingStartedAt))),
        db.select({ bucket: sql<number>`FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - ${tasks.updatedAt})) / ${DONE_TODAY_MS / 1000})::int`, count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, weekAgo), isNull(tasks.deletedAt)))
            .groupBy(sql`1`),
        db.select({ id: tasks.id, projectId: tasks.projectId, inputJson: tasks.inputJson, taskType: tasks.taskType, updatedAt: tasks.updatedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.updatedAt)).limit(BOARD_LIMIT),
    ]);

    // Pair threads are a private agent conversation. Non-owners/admins never
    // query their participants or messages: no pair text reaches the payload.
    const pairThreads = isOwnerOrAdmin
        ? await db.select({ id: messageThreads.id }).from(messageThreads)
            .where(and(eq(messageThreads.companyId, companyId), eq(messageThreads.type, "group"), eq(messageThreads.description, AGENT_PAIR_DESCRIPTION), eq(messageThreads.createdByType, "system")))
        : [];

    // Ordinary group chats follow the same company-wide read policy as Messages.
    // Private pair threads stay in the owner/admin-only query above.
    const chatGroups = await listGroups(companyId, { includePairThreads: false });
    const teams = chatGroups.map((g) => ({ id: g.id, name: g.title, coordinator: g.coordinator ? { key: `${g.coordinator.kind}:${g.coordinator.id}`, name: g.coordinator.name, kind: g.coordinator.kind } : null, humanCount: g.members.filter((m) => m.kind === "human").length, memberKeys: g.members.filter((m) => m.kind === "agent").map((m) => `agent:${m.id}`) }));
    const roomIds = teams.map((g) => g.id);
    const roomMessages = roomIds.length ? await db.select({ id: threadMessages.id, threadId: threadMessages.threadId, senderId: threadMessages.senderId, text: sql<string>`LEFT(${threadMessages.text}, 4096)`, createdAt: threadMessages.createdAt })
        .from(threadMessages).where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, roomIds), eq(threadMessages.senderType, "agent"), gte(threadMessages.createdAt, new Date(now.getTime() - 60_000))))
        .orderBy(desc(threadMessages.createdAt)).limit(30) : [];

    const projectName = new Map(projectRows.map((p) => [p.id, p.goal]));
    const healthById = new Map(health.agents.map((a) => [a.id, a]));
    const activityByAgent = new Map(typing.filter((t) => t.agentId).map((t) => [t.agentId!, dashboardActivity(t.activity, t.threadType)]));
    const memberKeyByUser = new Map(members.map((m) => [m.userId, `human:${m.id}`]));
    const nameByKey = new Map<string, string>([
        ...agentRows.map((a) => [`agent:${a.id}`, a.name] as const),
        ...members.map((m) => [`human:${m.id}`, m.displayName || m.email] as const),
    ]);
    const assigneeKey = (t: { assignedAgentId: string | null; assignedMemberId: string | null }) =>
        t.assignedAgentId ? `agent:${t.assignedAgentId}` : t.assignedMemberId ? `human:${t.assignedMemberId}` : null;
    const toTask = (t: (typeof openTasks)[number]): DashboardTask => ({
        id: t.id, projectId: t.projectId, projectName: projectName.get(t.projectId) ?? null, title: taskTitle(t.inputJson, t.taskType),
        state: t.state, taskType: t.taskType, assigneeKey: assigneeKey(t), updatedAt: t.updatedAt.toISOString(), dueAt: t.slaDueAt?.toISOString() ?? null,
    });
    const doneTodayByAgent = new Map(doneTodayAgentRows.map((r) => [r.agentId, Number(r.count) || 0]));
    const doneTodayByMember = new Map(doneTodayMemberRows.map((r) => [r.memberId, Number(r.count) || 0]));
    const doneTasks: DashboardTask[] = doneRecentTasks.map((t) => ({
        id: t.id, projectId: t.projectId, projectName: projectName.get(t.projectId) ?? null, title: taskTitle(t.inputJson, t.taskType),
        state: TASK_STATES.done, taskType: t.taskType, assigneeKey: assigneeKey(t), updatedAt: t.updatedAt.toISOString(), dueAt: null,
    }));
    const doneTodayFor = (key: string): number => {
        const id = key.slice(key.indexOf(":") + 1);
        return key.startsWith("agent:") ? doneTodayByAgent.get(id) ?? 0 : doneTodayByMember.get(id) ?? 0;
    };

    // Latest assignment/claim event per incident task, so a watchdog incident
    // predating the task's current assignment reads as stale.
    const incidentTaskIds = [...new Set(openIncidents.map((i) => i.taskId).filter((id): id is string => Boolean(id)))];
    const assignmentEvents = incidentTaskIds.length
        ? await db.select({ taskId: taskEvents.taskId, createdAt: taskEvents.createdAt })
            .from(taskEvents).where(and(eq(taskEvents.companyId, companyId), inArray(taskEvents.taskId, incidentTaskIds), inArray(taskEvents.eventType, ["task_generated", "task_assigned", "task_reassigned", "task_claimed"])))
            .orderBy(desc(taskEvents.createdAt))
        : [];
    const latestAssignmentAt = new Map<string, string>();
    for (const e of assignmentEvents) {
        if (!latestAssignmentAt.has(e.taskId)) latestAssignmentAt.set(e.taskId, e.createdAt.toISOString());
    }

    // Recent loop-guard pause notices, so the operator can Resume in one click.
    const pausedNoticeRows = await db.select({
        id: threadMessages.id, threadId: threadMessages.threadId, createdAt: threadMessages.createdAt,
        description: messageThreads.description, createdByType: messageThreads.createdByType,
    }).from(threadMessages)
        .innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
        .where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.senderType, "system"), sql`${threadMessages.metadataJson}->>'loopGuard' = 'true'`, gte(threadMessages.createdAt, dayAgo)))
        .orderBy(desc(threadMessages.createdAt)).limit(10);

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
        isOwnerOrAdmin,
    );

    // Pair-thread activity (agent ↔ agent handoff conversations) for the feed.
    const pairThreadIds = pairThreads.map((t) => t.id);
    const [pairParticipants, pairMessages] = pairThreadIds.length
        ? await Promise.all([
            db.select({ threadId: threadParticipants.threadId, participantId: threadParticipants.participantId })
                .from(threadParticipants).where(and(eq(threadParticipants.companyId, companyId), inArray(threadParticipants.threadId, pairThreadIds), eq(threadParticipants.participantType, "agent"))),
            db.select({ id: threadMessages.id, threadId: threadMessages.threadId, senderId: threadMessages.senderId, text: sql<string>`LEFT(${threadMessages.text}, 4096)`, createdAt: threadMessages.createdAt })
                .from(threadMessages).where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, pairThreadIds), eq(threadMessages.senderType, "agent"), gte(threadMessages.createdAt, dayAgo)))
                .orderBy(desc(threadMessages.createdAt)).limit(20),
        ])
        : await Promise.resolve([[], []] as const);
    const pairAgentsByThread = new Map<string, string[]>();
    for (const p of pairParticipants) {
        if (!p.participantId) continue;
        const list = pairAgentsByThread.get(p.threadId) ?? [];
        if (!list.includes(p.participantId)) list.push(p.participantId);
        pairAgentsByThread.set(p.threadId, list);
    }

    const spendTodayByAgent = new Map(usageToday.map((u) => [u.agentId, Number(u.costCents) || 0]));

    const workFor = (key: string): Pick<DashboardMember, "working" | "waiting" | "next" | "doneToday"> => {
        const own = openTasks.filter((t) => assigneeKey(t) === key);
        return {
            working: own.filter((t) => t.state === TASK_STATES.inProgress).map(toTask),
            waiting: own.filter((t) => t.state === TASK_STATES.review).map(toTask),
            next: own.filter((t) => t.state === TASK_STATES.inbox).slice(0, 3).map(toTask),
            doneToday: doneTodayFor(key),
        };
    };

    const dashboardMembers: DashboardMember[] = [];
    for (const a of agentRows) {
        const h = healthById.get(a.id);
        dashboardMembers.push({
            key: `agent:${a.id}`, kind: "agent", id: a.id, name: a.name, role: a.role, avatarUrl: a.avatarUrl, avatarAppearance: a.avatarAppearance, skills: skillNames(a.skillsJson),
            health: h?.status ?? null, healthReasons: h?.reasons ?? [], activity: activityByAgent.get(a.id) ?? null, href: `/agents?agent=${a.id}`,
            createdAt: a.createdAt.toISOString(),
            spendTodayCents: spendTodayByAgent.get(a.id) ?? 0,
            monthlyCostCents: Number(a.monthlyCostCents) || 0,
            monthlyBudgetCents: a.monthlyBudgetCents,
            lastActivityAt: h?.lastSeenAt ?? null, runtimeOnline: h?.online ?? false, canRestartRuntime: a.provider === "hermes" && a.deploymentMode === "local",
            ...workFor(`agent:${a.id}`),
        });
    }
    for (const m of members) {
        dashboardMembers.push({
            key: `human:${m.id}`, kind: "human", id: m.id, name: m.displayName || m.email, role: m.roleTitle, avatarUrl: null, skills: [],
            health: null, healthReasons: [], activity: null, href: `/projects?assignee=human:${m.id}`,
            createdAt: null,
            spendTodayCents: 0, monthlyCostCents: 0, monthlyBudgetCents: 0, lastActivityAt: null,
            ...workFor(`human:${m.id}`),
        });
    }

    // Things only a person can unblock, most urgent kinds first.
    const attention: AttentionEntry[] = [];
    for (const i of openIncidents) {
        const cls = classifyIncident(i.reasonCode, i.summary);
        const title = i.inputJson || i.taskType ? taskTitle(i.inputJson, i.taskType ?? "task") : excerpt(i.summary);
        const stale = isIncidentStale({
            classification: cls,
            taskState: i.taskState ?? null,
            incidentCreatedAt: i.createdAt.toISOString(),
            currentAssignmentAt: i.taskId ? latestAssignmentAt.get(i.taskId) ?? null : null,
            taskDeleted: i.taskDeletedAt !== null,
        });
        if (stale) continue;
        const key = assigneeKey(i);
        const href = i.taskId ? `/projects?project=${i.projectId}&task=${i.taskId}` : `/projects?project=${i.projectId}`;
        const at = i.createdAt.toISOString();
        if (cls === "problem") {
            attention.push({
                id: `incident:${i.id}`, kind: "incident", title, reason: shortReason(i.reasonCode),
                memberKey: key, memberName: key ? nameByKey.get(key) ?? null : null,
                area: projectName.get(i.projectId) ?? null, at, actionLabel: "Open task", href,
                taskId: i.taskId,
            });
        } else if (cls === "late") {
            attention.push({
                id: `incident:${i.id}`, kind: "late", title, memberKey: key, memberName: key ? nameByKey.get(key) ?? null : null,
                area: projectName.get(i.projectId) ?? null, at, actionLabel: "Open task", href, taskId: i.taskId,
            });
        } else {
            attention.push({
                id: `incident:${i.id}`, kind: "not_started", title, memberKey: key, memberName: key ? nameByKey.get(key) ?? null : null,
                area: projectName.get(i.projectId) ?? null, at, actionLabel: "Open task", href, taskId: i.taskId, actionRequired: !key,
            });
        }
    }
    for (const a of health.agents.filter((h) => h.status === "down" && !activityByAgent.has(h.id))) {
        attention.push({
            id: `agent:${a.id}`, kind: "agent", title: `${a.name} has no recent connection with work waiting`, memberKey: `agent:${a.id}`, memberName: a.name,
            area: a.role, at: a.lastSeenAt ?? now.toISOString(), actionLabel: "Inspect connection", href: `/agents?agent=${a.id}`,
            agentId: a.id, canRestartRuntime: agentRows.some((agent) => agent.id === a.id && agent.provider === "hermes" && agent.deploymentMode === "local"),
        });
    }
    const seenApprovals = new Set<string>();
    for (const a of pendingApprovals) {
        if (seenApprovals.has(a.id)) continue;
        seenApprovals.add(a.id);
        const what = a.taskType ? taskTitle(a.taskInput, a.taskType) : a.rationale ? excerpt(a.rationale, 48) : humanize(a.actionType);
        const key = a.requesterAgentId ? `agent:${a.requesterAgentId}` : null;
        attention.push({
            id: `approval:${a.id}`, kind: "approval", title: a.actionType === "task_done" ? `Approve ${excerpt(what, 52)}` : `Approve ${humanize(a.actionType)}: ${excerpt(what, 40)}`,
            memberKey: key, memberName: key ? nameByKey.get(key) ?? null : null, area: projectName.get(a.projectId) ?? null,
            at: a.requestedAt.toISOString(), actionLabel: a.actionType === "task_done" ? "Review work" : "Review request", href: "/approvals",
            approvalId: a.id,
        });
    }
    for (const item of health.attention) {
        attention.push({
            id: `message:${item.messageId}`, kind: "message",
            title: item.kind === "failed" ? `Message failed: “${excerpt(item.text, 40)}”` : `Awaiting agent response: “${excerpt(item.text, 36)}”`,
            memberKey: `agent:${item.agentId}`, memberName: item.agentName, area: "Messages", at: item.since,
            actionLabel: item.kind === "failed" ? "Inspect delivery" : "Open chat", href: item.link,
            actionRequired: item.kind === "failed",
        });
    }
    for (const n of pausedNotices) {
        attention.push({
            id: `paused:${n.id}`, kind: "paused",
            title: "Agents were going back and forth without progress",
            memberKey: null, memberName: null, area: "Team chat", at: n.createdAt,
            actionLabel: "Resume", href: "/messages", threadId: n.threadId,
        });
    }
    // Most urgent first: stuck > offline > late > approval > reply > not started.
    attention.sort((a, b) => attentionUrgency(a.kind) - attentionUrgency(b.kind) || a.at.localeCompare(b.at));

    // Who passed work to whom in the last day, and the activity ticker.
    const collaborations: CollaborationEvent[] = [];
    const activity: ActivityEvent[] = [];
    for (const e of recentEvents) {
        const actorKey = e.actorId ? (e.actorType === "agent" ? `agent:${e.actorId}` : e.actorType === "human" ? memberKeyByUser.get(e.actorId) ?? null : null) : null;
        const targetKey = assigneeKey(e);
        const title = taskTitle(e.inputJson, e.taskType);
        const at = e.createdAt.toISOString();
        if (actorKey && targetKey && actorKey !== targetKey) {
            collaborations.push({ id: e.id, fromKey: actorKey, toKey: targetKey, kind: e.eventType === "task_note" || e.eventType === "task_review" ? "review" : "handoff", taskTitle: title, at });
        }
        const actorName = actorKey ? nameByKey.get(actorKey) : null;
        if (actorName && activity.length < 20) {
            activity.push({ id: e.id, eventType: e.eventType, actorKey, actorName, targetKey: targetKey && targetKey !== actorKey ? targetKey : null, targetName: targetKey && targetKey !== actorKey ? nameByKey.get(targetKey) ?? null : null, taskTitle: title, taskId: e.taskId, projectId: e.projectId, at });
        }
    }

    // "What's moving" feed: handoffs + review/done transitions + pair threads.
    const pairActivity: PairThreadActivity[] = [];
    for (const m of pairMessages) {
        const senderKey = m.senderId ? `agent:${m.senderId}` : null;
        const senderName = senderKey ? nameByKey.get(senderKey) ?? null : null;
        if (!senderKey || !senderName) continue;
        const others = (pairAgentsByThread.get(m.threadId) ?? []).filter((id) => id !== m.senderId);
        const targetKey = others.length ? `agent:${others[0]}` : null;
        pairActivity.push({
            id: m.id, threadId: m.threadId, actorKey: senderKey, actorName: senderName,
            targetKey, targetName: targetKey ? nameByKey.get(targetKey) ?? null : null,
            text: excerpt(m.text, 64), at: m.createdAt.toISOString(),
        });
    }
    const communications: SceneCommunication[] = [
        ...pairActivity.filter((p) => p.actorKey).map((p) => ({ id: p.id, actorKey: p.actorKey!, targetKey: p.targetKey, teamId: null, text: sceneMessagePreview(pairMessages.find((m) => m.id === p.id)?.text ?? p.text), at: p.at, href: `/messages?group=${p.threadId}` })),
        ...roomMessages.filter((m) => m.senderId && nameByKey.has(`agent:${m.senderId}`)).map((m) => ({ id: m.id, actorKey: `agent:${m.senderId}`, targetKey: null, teamId: m.threadId, text: sceneMessagePreview(m.text), at: m.createdAt.toISOString(), href: `/messages?group=${m.threadId}` })),
    ].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 30);
    const feed: FeedEvent[] = buildFeed(activity, pairActivity, 8);

    const cost: CostSummary = {
        spendTodayCents: [...spendTodayByAgent.values()].reduce((s, n) => s + n, 0),
        spendMonthCents: agentRows.reduce((s, a) => s + (Number(a.monthlyCostCents) || 0), 0),
        budgetCents: agentRows.reduce((s, a) => s + a.monthlyBudgetCents, 0),
        agents: agentRows.map((a) => ({
            key: `agent:${a.id}`, name: a.name,
            spendTodayCents: spendTodayByAgent.get(a.id) ?? 0,
            monthCents: Number(a.monthlyCostCents) || 0,
            budgetCents: a.monthlyBudgetCents,
        })).sort((a, b) => b.monthCents - a.monthCents).slice(0, 5),
    };

    const sparkline = Array(7).fill(0);
    for (const r of sparkRows) {
        const bucket = Math.min(6, Math.max(0, Number(r.bucket) || 0));
        sparkline[6 - bucket] += Number(r.count) || 0;
    }
    const medianCycleMs = typeof medianCycleRow[0]?.ms === "number" && Number.isFinite(medianCycleRow[0].ms)
        ? Math.round(medianCycleRow[0].ms)
        : null;

    const throughput: ThroughputSummary = {
        doneToday: doneTodayRow[0]?.count ?? 0,
        doneThisWeek: doneThisWeekRow[0]?.count ?? 0,
        sparkline,
        medianCycleMs,
        blocked: blockedCount?.[0]?.count ?? 0,
    };

    const data: DashboardData = {
        generatedAt: now.toISOString(),
        companyName: company?.name ?? "Your company",
        teams, communications,
        members: dashboardMembers,
        board: {
            inProgress: openTasks.filter((t) => t.state === TASK_STATES.inProgress).slice(0, BOARD_LIMIT).map(toTask),
            review: openTasks.filter((t) => t.state === TASK_STATES.review).slice(0, BOARD_LIMIT).map(toTask),
            done: doneTasks.slice(0, BOARD_LIMIT),
        },
        attention,
        collaborations,
        activity,
        cost,
        throughput,
        feed,
    };

    const setup = await (async () => {
        if (!userId || currentUser?.onboardingCompletedAt || currentUser?.onboardingDismissedAt) return null;
        const [[membership], [company]] = await Promise.all([
            db.select({ role: companyMembers.role }).from(companyMembers).where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId))).limit(1),
            db.select({ name: companies.name, contextNotes: companies.contextNotes }).from(companies).where(eq(companies.id, companyId)).limit(1),
        ]);
        if (!membership || !["owner", "admin"].includes(membership.role)) return null;
        const profileComplete = Boolean(company?.contextNotes?.trim());
        if (profileComplete && agentRows.length > 0) return null;
        // The profile records the kind of company by its label; map it back so the team suggestion survives a reload.
        const businessType = BUSINESS_TYPES.find((t) => company?.contextNotes?.includes(`**Type of business:** ${t.label}`))?.id ?? "";
        return { companyName: company?.name ?? "", profileComplete, businessType };
    })();

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 animate-in fade-in duration-500">
            {/* First-run setup: owners and admins, until they finish or skip it,
                while the company has no agents or no profile yet. */}
            {!currentUser?.onboardingCompletedAt && !currentUser?.onboardingDismissedAt && setup && (
                <SetupWizard initialCompanyName={setup.companyName} initialBusinessType={setup.businessType} profileComplete={setup.profileComplete} hasAgents={agentRows.length > 0} />
            )}
            <TeamDashboard data={data} initialView={view} hasAgents={agentRows.length > 0} canAct={canAct} isOwnerOrAdmin={isOwnerOrAdmin} />
        </div>
    );
}
