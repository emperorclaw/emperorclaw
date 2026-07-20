import Link from "next/link";
import { redirect } from "next/navigation";
import { db } from "@/db";
import { agents, tasks, incidents, companyTokens, users, threadMessages, projects, artifacts, scopedResources, pipelines, pipelineRuns } from "@/db/schema";
import { eq, inArray, and, sql, isNull, desc, gte } from "drizzle-orm";
import { AgentTeamChat } from "@/components/agent-team-chat";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { ACTIVE_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import { ensureTeamThread, getThreadMessages } from "@/lib/control-plane";
import { OnboardingTour } from "@/components/onboarding-tour";
import { PageHeader } from "@/components/page-header";
import { opsEvents } from "@/db/schema";

export const dynamic = "force-dynamic";

type WorkloadTask = {
  id: string;
  taskType: string;
};

type RecentActivity = {
  id: string;
  kind: string;
  actorLabel: string;
  actor: string;
  title: string;
  detail: string;
  time: Date;
  tone: "default" | "good" | "warning" | "critical" | "info";
};

export default async function DashboardPage() {
  const session = await getValidatedServerSession();
  const companyId = await getCompanyId();
  if (!companyId) {
    redirect("/login");
  }

  const [currentUser] = session?.user?.id
    ? await db.select({
      onboardingCompletedAt: users.onboardingCompletedAt,
      onboardingDismissedAt: users.onboardingDismissedAt,
    }).from(users).where(eq(users.id, session.user.id)).limit(1)
    : [];

  // 1. Top Level KPIs
  const [{ count: totalAgents }] = await db.select({ count: sql<number>`count(*)` }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
  const [{ count: queuedTasks }] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.inbox), isNull(tasks.deletedAt)));
  const [{ count: needsReview }] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.review), isNull(tasks.deletedAt)));
  const [{ count: openIncidents }] = await db.select({ count: sql<number>`count(*)` }).from(incidents).where(and(eq(incidents.companyId, companyId), eq(incidents.status, 'open'), isNull(incidents.deletedAt)));
  const [{ count: activeTokens }] = await db.select({ count: sql<number>`count(*)` }).from(companyTokens).where(and(eq(companyTokens.companyId, companyId), isNull(companyTokens.revokedAt)));
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [{ count: recentErrors }] = await db.select({ count: sql<number>`count(*)` }).from(opsEvents).where(and(eq(opsEvents.companyId, companyId), eq(opsEvents.level, "error"), gte(opsEvents.createdAt, last24h)));

  // 2. Workforce Health / Agent Load
  const allAgents = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
  const activeTasks = await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, ACTIVE_TASK_STATES), isNull(tasks.deletedAt)));
  const agentNameById = new Map(allAgents.map(agent => [agent.id, agent.name]));

  // 3. Recent Activity
  const [
    recentMessages,
    recentTasks,
    recentProjects,
    recentAgents,
    recentArtifacts,
    recentResources,
    recentIncidents,
    activePipelines,
    recentPipelineRuns,
  ] = await Promise.all([
    db.select().from(threadMessages).where(eq(threadMessages.companyId, companyId)).orderBy(desc(threadMessages.createdAt)).limit(8),
    db.select().from(tasks).where(and(eq(tasks.companyId, companyId), isNull(tasks.deletedAt))).orderBy(desc(tasks.updatedAt)).limit(6),
    db.select().from(projects).where(and(eq(projects.companyId, companyId), isNull(projects.deletedAt))).orderBy(desc(projects.updatedAt)).limit(4),
    db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt))).orderBy(desc(agents.createdAt)).limit(4),
    db.select().from(artifacts).where(and(eq(artifacts.companyId, companyId), isNull(artifacts.deletedAt))).orderBy(desc(artifacts.createdAt)).limit(4),
    db.select().from(scopedResources).where(and(eq(scopedResources.companyId, companyId), isNull(scopedResources.deletedAt))).orderBy(desc(scopedResources.createdAt)).limit(4),
    db.select().from(incidents).where(and(eq(incidents.companyId, companyId), isNull(incidents.deletedAt))).orderBy(desc(incidents.createdAt)).limit(4),
    db.select().from(pipelines).where(and(eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt))).orderBy(desc(pipelines.updatedAt)).limit(20),
    db.select().from(pipelineRuns).where(eq(pipelineRuns.companyId, companyId)).orderBy(desc(pipelineRuns.startedAt)).limit(6),
  ]);

  const pipelineNameById = new Map(activePipelines.map(pipeline => [pipeline.id, pipeline.name]));

  const recentActivities: RecentActivity[] = [
    ...recentMessages.map((message): RecentActivity => {
      const senderName = message.senderType === "agent" && message.senderId
        ? agentNameById.get(message.senderId) || "Agent"
        : message.senderType === "human" ? "Human" : "System";
      return {
        id: `message-${message.id}`,
        kind: "Message",
        actorLabel: "From",
        actor: senderName,
        title: "Message sent",
        detail: truncate(message.text, 120),
        time: message.createdAt,
        tone: message.senderType === "human" ? "info" : "default",
      };
    }),
    ...recentTasks.map((task): RecentActivity => ({
      id: `task-${task.id}`,
      kind: "Task",
      actorLabel: "Owner",
      actor: task.assignedAgentId ? agentNameById.get(task.assignedAgentId) || "Assigned agent" : "Unassigned",
      title: `Task ${task.state}`,
      detail: `${task.taskType} · TASK-${task.id.substring(0, 8)}`,
      time: task.updatedAt,
      tone: task.state === TASK_STATES.review ? "warning" : task.state === TASK_STATES.done ? "good" : "default",
    })),
    ...recentProjects.map((project): RecentActivity => ({
      id: `project-${project.id}`,
      kind: "Project",
      actorLabel: "Lead",
      actor: project.leadAgentId ? agentNameById.get(project.leadAgentId) || "Lead agent" : "No lead",
      title: `Project ${project.status}`,
      detail: truncate(project.goal, 120),
      time: project.updatedAt,
      tone: project.status === "active" ? "info" : project.status === "completed" ? "good" : "default",
    })),
    ...recentAgents.map((agent): RecentActivity => ({
      id: `agent-${agent.id}`,
      kind: "Agent",
      actorLabel: "Agent",
      actor: agent.name,
      title: `${agent.name} registered`,
      detail: agent.role || "operator",
      time: agent.createdAt,
      tone: agent.status === "online" ? "good" : "default",
    })),
    ...recentArtifacts.map((artifact): RecentActivity => ({
      id: `artifact-${artifact.id}`,
      kind: "Storage",
      actorLabel: "Added by",
      actor: artifact.agentId ? agentNameById.get(artifact.agentId) || "Agent" : artifact.createdByType || "System",
      title: artifact.title || artifact.originalFilename || "Storage item added",
      detail: artifact.path || `${artifact.kind} · ${artifact.contentType}`,
      time: artifact.createdAt,
      tone: "info",
    })),
    ...recentResources.map((resource): RecentActivity => ({
      id: `resource-${resource.id}`,
      kind: "Rules",
      actorLabel: "Scope",
      actor: resource.scopeType === "agent" && resource.scopeId ? agentNameById.get(resource.scopeId) || "Agent" : "System",
      title: resource.displayName || resource.name,
      detail: `${resource.scopeType} · ${resource.resourceType}`,
      time: resource.createdAt,
      tone: "default",
    })),
    ...recentPipelineRuns.map((run): RecentActivity => ({
      id: `pipeline-run-${run.id}`,
      kind: "Pipeline",
      actorLabel: "Run by",
      actor: run.agentId ? agentNameById.get(run.agentId) || "Agent" : "Runtime",
      title: `${pipelineNameById.get(run.pipelineId) || "Pipeline"} ${run.status}`,
      detail: truncate(run.summary, 120) || `run ${run.id.substring(0, 8)}`,
      time: run.startedAt,
      tone: run.status === "succeeded" ? "good" : run.status === "failed" ? "critical" : run.status === "partial" ? "warning" : "info",
    })),
    ...recentIncidents.map((incident): RecentActivity => ({
      id: `incident-${incident.id}`,
      kind: "Attention",
      actorLabel: "Source",
      actor: "Watchdog",
      title: incident.summary,
      detail: `${incident.severity} - ${incident.status}`,
      time: incident.createdAt,
      tone: incident.status === "resolved" ? "default" : incident.severity === "high" ? "critical" : "warning",
    })),
  ]
    .sort((a, b) => b.time.getTime() - a.time.getTime())
    .slice(0, 8);

  const agentWorkload = allAgents.map(agent => {
    const assignedTasks = activeTasks.filter(t => t.assignedAgentId === agent.id && t.state === TASK_STATES.inProgress);
    const assignedReview = activeTasks.filter(t => t.assignedAgentId === agent.id && t.state === TASK_STATES.review);
    const loadPercent = agent.concurrencyLimit > 0
      ? Math.round((assignedTasks.length / agent.concurrencyLimit) * 100)
      : 0;

    return {
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.avatarUrl,
      online: agent.status === 'online',
      load: Math.min(loadPercent, 100),
      workingOn: assignedTasks.map(({ id, taskType }) => ({ id, taskType })),
      reviewing: assignedReview.map(({ id, taskType }) => ({ id, taskType }))
    };
  });

  // 4. Agent Team Thread Feed
  const teamThread = await ensureTeamThread(companyId);
  const teamMessages = await getThreadMessages(companyId, teamThread.id, 50);

  return (
    <div className="mx-auto max-w-[1800px] space-y-8 animate-in fade-in duration-500">
      <PageHeader
        eyebrow="Dashboard"
        title="Overview"
        description="Your agents, recent work, and team communication — all in one place."
      />

      {totalAgents === 0 && !currentUser?.onboardingCompletedAt && !currentUser?.onboardingDismissedAt && (
        <OnboardingTour
          companyId={companyId}
          initialAgentCount={totalAgents}
          initialTokenCount={activeTokens}
        />
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <KpiCard title="Total Agents" value={totalAgents.toString()} trend="Live" trendLabel="registered" />
        <KpiCard title="To do" value={queuedTasks.toString()} trend="Live" trendLabel="awaiting assignment" />
        <KpiCard title="Needs your review" value={needsReview.toString()} trend="Live" trendLabel="requires human action" alert={needsReview > 0} href="/projects?attention=1" />
        <KpiCard title="Open issues" value={openIncidents.toString()} trend="Live" trendLabel="failed tasks & SLA breaches" alert={openIncidents > 0} good={openIncidents === 0} href="/projects?attention=1" />
        <KpiCard title="System errors" value={recentErrors.toString()} trend="24h" trendLabel="platform errors" alert={recentErrors > 0} good={recentErrors === 0} href="/ops/errors" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 pt-4">
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-lg font-medium text-zinc-200">Recent Activity</h2>
          <div className="emperor-panel overflow-hidden rounded-2xl">
            <div className="divide-y divide-zinc-800/50">
              {recentActivities.length === 0 ? (
                <div className="p-4 text-sm text-zinc-500 text-center">No recent activity yet.</div>
              ) : (
                recentActivities.map(activity => (
                  <ActivityRow
                    key={activity.id}
                    kind={activity.kind}
                    actorLabel={activity.actorLabel}
                    actor={activity.actor}
                    title={activity.title}
                    detail={activity.detail}
                    time={activity.time}
                    tone={activity.tone}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-medium text-zinc-200">Agent status</h2>
          <div className="emperor-panel max-h-72 sm:max-h-[400px] space-y-5 overflow-y-auto rounded-2xl p-4 sm:p-5">
            {agentWorkload.length === 0 ? (
              <div className="text-sm text-zinc-500 text-center">No agents registered.</div>
            ) : (
              agentWorkload.map(aw => (
                <HealthItem
                  key={aw.id}
                  id={aw.id}
                  name={aw.name}
                  avatarUrl={aw.avatarUrl}
                  load={aw.load}
                  online={aw.online}
                  warning={aw.load >= 90}
                  workingOn={aw.workingOn}
                />
              ))
            )}
          </div>

          <h2 className="text-lg font-medium text-zinc-200">Automations</h2>
          <div className="emperor-panel space-y-3 rounded-2xl p-4 sm:p-5">
            {activePipelines.length === 0 ? (
              <div className="text-sm text-zinc-500">
                No automations yet. Agents set these up from their own runtimes.
              </div>
            ) : (
              activePipelines.slice(0, 5).map(pipeline => (
                <div key={pipeline.id} className="flex items-center gap-2 text-sm">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${pipeline.status === "active" ? "bg-emerald-400" : pipeline.status === "paused" ? "bg-amber-400" : "bg-zinc-600"}`} />
                  <span className="text-zinc-200 truncate flex-1">{pipeline.name}</span>
                  {pipeline.lastRunStatus && (
                    <span className={`text-xs ${pipeline.lastRunStatus === "succeeded" ? "text-emerald-400" : pipeline.lastRunStatus === "failed" ? "text-red-400" : "text-zinc-500"}`}>
                      {pipeline.lastRunStatus}
                    </span>
                  )}
                  <span className="text-xs text-zinc-600">{pipeline.runCount} runs</span>
                </div>
              ))
            )}
            <Link href="/pipelines" className="block pt-1 text-xs font-medium text-cyan-300 transition-colors hover:text-cyan-200">
              View all pipelines →
            </Link>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 pt-4 pb-12">
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-zinc-200">Team Channel</h2>
            <Link href="/messages" className="text-xs font-medium text-cyan-300 transition-colors hover:text-cyan-200">
              Open full channel →
            </Link>
          </div>
          <div className="emperor-panel h-[360px] sm:h-[480px] overflow-hidden rounded-2xl">
            <AgentTeamChat initialMessages={teamMessages} agents={allAgents} sendable={true} teamThreadId={teamThread.id} />
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ title, value, trend, trendLabel, alert, good, href }: { title: string, value: string, trend: string, trendLabel: string, alert?: boolean, good?: boolean, href?: string }) {
  const card = (
    <div className={`emperor-panel group relative flex h-28 sm:h-36 flex-col justify-between overflow-hidden rounded-2xl p-3.5 sm:p-5 transition-colors ${href ? 'cursor-pointer hover:border-cyan-400/30' : 'hover:border-zinc-700/80'}`}>
      {alert && <div className="absolute top-0 right-0 w-16 h-16 bg-red-500/10 rounded-bl-full blur-xl" />}
      {good && <div className="absolute top-0 right-0 w-16 h-16 bg-cyan-500/10 rounded-bl-full blur-xl" />}
      <div className="text-xs sm:text-sm font-medium text-zinc-500 truncate">{title}</div>
      <div>
        <div className="text-2xl sm:text-3xl font-semibold text-zinc-100 mt-1 sm:mt-2">{value}</div>
        <div className="text-[10px] sm:text-xs mt-1.5 sm:mt-2 flex items-center space-x-1">
          <span className={alert ? "text-red-400" : good ? "text-cyan-400" : "text-zinc-300"}>{trend}</span>
          <span className="text-zinc-600 truncate">{trendLabel}</span>
          {href && <span className="text-cyan-400 opacity-0 group-hover:opacity-100 transition-opacity ml-1">→</span>}
        </div>
      </div>
    </div>
  );
  if (href) return <Link href={href}>{card}</Link>;
  return card;
}

function truncate(value: string | null | undefined, maxLength: number) {
  const text = (value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trim()}...`;
}

function ActivityRow({ kind, actorLabel, actor, title, detail, time, tone }: { kind: string, actorLabel: string, actor: string, title: string, detail: string, time: Date, tone: RecentActivity["tone"] }) {
  const colors = {
    default: "bg-zinc-500/15 text-zinc-300 border-zinc-500/20",
    good: "bg-emerald-500/15 text-emerald-300 border-emerald-500/25",
    warning: "bg-amber-500/15 text-amber-300 border-amber-500/25",
    critical: "bg-red-500/15 text-red-300 border-red-500/25",
    info: "bg-cyan-500/15 text-cyan-300 border-cyan-500/25",
  }[tone];

  return (
    <div className="p-3 sm:p-4 flex items-start justify-between gap-3 sm:gap-4 hover:bg-zinc-800/30 transition-colors group">
      <div className="min-w-0 flex items-start space-x-3 sm:space-x-4">
        <div className={`shrink-0 text-[9px] sm:text-[10px] uppercase font-bold tracking-wider px-1.5 sm:px-2 py-0.5 rounded border ${colors}`}>
          {kind}
        </div>
        <div className="min-w-0">
          <div className="text-sm font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors truncate">{title}</div>
          <div className="text-xs text-zinc-500 mt-0.5 sm:mt-1 truncate">{actorLabel}: {actor}</div>
          {detail && <div className="text-xs text-zinc-500 mt-0.5 sm:mt-1 line-clamp-2">{detail}</div>}
        </div>
      </div>
      <div className="shrink-0 text-[10px] sm:text-xs text-zinc-500 whitespace-nowrap pt-0.5">{time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
    </div>
  );
}

function HealthItem({ id, name, avatarUrl, load, online, warning, workingOn }: { id: string, name: string, avatarUrl: string | null, load: number, online: boolean, warning?: boolean, workingOn?: WorkloadTask[] }) {
  return (
    <div className="flex flex-col space-y-2">
      <div className="flex justify-between items-center text-sm">
        <div className="flex items-center space-x-2">
          <div className="w-6 h-6 rounded-full overflow-hidden border border-zinc-800">
            <img 
               src={avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(id || name)}`} 
               className="w-full h-full object-cover"
               alt=""
            />
          </div>
          <div className={`w-1.5 h-1.5 rounded-full ${online ? (warning ? 'bg-amber-400' : 'bg-emerald-400') : 'bg-zinc-600'}`} />
          <span className="font-medium text-zinc-300">{name}</span>
        </div>
        <span className="text-zinc-500 tracking-tight font-mono text-xs">{load}% load</span>
      </div>
      <div className="h-1.5 w-full bg-zinc-800/80 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-1000 ${!online ? 'bg-zinc-700' : warning ? 'bg-amber-500' : 'bg-cyan-500'}`}
          style={{ width: `${load}%` }}
        />
      </div>

      <div className="pt-1">
        {workingOn && workingOn.length > 0 ? (
          <div className="space-y-1">
            {workingOn.map((t) => (
              <div key={t.id} className="text-[10px] font-mono text-zinc-500 flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-500/50 animate-pulse" />
                <span className="truncate">Working on: TASK-{t.id.substring(0, 8)} ({t.taskType})</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="text-[10px] font-mono text-zinc-600 flex items-center space-x-1">
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-700" />
            <span>Idle / Available</span>
          </div>
        )}
      </div>
    </div>
  );
}
