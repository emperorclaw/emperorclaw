import Link from "next/link";
import { redirect } from "next/navigation";
import { and, count, desc, eq, gt, gte, inArray, isNull, sql } from "drizzle-orm";
import { IconAlertTriangle, IconArrowRight, IconBell, IconCircleCheck, IconHeartbeat, IconRosetteDiscountCheck, IconUserCheck } from "@tabler/icons-react";
import { db } from "@/db";
import { agents, approvals, companies, companyMembers, incidents, notifications, projects, tasks, threadParticipants, users } from "@/db/schema";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { computeCompanyHealth, type HealthStatus } from "@/lib/agent-health";
import { SLA_TRACKED_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import { SetupWizard } from "@/components/setup-wizard";
import { BUSINESS_TYPES } from "@/lib/onboarding-shared";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

export const dynamic = "force-dynamic";

type WorkFilter = "all" | "mine" | "human" | "agent";

type BoardTask = { id: string; projectId: string; title: string; state: string; dueAt: Date | null; projectName: string | null };
type Worker = {
    key: string;
    kind: "agent" | "human";
    id: string;
    name: string;
    subtitle: string | null;
    avatarUrl: string | null;
    status: HealthStatus | null;
    activity: string | null;
    working: BoardTask[];
    waiting: BoardTask[];
    next: BoardTask[];
    doneToday: number;
    href: string;
};

const STATUS_STYLE: Record<HealthStatus, { label: string; className: string }> = {
    down: { label: "Down", className: "bg-rose-500/12 text-rose-300 ring-rose-500/30" },
    attention: { label: "Needs attention", className: "bg-amber-500/12 text-amber-200 ring-amber-500/30" },
    healthy: { label: "Online", className: "bg-emerald-500/12 text-emerald-300 ring-emerald-500/25" },
    idle: { label: "Idle", className: "bg-zinc-500/12 text-zinc-400 ring-zinc-500/25" },
};

function taskTitle(inputJson: unknown, taskType: string): string {
    const input = inputJson && typeof inputJson === "object" ? inputJson as Record<string, unknown> : {};
    return typeof input.title === "string" && input.title.trim() ? input.title.trim() : taskType;
}

function ago(date: Date): string {
    const minutes = Math.round((Date.now() - date.getTime()) / 60_000);
    if (minutes < 60) return `${Math.max(1, minutes)}m`;
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / 1440)}d`;
}

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ work?: string }> }) {
    const session = await getValidatedServerSession();
    const requested = (await searchParams).work;
    const workFilter: WorkFilter = ["mine", "human", "agent"].includes(requested || "") ? requested as WorkFilter : "all";
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

    const [[currentUser], members, agentRows, openTasks, doneRecently, pendingApprovals, [myUnread], [openIncidents], typing, health, projectRows] = await Promise.all([
        userId
            ? db.select({ onboardingCompletedAt: users.onboardingCompletedAt, onboardingDismissedAt: users.onboardingDismissedAt }).from(users).where(eq(users.id, userId)).limit(1)
            : Promise.resolve([]),
        db.select({ id: companyMembers.id, userId: users.id, displayName: users.displayName, email: users.email, roleTitle: users.roleTitle })
            .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
            .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))),
        db.select({ id: agents.id, name: agents.name, role: agents.role, avatarUrl: agents.avatarUrl }).from(agents)
            .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))),
        db.select({ id: tasks.id, projectId: tasks.projectId, state: tasks.state, inputJson: tasks.inputJson, taskType: tasks.taskType, slaDueAt: tasks.slaDueAt, priority: tasks.priority, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, [...SLA_TRACKED_TASK_STATES]), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.priority), tasks.createdAt),
        db.select({ id: tasks.id, projectId: tasks.projectId, inputJson: tasks.inputJson, taskType: tasks.taskType, updatedAt: tasks.updatedAt, assignedAgentId: tasks.assignedAgentId, assignedMemberId: tasks.assignedMemberId })
            .from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.done), gte(tasks.updatedAt, dayAgo), isNull(tasks.deletedAt)))
            .orderBy(desc(tasks.updatedAt)).limit(50),
        db.select({ id: approvals.id, requestedAt: approvals.requestedAt }).from(approvals)
            .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"))).orderBy(approvals.requestedAt),
        userId
            ? db.select({ value: count() }).from(notifications).where(and(eq(notifications.companyId, companyId), eq(notifications.userId, userId), isNull(notifications.readAt))).catch(() => [{ value: 0 }])
            : Promise.resolve([{ value: 0 }]),
        db.select({ value: count() }).from(incidents).where(and(eq(incidents.companyId, companyId), eq(incidents.status, "open"), isNull(incidents.deletedAt))),
        db.select({ agentId: threadParticipants.participantId, activity: threadParticipants.currentActivity }).from(threadParticipants)
            .where(and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"), gt(threadParticipants.typingUntil, now))),
        computeCompanyHealth(companyId, { now }),
        db.select({ id: projects.id, goal: projects.goal }).from(projects).where(eq(projects.companyId, companyId)),
    ]);

    const projectName = new Map(projectRows.map((p) => [p.id, p.goal]));
    const healthById = new Map(health.agents.map((a) => [a.id, a]));
    const activityByAgent = new Map(typing.filter((t) => t.agentId).map((t) => [t.agentId!, t.activity || "working…"]));
    const currentMemberId = members.find((m) => m.userId === userId)?.id ?? null;
    const toBoardTask = (t: (typeof openTasks)[number]): BoardTask => ({ id: t.id, projectId: t.projectId, title: taskTitle(t.inputJson, t.taskType), state: t.state, dueAt: t.slaDueAt, projectName: projectName.get(t.projectId) ?? null });

    const workers: Worker[] = [];
    const build = (mine: (t: { assignedAgentId: string | null; assignedMemberId: string | null }) => boolean): Pick<Worker, "working" | "waiting" | "next" | "doneToday"> => {
        const own = openTasks.filter(mine);
        return {
            working: own.filter((t) => t.state === TASK_STATES.inProgress).map(toBoardTask),
            waiting: own.filter((t) => t.state === TASK_STATES.review).map(toBoardTask),
            next: own.filter((t) => t.state === TASK_STATES.inbox).slice(0, 3).map(toBoardTask),
            doneToday: doneRecently.filter(mine).length,
        };
    };
    if (workFilter === "all" || workFilter === "agent") {
        for (const a of agentRows) {
            const h = healthById.get(a.id);
            workers.push({
                key: `agent:${a.id}`, kind: "agent", id: a.id, name: a.name, subtitle: a.role, avatarUrl: a.avatarUrl,
                status: h?.status ?? null, activity: activityByAgent.get(a.id) ?? null, href: `/agents?agent=${a.id}`,
                ...build((t) => t.assignedAgentId === a.id),
            });
        }
    }
    if (workFilter !== "agent") {
        for (const m of members) {
            if (workFilter === "mine" && m.id !== currentMemberId) continue;
            workers.push({
                key: `human:${m.id}`, kind: "human", id: m.id, name: m.displayName || m.email, subtitle: m.roleTitle, avatarUrl: null,
                status: null, activity: null, href: `/projects?assignee=human:${m.id}`,
                ...build((t) => t.assignedMemberId === m.id),
            });
        }
    }
    // Busy first; people and agents with nothing open stay out of the way.
    const rank = (w: Worker) => (w.status === "down" ? 0 : w.status === "attention" ? 1 : 2) * 1000 - (w.working.length * 3 + w.waiting.length * 2 + w.next.length);
    const active = workers.filter((w) => w.working.length + w.waiting.length + w.next.length + w.doneToday > 0 || w.status === "down" || w.status === "attention" || w.activity).sort((a, b) => rank(a) - rank(b));
    const quiet = workers.filter((w) => !active.includes(w));

    const myTasks = currentMemberId ? openTasks.filter((t) => t.assignedMemberId === currentMemberId).length : 0;
    const agentsNeedingAttention = health.agents.filter((a) => a.status === "down" || a.status === "attention").length;
    const oldestApproval = pendingApprovals[0]?.requestedAt ?? null;
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

    const workerName = (t: { assignedAgentId: string | null; assignedMemberId: string | null }) =>
        t.assignedAgentId ? agentRows.find((a) => a.id === t.assignedAgentId)?.name : t.assignedMemberId ? members.find((m) => m.id === t.assignedMemberId)?.displayName : null;

    return (
        <div className="mx-auto max-w-[1600px] space-y-6 animate-in fade-in duration-500">
            <PageHeader eyebrow="Dashboard" title="Today" description="What needs you, and what every agent and person is working on right now." />

            {/* First-run setup: owners and admins, until they finish or skip it,
                while the company has no agents or no profile yet. */}
            {!currentUser?.onboardingCompletedAt && !currentUser?.onboardingDismissedAt && setup && (
                <SetupWizard initialCompanyName={setup.companyName} initialBusinessType={setup.businessType} profileComplete={setup.profileComplete} hasAgents={agentRows.length > 0} />
            )}

            <section aria-label="Needs you" className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">
                <NeedCard href="/approvals" icon={IconRosetteDiscountCheck} label="Approvals waiting" value={pendingApprovals.length} hint={oldestApproval ? `oldest ${ago(oldestApproval)} ago` : "nothing waiting"} alert={pendingApprovals.length > 0} />
                <NeedCard href="/messages" icon={IconBell} label="Unread for you" value={Number(myUnread?.value) || 0} hint="mentions, decisions, alerts" alert={(Number(myUnread?.value) || 0) > 0} />
                <NeedCard href={currentMemberId ? `/projects?assignee=human:${currentMemberId}` : "/projects"} icon={IconUserCheck} label="Your open tasks" value={myTasks} hint="assigned to you" />
                <NeedCard href="/agents/health" icon={IconHeartbeat} label="Agents needing attention" value={agentsNeedingAttention} hint={health.totals.unanswered ? `${health.totals.unanswered} unanswered message${health.totals.unanswered === 1 ? "" : "s"}` : "all answering"} alert={agentsNeedingAttention > 0} />
                <NeedCard href="/projects?attention=1" icon={IconAlertTriangle} label="Open incidents" value={Number(openIncidents?.value) || 0} hint="failed tasks & SLA breaches" alert={(Number(openIncidents?.value) || 0) > 0} />
            </section>

            <nav aria-label="Dashboard work filter" className="flex flex-wrap items-center gap-2">
                {([["all", "Everyone"], ["agent", "Agents"], ["human", "People"], ["mine", "My work"]] as const).map(([value, label]) => (
                    <Link key={value} href={value === "all" ? "/" : `/?work=${value}`} aria-current={workFilter === value ? "page" : undefined}
                        className={cn("inline-flex min-h-9 items-center rounded-full border px-4 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                            workFilter === value ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 bg-zinc-950/80 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200")}>
                        {label}
                    </Link>
                ))}
            </nav>

            <section aria-label="Team board" className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
                {active.map((w) => <WorkerCard key={w.key} worker={w} now={now} />)}
                {active.length === 0 && (
                    <div className="emperor-panel col-span-full rounded-2xl p-10 text-center text-sm text-zinc-500">
                        {agentRows.length === 0 ? (
                            <>No agents yet. <Link href="/agents" className="text-cyan-300 hover:text-cyan-200">Hire your first agent</Link> to get started.</>
                        ) : (
                            <>Nobody has open work right now. Ask an agent for something in <Link href="/messages" className="text-cyan-300 hover:text-cyan-200">Messages</Link>, or plan work in <Link href="/projects" className="text-cyan-300 hover:text-cyan-200">Projects</Link>.</>
                        )}
                    </div>
                )}
            </section>
            {quiet.length > 0 && (
                <p className="text-xs text-zinc-600">
                    No open work: {quiet.map((w, i) => <span key={w.key}>{i ? ", " : ""}<Link href={w.href} className="hover:text-zinc-300">{w.name}</Link></span>)}
                </p>
            )}

            {doneRecently.length > 0 && (
                <section className="emperor-panel rounded-2xl p-4">
                    <h2 className="mb-1 flex items-center gap-2 px-1 text-sm font-semibold text-zinc-200"><IconCircleCheck className="h-4 w-4 text-emerald-400" />Done in the last 24 hours</h2>
                    <ul className="divide-y divide-zinc-800/70">
                        {doneRecently.slice(0, 12).map((t) => (
                            <li key={t.id}>
                                <Link href={`/projects?project=${t.projectId}&task=${t.id}`} className="flex items-center gap-3 rounded-lg px-1 py-2 hover:bg-zinc-900">
                                    <span className="min-w-0 flex-1 truncate text-sm text-zinc-300">{taskTitle(t.inputJson, t.taskType)}</span>
                                    <span className="shrink-0 text-xs text-zinc-500">{workerName(t) ?? "—"}</span>
                                    <span className="w-10 shrink-0 text-right text-[11px] text-zinc-600">{ago(t.updatedAt)}</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </div>
    );
}

function NeedCard({ href, icon: Icon, label, value, hint, alert }: { href: string; icon: typeof IconBell; label: string; value: number; hint: string; alert?: boolean }) {
    return (
        <Link href={href} className={cn("emperor-panel group rounded-2xl p-3.5 transition-colors hover:border-zinc-600 sm:p-4", alert && "border-amber-500/30")}>
            <div className="flex items-center justify-between gap-2">
                <span className="line-clamp-2 text-[11px] font-medium uppercase leading-tight tracking-wider text-zinc-500">{label}</span>
                <Icon className={cn("h-4 w-4 shrink-0", alert ? "text-amber-300" : "text-zinc-600")} />
            </div>
            <div className={cn("mt-1 text-2xl font-semibold tabular-nums", alert ? "text-amber-100" : "text-zinc-100")}>{value}</div>
            <div className="mt-0.5 truncate text-xs text-zinc-500">{hint}</div>
        </Link>
    );
}

function TaskLine({ task, now, tone }: { task: BoardTask; now: Date; tone: "working" | "waiting" | "next" }) {
    const overdue = task.dueAt && task.dueAt.getTime() < now.getTime();
    return (
        <li>
            <Link href={`/projects?project=${task.projectId}&task=${task.id}`} className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-zinc-900">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone === "working" ? "bg-cyan-400" : tone === "waiting" ? "bg-amber-400" : "bg-zinc-600")} />
                <span className="min-w-0 flex-1 truncate text-sm text-zinc-300 group-hover:text-zinc-100">{task.title}</span>
                {overdue && <span className="shrink-0 rounded bg-rose-500/15 px-1.5 text-[10px] font-medium text-rose-300">overdue</span>}
            </Link>
        </li>
    );
}

function WorkerCard({ worker, now }: { worker: Worker; now: Date }) {
    const status = worker.status ? STATUS_STYLE[worker.status] : null;
    return (
        <article className="emperor-panel flex min-w-0 flex-col gap-3 rounded-2xl p-4">
            <div className="flex items-start gap-3">
                {worker.kind === "agent" ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={worker.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(worker.id)}`} alt="" className="h-9 w-9 shrink-0 rounded-xl border border-zinc-800 bg-zinc-900 object-cover" />
                ) : (
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-zinc-800 bg-zinc-900 text-sm font-semibold text-zinc-400">{worker.name.slice(0, 1).toUpperCase()}</span>
                )}
                <div className="min-w-0 flex-1">
                    <Link href={worker.href} className="block truncate text-sm font-semibold text-zinc-100 hover:text-zinc-50">{worker.name}</Link>
                    <div className="truncate text-xs text-zinc-500">{worker.activity ? <span className="text-cyan-300">{worker.activity}</span> : worker.subtitle || (worker.kind === "human" ? "Person" : "Agent")}</div>
                </div>
                {status && <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", status.className)}>{status.label}</span>}
            </div>
            {worker.working.length > 0 && (
                <div>
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Working on</div>
                    <ul>{worker.working.map((t) => <TaskLine key={t.id} task={t} now={now} tone="working" />)}</ul>
                </div>
            )}
            {worker.waiting.length > 0 && (
                <div>
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Waiting on a person</div>
                    <ul>{worker.waiting.map((t) => <TaskLine key={t.id} task={t} now={now} tone="waiting" />)}</ul>
                </div>
            )}
            {worker.next.length > 0 && (
                <div>
                    <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Next up</div>
                    <ul>{worker.next.map((t) => <TaskLine key={t.id} task={t} now={now} tone="next" />)}</ul>
                </div>
            )}
            <div className="mt-auto flex items-center justify-between border-t border-zinc-800/80 pt-2.5 text-xs text-zinc-500">
                <span><span className="tabular-nums text-zinc-300">{worker.doneToday}</span> done today</span>
                <Link href={worker.href} className="inline-flex items-center gap-1 hover:text-zinc-300">Details<IconArrowRight className="h-3 w-3" /></Link>
            </div>
        </article>
    );
}
