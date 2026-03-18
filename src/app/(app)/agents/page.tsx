import { db } from "@/db";
import { agents } from "@/db/schema";
import { CreateAgentDialog } from "./create-agent-dialog";
import { ManageIntegrationsDialog } from "./manage-integrations-dialog";
import { eq, and, sql, isNull } from "drizzle-orm";
import { tasks } from "@/db/schema";
import { getCompanyId } from "@/lib/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allAgents = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));

    // Calculate tasks completed per agent (mock logic with DB counts could be complex, we will just use a simple query)
    const tasksCompletedByAgent = await db.select({
        agentId: tasks.assignedAgentId,
        count: sql<number>`count(*)`
    }).from(tasks).where(and(eq(tasks.companyId, companyId), eq(tasks.state, 'done'), isNull(tasks.deletedAt))).groupBy(tasks.assignedAgentId);

    const completedMap = tasksCompletedByAgent.reduce((acc, curr) => {
        if (curr.agentId) acc[curr.agentId] = curr.count;
        return acc;
    }, {} as Record<string, number>);

    return (
        <div className="max-w-6xl mx-auto space-y-8 animate-in fade-in duration-500">
            <div className="flex items-center justify-between">
                <div className="flex flex-col space-y-1">
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">Agent Fleet</h1>
                    <p className="text-sm text-zinc-500 font-medium">Manage and monitor your OpenClaw execution muscle.</p>
                </div>

                <CreateAgentDialog />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                {allAgents.length === 0 ? (
                    <div className="col-span-2 text-center text-zinc-500 text-sm py-12">
                        No agents registered. Provide instructions to OpenClaw to spawn the baseline roster.
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
                            uptime="99.9%" // Could implement actual uptime metric later
                            tasksCompleted={completedMap[agent.id] || 0}
                            currentLoad={agent.concurrencyLimit > 0 ? Math.round((agent.currentLoad / agent.concurrencyLimit) * 100) : 0}
                            skills={((agent.skillsJson as string[]) || [])}
                            memory={agent.memory}
                        />
                    ))
                )}
            </div>
        </div>
    );
}

function AgentCard({ id, name, avatarUrl, role, status, uptime, tasksCompleted, currentLoad, skills, memory }: any) {
    const statusColor = {
        online: "bg-emerald-500",
        degraded: "bg-amber-500",
        offline: "bg-zinc-600"
    }[status as string] || "bg-zinc-600";

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
                        <h3 className="text-lg font-medium text-zinc-100 flex items-center space-x-2">
                            <span>{name}</span>
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
            </div>

            <div className="grid grid-cols-3 gap-4 mb-6">
                <div>
                    <div className="text-xs text-zinc-500 mb-1">Current Load</div>
                    <div className="font-mono text-zinc-200">{currentLoad}%</div>
                </div>
                <div>
                    <div className="text-xs text-zinc-500 mb-1">Tasks Done</div>
                    <div className="font-mono text-zinc-200">{tasksCompleted.toLocaleString()}</div>
                </div>
                <div>
                    <div className="text-xs text-zinc-500 mb-1">Uptime</div>
                    <div className="font-mono text-zinc-200">{uptime}</div>
                </div>
            </div>

            <div>
                <div className="text-xs text-zinc-500 mb-2">Registered Skills</div>
                <div className="flex flex-wrap gap-2">
                    {skills.length > 0 ? skills.map((s: string) => (
                        <span key={s} className="px-2 py-1 rounded bg-indigo-500/10 text-indigo-400/80 border border-indigo-500/20 text-xs font-mono">
                            {s}
                        </span>
                    )) : <span className="text-xs text-zinc-600 font-mono">None</span>}
                </div>
            </div>

            <div className="mt-6 pt-6 border-t border-zinc-800/80">
                <div className="text-xs text-zinc-500 mb-2">Internal Memory / Scratchpad</div>
                <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 max-h-32 overflow-y-auto font-mono text-xs text-zinc-300 whitespace-pre-wrap shadow-inner">
                    {memory ? memory : <span className="text-zinc-600 italic">No memory initialized.</span>}
                </div>
            </div>

            <ManageIntegrationsDialog agentId={id} />
        </div>
    );
}
