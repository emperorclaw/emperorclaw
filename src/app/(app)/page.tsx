import { db } from "@/db";
import { agents, tasks, incidents } from "@/db/schema";
import { eq, inArray, and, sql, isNull } from "drizzle-orm";
import { AgentTeamChat } from "@/components/agent-team-chat";
import { getCompanyId } from "@/lib/auth";
import { ACTIVE_TASK_STATES, TASK_STATES } from "@/lib/task-state";
import Link from "next/link";
import { ensureTeamThread, getThreadMessages } from "@/lib/control-plane";
import { PublicHomePage } from "@/components/public-home-page";

export const dynamic = "force-dynamic";

type WorkloadTask = {
  id: string;
  taskType: string;
};

export default async function DashboardPage() {
  const companyId = await getCompanyId();
  if (!companyId) {
    return <PublicHomePage />;
  }

  // 1. Top Level KPIs
  const [{ count: totalAgents }] = await db.select({ count: sql<number>`count(*)` }).from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
  const [{ count: queuedTasks }] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.inbox), isNull(tasks.deletedAt)));
  const [{ count: needsReview }] = await db.select({ count: sql<number>`count(*)` }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, TASK_STATES.review), isNull(tasks.deletedAt)));
  const [{ count: slaBreaches }] = await db.select({ count: sql<number>`count(*)` }).from(incidents).where(and(eq(incidents.companyId, companyId), eq(incidents.status, 'open'), isNull(incidents.deletedAt)));

  // 2. Incident List
  const recentIncidents = await db.select().from(incidents).where(and(eq(incidents.companyId, companyId), isNull(incidents.deletedAt))).orderBy(incidents.createdAt).limit(3);

  // 3. Workforce Health / Agent Load
  const allAgents = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
  const activeTasks = await db.select().from(tasks).where(and(eq(tasks.companyId, companyId), inArray(tasks.state, ACTIVE_TASK_STATES), isNull(tasks.deletedAt)));

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
    <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
      <div className="flex flex-col space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-100">Control Plane</h1>
        <p className="text-zinc-500 font-medium">System overview and active workforce telemetry.</p>
      </div>

      {totalAgents === 0 && <GettingStartedHero />}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard title="Total Agents" value={totalAgents.toString()} trend="Live" trendLabel="registered" />
        <KpiCard title="Tasks In Inbox" value={queuedTasks.toString()} trend="Live" trendLabel="awaiting assignment" />
        <KpiCard title="Needs Review" value={needsReview.toString()} trend="Live" trendLabel="requires human action" alert={needsReview > 0} />
        <KpiCard title="SLA Breaches" value={slaBreaches.toString()} trend="Live" trendLabel="open incidents" alert={slaBreaches > 0} good={slaBreaches === 0} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 pt-4">
        <div className="col-span-2 space-y-4">
          <h2 className="text-lg font-medium text-zinc-200">Recent Incidents</h2>
          <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl overflow-hidden shadow-sm">
            <div className="divide-y divide-zinc-800/50">
              {recentIncidents.length === 0 ? (
                <div className="p-4 text-sm text-zinc-500 text-center">No recent incidents. System operating normally.</div>
              ) : (
                recentIncidents.map(inc => (
                  <IncidentRow
                    key={inc.id}
                    severity={inc.severity}
                    title={inc.summary}
                    time={new Date(inc.createdAt).toLocaleTimeString()}
                    status={inc.status}
                  />
                ))
              )}
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <h2 className="text-lg font-medium text-zinc-200">Workforce Health</h2>
          <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-5 space-y-5 shadow-sm max-h-[400px] overflow-y-auto">
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
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 pt-4 pb-12">
        <div className="space-y-4">
          <h2 className="text-lg font-medium text-zinc-200">Live Agent Operations</h2>
          <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl overflow-hidden shadow-sm h-[400px]">
            <AgentTeamChat initialMessages={teamMessages} agents={allAgents} />
          </div>
        </div>
      </div>
    </div>
  );
}

function KpiCard({ title, value, trend, trendLabel, alert, good }: { title: string, value: string, trend: string, trendLabel: string, alert?: boolean, good?: boolean }) {
  return (
    <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-5 shadow-sm flex flex-col justify-between h-36 relative overflow-hidden group hover:border-zinc-700/50 transition-colors">
      {alert && <div className="absolute top-0 right-0 w-16 h-16 bg-red-500/10 rounded-bl-full blur-xl" />}
      {good && <div className="absolute top-0 right-0 w-16 h-16 bg-indigo-500/10 rounded-bl-full blur-xl" />}
      <div className="text-sm font-medium text-zinc-500">{title}</div>
      <div>
        <div className="text-3xl font-semibold text-zinc-100 mt-2">{value}</div>
        <div className="text-xs mt-2 flex items-center space-x-1">
          <span className={alert ? "text-red-400" : good ? "text-indigo-400" : "text-zinc-300"}>{trend}</span>
          <span className="text-zinc-600">{trendLabel}</span>
        </div>
      </div>
    </div>
  );
}

function GettingStartedHero() {
  return (
    <div className="bg-gradient-to-br from-indigo-500/10 via-purple-500/10 to-transparent border border-indigo-500/20 rounded-2xl p-8 mb-8 relative overflow-hidden group">
      <div className="absolute -right-20 -top-20 w-64 h-64 bg-indigo-500/20 rounded-full blur-[80px] pointer-events-none group-hover:bg-indigo-500/30 transition-all duration-700" />
      <div className="absolute -left-20 -bottom-20 w-64 h-64 bg-purple-500/20 rounded-full blur-[80px] pointer-events-none group-hover:bg-purple-500/30 transition-all duration-700" />

      <div className="relative z-10 flex flex-col md:flex-row gap-8 items-start md:items-center justify-between">
        <div className="space-y-4 max-w-2xl">
          <div className="inline-flex items-center rounded-full border border-indigo-500/30 bg-indigo-500/10 px-3 py-1 text-sm font-medium text-indigo-300">
            <span className="flex h-2 w-2 rounded-full bg-indigo-500 mr-2 animate-pulse"></span>
            Welcome to Emperor Claw
          </div>
          <h2 className="text-2xl font-semibold text-white tracking-tight">Your workforce is currently empty.</h2>
          <p className="text-zinc-400 leading-relaxed">
            To begin orchestrating AI agents, you need to connect your local OpenClaw environments to this control plane.
            Once connected, agents will automatically register here and await commands.
          </p>
        </div>
        <div className="flex-shrink-0 flex flex-col sm:flex-row gap-3">
          <Link
            href="/docs"
            className="inline-flex items-center justify-center rounded-xl bg-indigo-600 px-6 py-3 text-sm font-medium text-white shadow-lg shadow-indigo-500/20 hover:bg-indigo-500 transition-all hover:scale-105 active:scale-95"
          >
            View Setup Guide
          </Link>
          <Link
            href="/settings"
            className="inline-flex items-center justify-center rounded-xl bg-zinc-800 px-6 py-3 text-sm font-medium text-zinc-300 border border-zinc-700 hover:bg-zinc-700 hover:text-white transition-all"
          >
            Agent Context Rules
          </Link>
        </div>
      </div>
    </div>
  );
}

function IncidentRow({ severity, title, time, status }: { severity: string, title: string, time: string, status: string }) {
  const colors = {
    high: "bg-red-500/20 text-red-400 border-red-500/30",
    medium: "bg-amber-500/20 text-amber-400 border-amber-500/30",
    low: "bg-zinc-500/20 text-zinc-300 border-zinc-500/30"
  }[severity] || "bg-zinc-500/20 text-zinc-300";

  return (
    <div className="p-4 flex items-center justify-between hover:bg-zinc-800/30 transition-colors group cursor-pointer">
      <div className="flex items-center space-x-4">
        <div className={`text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded border ${colors}`}>
          {severity}
        </div>
        <div className="text-sm font-medium text-zinc-300 group-hover:text-zinc-100 transition-colors">{title}</div>
      </div>
      <div className="flex items-center space-x-4">
        <div className="text-xs text-zinc-500">{time}</div>
        {status === "resolved" && <div className="text-xs text-zinc-600 font-medium">Resolved</div>}
      </div>
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
          className={`h-full rounded-full transition-all duration-1000 ${!online ? 'bg-zinc-700' : warning ? 'bg-amber-500' : 'bg-indigo-500'}`}
          style={{ width: `${load}%` }}
        />
      </div>

      <div className="pt-1">
        {workingOn && workingOn.length > 0 ? (
          <div className="space-y-1">
            {workingOn.map((t) => (
              <div key={t.id} className="text-[10px] font-mono text-zinc-500 flex items-center space-x-1">
                <span className="w-1.5 h-1.5 rounded-full bg-indigo-500/50 pulse" />
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
