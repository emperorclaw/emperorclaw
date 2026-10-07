import Link from "next/link";
import { redirect } from "next/navigation";
import { and, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, approvals, approvalTaskLinks, companies, companyMembers, incidents, projects, taskEvents, tasks, threadParticipants, users } from "@/db/schema";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { computeCompanyHealth } from "@/lib/agent-health";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import { SetupWizard } from "@/components/setup-wizard";
import { BUSINESS_TYPES } from "@/lib/onboarding-shared";
import { TeamDashboard } from "@/components/team-dashboard/team-dashboard";
import {
    skillNames,
    type ActivityEvent, type AttentionEntry, type CollaborationEvent, type DashboardData, type DashboardMember, type DashboardTask,
} from "@/lib/team-scene";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type WorkFilter = "all" | "mine" | "human" | "agent";

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

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ work?: string; view?: string }> }) {
    const session = await getValidatedServerSession();
    const params = await searchParams;
    const workFilter: WorkFilter = ["mine", "human", "agent"].includes(params.work || "") ? params.work as WorkFilter : "all";
    const view: "list" | "scene" = params.view === "list" ? "list" : "scene";
    const companyId = await getCompanyId();
    if (!companyId) {
        // A fresh self-hosted install has no company yet. Send the operator to
        // account creation instead of a login form no account can satisfy.
        const [companyCount] = await db.select({ count: sql<number>`COUNT(*)::int` }).from(companies).where(isNull(companies.deletedAt));
        redirect((companyCount?.count ?? 0) === 0 ? "/signup" : "/login");
    }
    const userId = session?.user?.id ?? null;
    const now = new Date();
    const dayAgo = new Date(now.getTime() - 86_400_000);

    const [[currentUser], members, agentRows, openTasks, doneRecently, pendingApprovals, openIncidents, typing, health, projectRows, recentEvents] = await Promise.all([
        userId
            ? db.select({ onboardingCompletedAt: users.onboardingCompletedAt, onboardingDismissedAt: users.onboardingDismissedAt }).from(users).where(eq(users.id, userId)).limit(1)
            : Promise.resolve([]),
        db.select({ id: companyMembers.id, userId: users.id, displayName: users.displayName, email: users.email, roleTitle: users.roleTitle })
            .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
            .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
        db.select({ id: agents.id, name: agents.name, role: agents.role, avatarUrl: agents.avatarUrl, skillsJson: agents.skillsJson }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
        db.select({ id: tasks.id, projectId: tasks.projectId, state: tasks.state, inputJson: tasks.inputJson, taskType: tasks.taskType, slaDueAt: tasks.slaDueAt, priority: tasks.priority, updatedAt: tasks.updatedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.priority), tasks.createdAt),
        db.select({ id: tasks.id, projectId: tasks.projectId, inputJson: tasks.inputJson, taskType: tasks.taskType, updatedAt: tasks.updatedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.updatedAt)).limit(50),
        db.select({ id: approvals.id, requestedAt: approvals.requestedAt, actionType: approvals.actionType, rationale: approvals.rationale, projectId: approvals.projectId, requesterAgentId: approvals.requesterAgentId, taskInput: tasks.inputJson, taskType: tasks.taskType })
            .from(approvals)
            .leftJoin(approvalTaskLinks, eq(approvalTaskLinks.approvalId, approvals.id))
            .leftJoin(tasks, and(eq(tasks.id, approvalTaskLinks.taskId), eq(tasks.companyId, companyId)))
            .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"))).orderBy(desc(approvals.requestedAt)),
        db.select({ id: incidents.id, summary: incidents.summary, severity: incidents.severity, projectId: incidents.projectId, taskId: incidents.taskId, createdAt: incidents.createdAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(incidents).leftJoin(tasks, and(eq(tasks.id, incidents.taskId), eq(tasks.companyId, companyId)))
            .where(and(eq(incidents.companyId, companyId), eq(incidents.status, "open"), isNull(incidents.deletedAt))).orderBy(desc(incidents.createdAt)).limit(20),
        db.select({ agentId: threadParticipants.participantId, activity: threadParticipants.currentActivity }).from(threadParticipants)
            .where(and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"), gt(threadParticipants.typingUntil, now))),
        computeCompanyHealth(companyId, { now }),
        db.select({ id: projects.id, goal: projects.goal }).from(projects).where(eq(projects.companyId, companyId)),
        db.select({ id: taskEvents.id, eventType: taskEvents.eventType, actorType: taskEvents.actorType, actorId: taskEvents.actorId, createdAt: taskEvents.createdAt, inputJson: tasks.inputJson, taskType: tasks.taskType, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(taskEvents).innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
            .where(and(eq(taskEvents.companyId, companyId), gte(taskEvents.createdAt, dayAgo))).orderBy(desc(taskEvents.createdAt)).limit(80),
    ]);

    const projectName = new Map(projectRows.map((p) => [p.id, p.goal]));
    const healthById = new Map(health.agents.map((a) => [a.id, a]));
    const activityByAgent = new Map(typing.filter((t) => t.agentId).map((t) => [t.agentId!, t.activity || "working…"]));
    const currentMemberId = members.find((m) => m.userId === userId)?.id ?? null;
    const memberKeyByUser = new Map(members.map((m) => [m.userId, `human:${m.id}`]));
    const nameByKey = new Map<string, string>([
        ...agentRows.map((a) => [`agent:${a.id}`, a.name] as const),
        ...members.map((m) => [`human:${m.id}`, m.displayName || m.email] as const),
    ]);
    const assigneeKey = (t: { assignedAgentId: string | null; assignedMemberId: string | null }) =>
        t.assignedAgentId ? `agent:${t.assignedAgentId}` : t.assignedMemberId ? `human:${t.assignedMemberId}` : null;
    const toTask = (t: (typeof openTasks)[number]): DashboardTask => ({
        id: t.id, projectId: t.projectId, projectName: projectName.get(t.projectId) ?? null, title: taskTitle(t.inputJson, t.taskType),
        state: t.state, assigneeKey: assigneeKey(t), updatedAt: t.updatedAt.toISOString(), dueAt: t.slaDueAt?.toISOString() ?? null,
    });
    const doneTasks: DashboardTask[] = doneRecently.map((t) => ({
        id: t.id, projectId: t.projectId, projectName: projectName.get(t.projectId) ?? null, title: taskTitle(t.inputJson, t.taskType),
        state: TASK_STATES.done, assigneeKey: assigneeKey(t), updatedAt: t.updatedAt.toISOString(), dueAt: null,
    }));

    const workFor = (key: string): Pick<DashboardMember, "working" | "waiting" | "next" | "doneToday"> => {
        const own = openTasks.filter((t) => assigneeKey(t) === key);
        return {
            working: own.filter((t) => t.state === TASK_STATES.inProgress).map(toTask),
            waiting: own.filter((t) => t.state === TASK_STATES.review).map(toTask),
            next: own.filter((t) => t.state === TASK_STATES.inbox).slice(0, 3).map(toTask),
            doneToday: doneTasks.filter((t) => t.assigneeKey === key).length,
        };
    };

    const dashboardMembers: DashboardMember[] = [];
    if (workFilter === "all" || workFilter === "agent") {
        for (const a of agentRows) {
            const h = healthById.get(a.id);
            dashboardMembers.push({
                key: `agent:${a.id}`, kind: "agent", id: a.id, name: a.name, role: a.role, avatarUrl: a.avatarUrl, skills: skillNames(a.skillsJson),
                health: h?.status ?? null, healthReasons: h?.reasons ?? [], activity: activityByAgent.get(a.id) ?? null, href: `/agents?agent=${a.id}`,
                ...workFor(`agent:${a.id}`),
            });
        }
    }
    if (workFilter !== "agent") {
        for (const m of members) {
            if (workFilter === "mine" && m.id !== currentMemberId) continue;
            dashboardMembers.push({
                key: `human:${m.id}`, kind: "human", id: m.id, name: m.displayName || m.email, role: m.roleTitle, avatarUrl: null, skills: [],
                health: null, healthReasons: [], activity: null, href: `/projects?assignee=human:${m.id}`,
                ...workFor(`human:${m.id}`),
            });
        }
    }

    // Things only a person can unblock, most urgent kinds first.
    const attention: AttentionEntry[] = [];
    for (const i of openIncidents) {
        const key = assigneeKey(i);
        attention.push({
            id: `incident:${i.id}`, kind: "incident", title: excerpt(i.summary), memberKey: key, memberName: key ? nameByKey.get(key) ?? null : null,
            area: projectName.get(i.projectId) ?? null, at: i.createdAt.toISOString(), actionLabel: "View issue",
            href: i.taskId ? `/projects?project=${i.projectId}&task=${i.taskId}` : `/projects?project=${i.projectId}`,
        });
    }
    for (const a of health.agents.filter((h) => h.status === "down")) {
        attention.push({
            id: `agent:${a.id}`, kind: "agent", title: `${a.name} is offline with work waiting`, memberKey: `agent:${a.id}`, memberName: a.name,
            area: a.role, at: a.lastSeenAt ?? now.toISOString(), actionLabel: "Check agent", href: "/agents/health",
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
        });
    }
    for (const item of health.attention.slice(0, 6)) {
        attention.push({
            id: `message:${item.messageId}`, kind: "message",
            title: item.kind === "failed" ? `Message failed: “${excerpt(item.text, 40)}”` : `Waiting on a reply: “${excerpt(item.text, 36)}”`,
            memberKey: `agent:${item.agentId}`, memberName: item.agentName, area: "Messages", at: item.since,
            actionLabel: "Open chat", href: item.link,
        });
    }

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
            activity.push({ id: e.id, eventType: e.eventType, actorKey, actorName, targetName: targetKey && targetKey !== actorKey ? nameByKey.get(targetKey) ?? null : null, taskTitle: title, at });
        }
    }

    const data: DashboardData = {
        generatedAt: now.toISOString(),
        members: dashboardMembers,
        board: {
            inProgress: openTasks.filter((t) => t.state === TASK_STATES.inProgress).slice(0, BOARD_LIMIT).map(toTask),
            review: openTasks.filter((t) => t.state === TASK_STATES.review).slice(0, BOARD_LIMIT).map(toTask),
            done: doneTasks,
        },
        attention,
        collaborations,
        activity,
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

    const filterNav = (
        <nav aria-label="Dashboard work filter" className="emperor-panel flex items-center gap-0.5 rounded-xl p-0.5">
            {([["all", "Everyone"], ["agent", "Agents"], ["human", "People"], ["mine", "My work"]] as const).map(([value, label]) => (
                <Link key={value} href={value === "all" ? "/" : `/?work=${value}`} aria-current={workFilter === value ? "page" : undefined}
                    className={cn("inline-flex min-h-8 items-center rounded-[10px] px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                        workFilter === value ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {label}
                </Link>
            ))}
        </nav>
    );

    return (
        <div className="mx-auto max-w-[1600px] space-y-5 animate-in fade-in duration-500">
            {/* First-run setup: owners and admins, until they finish or skip it,
                while the company has no agents or no profile yet. */}
            {!currentUser?.onboardingCompletedAt && !currentUser?.onboardingDismissedAt && setup && (
                <SetupWizard initialCompanyName={setup.companyName} initialBusinessType={setup.businessType} profileComplete={setup.profileComplete} hasAgents={agentRows.length > 0} />
            )}
            <TeamDashboard data={data} initialView={view} workFilter={filterNav} hasAgents={agentRows.length > 0} />
        </div>
    );
}
