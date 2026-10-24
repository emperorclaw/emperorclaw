import { redirect } from "next/navigation";
import { and, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
    agentRuns, agents, companies, companyMembers, messageThreads, projects, taskEvents, tasks, threadMessages, threadParticipants, tokenUsageLog, users,
} from "@/db/schema";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { computeCompanyHealth, OFFLINE_AFTER_MS } from "@/lib/agent-health";
import { listPendingDecisions } from "@/lib/approvals";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import { AGENT_PAIR_DESCRIPTION, listGroups } from "@/lib/groups";
import { attentionAccessFromGuard, buildAttention } from "@/lib/attention";
import { requireRole } from "@/lib/roles";
import { canAdmin, canWrite } from "@/lib/role-matrix";
import { getScopedAgentIds, memberAgentCondition, memberVisibleProjectIds } from "@/lib/member-scope";
import { SetupWizard } from "@/components/setup-wizard";
import { BUSINESS_TYPES } from "@/lib/onboarding-shared";
import { sceneMessagePreview } from "@/lib/observatory";
import { loadDashboardLive, pendingApprovalRows } from "@/lib/dashboard-live";
import { loadOrganization } from "@/lib/organization";
import { TeamDashboard } from "@/components/team-dashboard/team-dashboard";
import {
    dashboardActivity, buildFeed, DONE_TODAY_MS, skillNames,
    type SceneCommunication, type ActivityEvent, type CollaborationEvent, type CostSummary, type DashboardData, type DashboardMember, type DashboardTask, type FeedEvent, type PairThreadActivity, type ThroughputSummary,
} from "@/lib/team-scene";
import { splitProjectTitle } from "@/lib/project-title";

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
    // also open machine-managed pair threads. Role and member scope come from
    // the DB (requireRole), never the session's login-time copies.
    const guard = await requireRole("viewer")().catch(() => null);
    if (!guard) redirect("/login");
    const canAct = canWrite(guard.role);
    const isOwnerOrAdmin = canAdmin(guard.role);
    const attentionAccess = attentionAccessFromGuard(guard);
    // A restricted member sees only their agents, and work on their customers' projects.
    const memberScope = guard.scope;
    const visibleProjects = await memberVisibleProjectIds(companyId, memberScope);
    const projectScope = (column: typeof tasks.projectId | typeof projects.id) =>
        visibleProjects ? inArray(column, [...visibleProjects]) : undefined;
    const agentScope = (column: typeof agents.id | typeof tokenUsageLog.agentId | typeof agentRuns.agentId | typeof threadParticipants.participantId) =>
        memberAgentCondition(memberScope, column);

    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const usageSince = new Date(Math.min(monthStart.getTime(), dayAgo.getTime()));
    const [[company], [currentUser], members, agentRows, openTasks, decisions, typing, health, projectRows, recentEvents, usageToday, blockedCount, openRuns] = await Promise.all([
        db.select({ name: companies.name }).from(companies).where(eq(companies.id, companyId)).limit(1),
        userId
            ? db.select({ onboardingCompletedAt: users.onboardingCompletedAt, onboardingDismissedAt: users.onboardingDismissedAt }).from(users).where(eq(users.id, userId)).limit(1)
            : Promise.resolve([]),
        db.select({ id: companyMembers.id, userId: users.id, displayName: users.displayName, email: users.email, roleTitle: users.roleTitle })
            .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
            .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
        db.select({ id: agents.id, name: agents.name, role: agents.role, avatarUrl: agents.avatarUrl, avatarAppearance: agents.avatarAppearance, provider: agents.provider, deploymentMode: agents.deploymentMode, skillsJson: agents.skillsJson, createdAt: agents.createdAt, monthlyBudgetCents: agents.monthlyBudgetCents, monthlyCostCents: agents.monthlyCostCents, lastResetMonth: agents.lastResetMonth })
            .from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt), agentScope(agents.id))),
        db.select({ id: tasks.id, projectId: tasks.projectId, state: tasks.state, inputJson: tasks.inputJson, taskType: tasks.taskType, slaDueAt: tasks.slaDueAt, priority: tasks.priority, updatedAt: tasks.updatedAt, processingStartedAt: tasks.processingStartedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]), isNull(tasks.deletedAt), projectScope(tasks.projectId)))
            .orderBy(desc(tasks.priority), tasks.createdAt),
        // Same definition as the sidebar badge and the Approvals page.
        listPendingDecisions(companyId),
        db.select({ agentId: threadParticipants.participantId, activity: threadParticipants.currentActivity, threadType: messageThreads.type }).from(threadParticipants)
            .innerJoin(messageThreads, eq(messageThreads.id, threadParticipants.threadId))
            .where(and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"), gte(threadParticipants.typingUntil, now), agentScope(threadParticipants.participantId))),
        computeCompanyHealth(companyId, { now, agentIds: getScopedAgentIds(memberScope) }),
        db.select({ id: projects.id, goal: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), projectScope(projects.id))),
        db.select({ id: taskEvents.id, eventType: taskEvents.eventType, actorType: taskEvents.actorType, actorId: taskEvents.actorId, taskId: taskEvents.taskId, createdAt: taskEvents.createdAt, projectId: tasks.projectId, inputJson: tasks.inputJson, taskType: tasks.taskType, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(taskEvents).innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
            .where(and(eq(taskEvents.companyId, companyId), gte(taskEvents.createdAt, dayAgo), projectScope(tasks.projectId))).orderBy(desc(taskEvents.createdAt)).limit(120),
        db.select({ agentId: tokenUsageLog.agentId, costCents: sql<number>`COALESCE(SUM(${tokenUsageLog.costCents}) FILTER (WHERE ${tokenUsageLog.reportedAt} >= ${dayAgo}), 0)`.mapWith(Number), monthCostCents: sql<number>`COALESCE(SUM(${tokenUsageLog.costCents}) FILTER (WHERE ${tokenUsageLog.reportedAt} >= ${monthStart}), 0)`.mapWith(Number), reports: sql<number>`COUNT(*) FILTER (WHERE ${tokenUsageLog.reportedAt} >= ${dayAgo})`.mapWith(Number), tokens: sql<number>`COALESCE(SUM(${tokenUsageLog.inputTokens} + ${tokenUsageLog.outputTokens}) FILTER (WHERE ${tokenUsageLog.reportedAt} >= ${dayAgo}), 0)`.mapWith(Number) })
            .from(tokenUsageLog).where(and(eq(tokenUsageLog.companyId, companyId), gte(tokenUsageLog.reportedAt, usageSince), agentScope(tokenUsageLog.agentId)))
            .groupBy(tokenUsageLog.agentId),
        db.select({ count: sql<number>`COUNT(*)::int` }).from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [TASK_STATES.failed, TASK_STATES.deadLetter]), isNull(tasks.deletedAt), projectScope(tasks.projectId))),
        // A freshly opened run is live evidence too, like in agent-activity.ts:
        // an open run counts when the runtime is online (already covered by
        // health) or the run started within the offline window. An older open
        // run on a silent runtime is almost surely dead, so it must not mask
        // the "offline with work in progress" alert.
        db.selectDistinct({ agentId: agentRuns.agentId }).from(agentRuns)
            .where(and(eq(agentRuns.companyId, companyId), eq(agentRuns.status, "running"), gte(agentRuns.startedAt, new Date(now.getTime() - OFFLINE_AFTER_MS)), isNotNull(agentRuns.agentId), agentScope(agentRuns.agentId))),
    ]);
    const pendingApprovals = decisions.approvals.filter(({ approval }) => !visibleProjects || visibleProjects.has(approval.projectId)).map(({ approval, tasks: linked }) => ({
        id: approval.id, requestedAt: approval.requestedAt, actionType: approval.actionType, rationale: approval.rationale, projectId: approval.projectId,
        requesterAgentId: approval.requesterAgentId, taskInput: linked[0].inputJson as unknown, taskType: linked[0].taskType as string | null,
    }));
    const agentsWithOpenRun = new Set(openRuns.flatMap((r) => r.agentId ? [r.agentId] : []));

    // Done metrics as unbounded SQL aggregates — never a capped row fetch — so
    // "done today / this week", the per-member done count and the median cycle
    // time stay exact on large teams.
    const [doneThisWeekRow, doneTodayRow, doneTodayAgentRows, doneTodayMemberRows, medianCycleRow, sparkRows, doneRecentTasks] = await Promise.all([
        db.select({ count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), projectScope(tasks.projectId), gte(tasks.updatedAt, weekAgo), isNull(tasks.deletedAt))),
        db.select({ count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), projectScope(tasks.projectId), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt))),
        db.select({ agentId: tasks.assignedAgentId, count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), projectScope(tasks.projectId), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt), isNotNull(tasks.assignedAgentId)))
            .groupBy(tasks.assignedAgentId),
        db.select({ memberId: tasks.assignedMemberId, count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), projectScope(tasks.projectId), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt), isNotNull(tasks.assignedMemberId)))
            .groupBy(tasks.assignedMemberId),
        db.select({ ms: sql<number | null>`percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (${tasks.updatedAt} - ${tasks.processingStartedAt}))) * 1000` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), projectScope(tasks.projectId), gte(tasks.updatedAt, weekAgo), gte(tasks.updatedAt, tasks.processingStartedAt), isNull(tasks.deletedAt), isNotNull(tasks.processingStartedAt))),
        db.select({ bucket: sql<number>`FLOOR(EXTRACT(EPOCH FROM (${now}::timestamp - ${tasks.updatedAt})) / ${DONE_TODAY_MS / 1000})::int`, count: sql<number>`COUNT(*)::int` }).from(tasks)
            .where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), projectScope(tasks.projectId), gte(tasks.updatedAt, weekAgo), isNull(tasks.deletedAt)))
            .groupBy(sql`1`),
        db.select({ id: tasks.id, projectId: tasks.projectId, inputJson: tasks.inputJson, taskType: tasks.taskType, updatedAt: tasks.updatedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), projectScope(tasks.projectId), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.updatedAt)).limit(BOARD_LIMIT),
    ]);

    // Living office: thoughts (team/group reasoning only, never a direct
    // thread) and recent moments, from the device feed's loaders and helpers.
    // Started now so it overlaps the queries below.
    const livePromise = loadDashboardLive(companyId, {
        now,
        agents: agentRows.map((a) => ({ id: a.id, name: a.name })),
        approvals: pendingApprovalRows(pendingApprovals),
        includePairThreads: isOwnerOrAdmin,
        viewerUserId: userId,
    }).catch((error) => {
        // Thoughts and moments are decoration: the dashboard must render without them.
        console.error("[dashboard] live office data failed:", error);
        return { thoughts: [], liveEvents: [] };
    });

    // Started now so its queries overlap the ones below.
    const attentionPromise = buildAttention(companyId, attentionAccess, { now, health, decisions });

    // The company leader sits on the Emperor's throne. Reuse the organization
    // resolver (same as GET /api/mcp/organization); a failure must never take
    // the dashboard down, so the leader falls back to null.
    const leaderPromise = loadOrganization(companyId)
        .then((org) => org.leader)
        .catch((error) => {
            console.error("[dashboard] organization leader failed:", error);
            return null;
        });

    // Pair threads are a private agent conversation. Non-owners/admins never
    // query their participants or messages: no pair text reaches the payload.
    const pairThreads = isOwnerOrAdmin
        ? await db.select({ id: messageThreads.id }).from(messageThreads)
            .where(and(eq(messageThreads.companyId, companyId), eq(messageThreads.type, "group"), eq(messageThreads.description, AGENT_PAIR_DESCRIPTION), eq(messageThreads.createdByType, "system")))
        : [];

    // Ordinary group chats follow the same company-wide read policy as Messages.
    // Private pair threads stay in the owner/admin-only query above.
    const chatGroups = await listGroups(companyId, { includePairThreads: false });
    const teams = chatGroups.map((g) => ({ members: g.members, description: g.description, icon: g.icon, id: g.id, name: g.title, coordinator: g.coordinator ? { key: `${g.coordinator.kind}:${g.coordinator.id}`, name: g.coordinator.name, kind: g.coordinator.kind } : null, humanCount: g.members.filter((m) => m.kind === "human").length, memberKeys: g.members.filter((m) => m.kind === "agent").map((m) => `agent:${m.id}`) }));
    const roomIds = teams.map((g) => g.id);
    const roomMessages = roomIds.length ? await db.select({ id: threadMessages.id, threadId: threadMessages.threadId, senderId: threadMessages.senderId, text: sql<string>`LEFT(${threadMessages.text}, 4096)`, createdAt: threadMessages.createdAt })
        .from(threadMessages).where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, roomIds), eq(threadMessages.senderType, "agent"), gte(threadMessages.createdAt, new Date(now.getTime() - 60_000))))
        .orderBy(desc(threadMessages.createdAt)).limit(30) : [];

    const leader = await leaderPromise;
    const live = await livePromise;
    const projectName = new Map(projectRows.map((p) => [p.id, splitProjectTitle(p.goal).name]));
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
        startedAt: t.processingStartedAt?.toISOString() ?? null,
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

    const spendMonthByAgent = new Map(usageToday.map((u) => [u.agentId, Number(u.monthCostCents) || 0]));
    const monthSpend = (a: typeof agentRows[number]) => spendMonthByAgent.get(a.id) ?? (a.lastResetMonth === now.toISOString().slice(0, 7) ? Number(a.monthlyCostCents) || 0 : 0);
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
            monthlyCostCents: monthSpend(a),
            monthlyBudgetCents: a.monthlyBudgetCents,
            lastActivityAt: h?.lastSeenAt ?? null, runtimeOnline: (h?.online ?? false) || agentsWithOpenRun.has(a.id), canRestartRuntime: a.provider === "hermes" && a.deploymentMode === "local",
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

    // Things only a person can unblock: the same builder as /inbox and the
    // Inbox badge (src/lib/attention.ts), limited to the kinds this panel shows.
    const { entries: attention, workingNow } = await attentionPromise;

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
        spendMonthCents: usageToday.reduce((sum, row) => sum + row.monthCostCents, 0) + agentRows.filter((a) => !spendMonthByAgent.has(a.id)).reduce((sum, a) => sum + monthSpend(a), 0),
        usageReportsToday: usageToday.reduce((sum, row) => sum + row.reports, 0),
        reportedTokensToday: usageToday.reduce((sum, row) => sum + row.tokens, 0),
        budgetCents: agentRows.reduce((s, a) => s + a.monthlyBudgetCents, 0),
        agents: agentRows.map((a) => ({
            key: `agent:${a.id}`, name: a.name,
            spendTodayCents: spendTodayByAgent.get(a.id) ?? 0,
            monthCents: monthSpend(a),
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
        leader,
        teams, communications,
        members: dashboardMembers,
        board: {
            inProgress: openTasks.filter((t) => t.state === TASK_STATES.inProgress).slice(0, BOARD_LIMIT).map(toTask),
            review: openTasks.filter((t) => t.state === TASK_STATES.review).slice(0, BOARD_LIMIT).map(toTask),
            done: doneTasks.slice(0, BOARD_LIMIT),
        },
        attention,
        workingNow,
        collaborations,
        activity,
        cost,
        throughput,
        feed,
        thoughts: live.thoughts,
        liveEvents: live.liveEvents,
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
