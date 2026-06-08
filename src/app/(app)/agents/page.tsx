import { db } from "@/db";
import { agents } from "@/db/schema";
import { CreateAgentDialog } from "./create-agent-dialog";
import { ManageIntegrationsDialog } from "./manage-integrations-dialog";
import { eq, and, sql, isNull } from "drizzle-orm";
import { tasks } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";
import { Github, Mail, Settings2, Zap } from "lucide-react";
import Link from "next/link";
import { listAgentIntegrationsForAgents } from "@/lib/agent-integrations";

export const dynamic = "force-dynamic";

type AgentIntegrationRow = Awaited<ReturnType<typeof listAgentIntegrationsForAgents>>[number];
type AgentCardProps = {
    id: string;
    name: string;
    avatarUrl: string | null;
    role: string;
    status: string;
    uptime: string;
    tasksCompleted: number;
    currentLoad: number;
    integrations: AgentIntegrationRow[];
};

export default async function AgentsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allAgents = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));

    // Calculate tasks completed per agent
    const tasksCompletedByAgent = await db.select({
        agentId: tasks.assignedAgentId,
        count: sql<number>`count(*)`
    }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, 'done'), isNull(tasks.deletedAt))).groupBy(tasks.assignedAgentId);

    const completedMap = tasksCompletedByAgent.reduce((acc, curr) => {
        if (curr.agentId) acc[curr.agentId] = curr.count;
        return acc;
    }, {} as Record<string, number>);

    // Fetch all integrations for these agents
    const integrationsList = allAgents.length > 0
        ? await listAgentIntegrationsForAgents(companyId, allAgents.map(a => a.id))
        : [];

    const integrationMap = integrationsList.reduce((acc, curr) => {
        if (!acc[curr.agentId]) acc[curr.agentId] = [];
        acc[curr.agentId].push(curr);
        return acc;
    }, {} as Record<string, AgentIntegrationRow[]>);

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div className="flex flex-col space-y-1">
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Agents</h1>
                    <p className="text-sm text-zinc-500 font-medium">Manage durable agent profiles, runtime status, workload, and advanced tool access.</p>
                </div>

                <CreateAgentDialog />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {allAgents.length === 0 ? (
                    <div className="col-span-2 text-center text-zinc-500 text-sm py-12">
                        No agents yet. Add an agent profile, then connect a Hermes/OpenClaw runtime when it is ready to work.
                    </div>
                ) : (
                    allAgents.map(agent => (
                        <AgentCard
                            key={agent.id}
                            id={agent.id}
                            name={agent.name}
                            avatarUrl={agent.avatarUrl}
                            role={agent.role || 'Unspecified'}
                            status={agent.status}
                            uptime="99.9%"
                            tasksCompleted={completedMap[agent.id] || 0}
                            currentLoad={agent.concurrencyLimit > 0 ? Math.round((agent.currentLoad / agent.concurrencyLimit) * 100) : 0}
                            integrations={integrationMap[agent.id] || []}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

function AgentCard({ id, name, avatarUrl, role, status, uptime, tasksCompleted, currentLoad, integrations }: AgentCardProps) {
    const statusColor = {
        online: "bg-emerald-500",
        degraded: "bg-amber-500",
        offline: "bg-zinc-600"
    }[status as string] || "bg-zinc-600";

    const visibleIntegrations = integrations.slice(0, 5);

    return (
        <div className="bg-zinc-900/50 border border-zinc-800/80 rounded-xl p-6 relative overflow-hidden group hover:border-zinc-700 transition-colors">
            <div className="flex justify-between items-start mb-6">
                <div className="flex items-center space-x-4">
                    <div className="w-12 h-12 rounded-full bg-zinc-800 border-2 border-zinc-700/50 flex items-center justify-center overflow-hidden">
                        <img 
                            src={avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(id || name)}`} 
                            className="w-full h-full object-cover"
                            alt=""
                        />
                    </div>
                    <div>
                        <h3 className="text-lg font-medium text-zinc-100 flex flex-wrap items-center gap-2">
                            <Link href={`/agents/${id}`} className="hover:text-white underline-offset-4 hover:underline">
                                {name}
                            </Link>
                            <span className="px-2 py-0.5 rounded text-[10px] uppercase tracking-wider font-semibold bg-zinc-800 text-zinc-400">
                                {role}
                            </span>
                        </h3>
                        <div className="flex items-center space-x-2 mt-1">
                            <div className={`w-2 h-2 rounded-full ${statusColor}`} />
                            <span className="text-xs font-medium text-zinc-400 capitalize">{status}</span>
                        </div>
                    </div>
                </div>

                {integrations.length > 0 && (
                    <div className="flex -space-x-1.5 overflow-hidden">
                        {visibleIntegrations.map((integration) => (
                            <div key={integration.id} className="w-6 h-6 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-zinc-400 ring-4 ring-zinc-950" title={`${integration.name} (${integration.provider})`}>
                                {integration.provider === "github"
                                    ? <Github className="w-3 h-3" />
                                    : integration.provider.startsWith("email")
                                        ? <Mail className="w-3 h-3" />
                                        : <Settings2 className="w-3 h-3" />}
                            </div>
                        ))}
                    </div>
                )}
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6 text-center bg-zinc-950/30 rounded-lg p-2 border border-zinc-800/50">
                <div>
                    <div className="text-[10px] uppercase font-bold text-zinc-600 mb-0.5 tracking-tighter">Current Load</div>
                    <div className="font-mono text-zinc-200 text-sm">{currentLoad}%</div>
                </div>
                <div className="border-x border-zinc-800/50 px-2">
                    <div className="text-[10px] uppercase font-bold text-zinc-600 mb-0.5 tracking-tighter">Tasks Done</div>
                    <div className="font-mono text-zinc-200 text-sm">{tasksCompleted.toLocaleString()}</div>
                </div>
                <div>
                    <div className="text-[10px] uppercase font-bold text-zinc-600 mb-0.5 tracking-tighter">Uptime</div>
                    <div className="font-mono text-zinc-200 text-sm">{uptime}</div>
                </div>
            </div>

            {integrations.length > 0 && (
                <div className="mb-6">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider mb-2">Runtime Integrations</div>
                    <div className="flex flex-wrap gap-2">
                        {integrations.map((i) => (
                            <div key={i.id} className="inline-flex items-center px-2 py-1 rounded-md bg-zinc-950 border border-zinc-800 text-[10px] text-zinc-400 font-medium">
                                {i.provider === "github"
                                    ? <Github className="w-2.5 h-2.5 mr-1.5 text-zinc-500" />
                                    : i.provider.includes("email")
                                        ? <Mail className="w-2.5 h-2.5 mr-1.5 text-indigo-400" />
                                        : <Zap className="w-2.5 h-2.5 mr-1.5 text-zinc-500" />}
                                <span>{i.name}</span>
                            </div>
                        ))}
                    </div>
                    <p className="mt-2 text-[11px] text-zinc-600">
                        Keep customer mailboxes, identities, and templates in Knowledge & Rules unless they truly belong to this worker only.
                    </p>
                </div>
            )}

            <div className="mt-6 rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-4">
                    <div className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">What belongs here</div>
                    <p className="mt-2 text-sm leading-6 text-zinc-400">
                    Keep stable identity, role, memory, and runtime health on the agent. Put project rules,
                    customer-specific process, and shared credentials in Knowledge & Rules.
                </p>
                <div className="mt-4">
                    <Link
                        href={`/agents/${id}`}
                        className="text-xs font-medium uppercase tracking-[0.18em] text-indigo-300 transition-colors hover:text-indigo-200"
                    >
                        Open full agent detail
                    </Link>
                </div>
            </div>

            <ManageIntegrationsDialog agentId={id} />
        </div>
    );
}
