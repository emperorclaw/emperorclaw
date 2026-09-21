"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { IconLoader2, IconRobot, IconSearch } from "@tabler/icons-react";
import { CreateAgentDialog } from "./create-agent-dialog";
import { EasySetupDialog } from "./easy-setup-dialog";
import { AgentDetailPanel } from "./agent-detail-panel";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";

type AgentDirectoryItem = {
    id: string;
    name: string;
    avatarUrl: string | null;
    role: string;
    status: string;
    uptime: string;
    tasksCompleted: number;
    currentLoad: number;
    deadLetterCount: number;
    failedCount: number;
};

export function AgentsClient({ agents }: { agents: AgentDirectoryItem[] }) {
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState("all");
    const [selectedId, setSelectedId] = useState(agents[0]?.id || "");
    const [advancedDialogOpen, setAdvancedDialogOpen] = useState(false);
    const router = useRouter();
    // A freshly hired agent is not instantly reachable: the runtime has to boot
    // and check in. Track it here and drop the operator into its direct chat as
    // soon as it is actually online, instead of leaving them on the directory.
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [pendingStalled, setPendingStalled] = useState(false);
    const [pendingRetrying, setPendingRetrying] = useState(false);

    const handleAgentCreated = (id: string) => {
        setSelectedId(id);
        setPendingId(id);
        setPendingStalled(false);
    };

    useEffect(() => {
        if (!pendingId) return;
        let cancelled = false;
        const check = async () => {
            try {
                const response = await fetch("/api/agents", { cache: "no-store" });
                if (!response.ok) return;
                const data = await response.json();
                const agent = (data.agents || []).find((item: { id: string }) => item.id === pendingId);
                if (cancelled || !agent) return;
                if (agent.status === "online" && agent.lastSeenAt) {
                    router.push(`/messages?agent=${pendingId}`);
                }
            } catch {
                // Transient failure: keep polling.
            }
        };
        void check();
        const interval = window.setInterval(check, 4000);
        const stallTimer = window.setTimeout(() => { if (!cancelled) setPendingStalled(true); }, 3 * 60 * 1000);
        return () => { cancelled = true; window.clearInterval(interval); window.clearTimeout(stallTimer); };
    }, [pendingId, router]);

    const retryPendingRuntime = async () => {
        if (!pendingId || pendingRetrying) return;
        setPendingRetrying(true);
        try {
            await fetch(`/api/agents/${pendingId}/recreate-runtime`, { method: "POST" });
            setPendingStalled(false);
        } finally {
            setPendingRetrying(false);
        }
    };

    const pendingName = agents.find((agent) => agent.id === pendingId)?.name || "Your agent";

    const filteredAgents = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        return agents.filter((agent) => {
            const matchesQuery = !normalized || `${agent.name} ${agent.role} ${agent.status}`.toLowerCase().includes(normalized);
            const matchesStatus = status === "all" || agent.status === status;
            return matchesQuery && matchesStatus;
        });
    }, [agents, query, status]);

    const selectedAgent = agents.find((agent) => agent.id === selectedId) || filteredAgents[0] || agents[0] || null;

    return (
        <div className="mx-auto max-w-[1800px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Agents"
                title="Agent Directory"
                description="Find agents, inspect workload, and jump into the durable profile when you need details."
                actions={
                    <div className="flex items-center gap-2">
                        <EasySetupDialog onAgentCreated={handleAgentCreated} onSwitchToAdvanced={() => setAdvancedDialogOpen(true)} />
                        <CreateAgentDialog onAgentCreated={handleAgentCreated} open={advancedDialogOpen}
                            onOpenChange={setAdvancedDialogOpen} hideTrigger />
                    </div>
                }
            />

            {pendingId && (
                <div className="flex flex-wrap items-center gap-3 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3 text-sm">
                    <IconLoader2 className="h-4 w-4 shrink-0 animate-spin text-emerald-400" />
                    <span className="text-zinc-200">
                        {pendingName} is starting up. We&apos;ll open its direct chat as soon as it&apos;s online — no action needed.
                    </span>
                    {pendingStalled && (
                        <>
                            <span className="text-amber-200/90">Still offline after a few minutes.</span>
                            <button type="button" onClick={() => void retryPendingRuntime()} disabled={pendingRetrying} className="rounded-lg border border-amber-500/40 px-3 py-1 text-xs font-medium text-amber-100 hover:bg-amber-500/10 disabled:opacity-50">
                                {pendingRetrying ? "Restarting…" : "Retry runtime"}
                            </button>
                        </>
                    )}
                </div>
            )}

            {agents.length === 0 ? (
                <div className="emperor-panel rounded-2xl py-12 text-center">
                    <IconRobot className="mx-auto mb-4 h-12 w-12 text-zinc-500" />
                    <h3 className="mb-1 font-medium text-zinc-200">No agents yet</h3>
                    <p className="text-sm text-zinc-500">Click Hire an Agent, choose a role, and connect your LLM provider. Emperor starts Hermes for you.</p>
                </div>
            ) : (
                <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <aside className="emperor-panel rounded-2xl p-3 sm:p-4">
                        <label className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-400">
                            <IconSearch className="h-4 w-4" />
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents" className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500" />
                        </label>
                        <div className="mt-3 flex gap-2">
                            {["all", "online", "degraded", "offline"].map((item) => (
                                <button key={item} type="button" onClick={() => setStatus(item)} className={cn("rounded-full border px-3 py-1 text-xs font-medium capitalize transition-colors", status === item ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100")}>
                                    {item}
                                </button>
                            ))}
                        </div>
                        <div className="mt-4 space-y-2">
                            {filteredAgents.map((agent) => (
                                <button key={agent.id} type="button" onClick={() => setSelectedId(agent.id)} className={cn("flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors", selectedAgent?.id === agent.id ? "border-cyan-400/40 bg-cyan-400/10" : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700")}>
                                    <AgentAvatar agent={agent} size="sm" />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2 truncate font-medium text-zinc-100">
                                            {agent.name}
                                            {(agent.deadLetterCount > 0 || agent.failedCount > 0) && (
                                                <span className="shrink-0 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300" title={`${agent.deadLetterCount} dead-lettered, ${agent.failedCount} failed`}>
                                                    {agent.deadLetterCount + agent.failedCount}
                                                </span>
                                            )}
                                        </span>
                                        <span className="block truncate text-xs text-zinc-500">{agent.role}{agent.tasksCompleted > 0 ? ` · ${agent.tasksCompleted} done` : ""}</span>
                                    </span>
                                    <StatusDot status={agent.status} />
                                </button>
                            ))}
                            {filteredAgents.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No agents match that search.</div> : null}
                        </div>
                    </aside>

                    {selectedAgent ? (
                        <div className="space-y-3">
                            <div className="flex justify-end">
                                <Link
                                    href={`/agents/${selectedAgent.id}`}
                                    className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-800 px-3 py-1.5 text-xs font-medium text-zinc-300 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
                                >
                                    Open detail
                                    <span aria-hidden>→</span>
                                </Link>
                            </div>
                            <AgentDetailPanel agentId={selectedAgent.id} agentName={selectedAgent.name} />
                        </div>
                    ) : (
                        <main className="emperor-panel rounded-2xl p-6 flex items-center justify-center min-h-[400px]">
                            <div className="text-center text-zinc-500">
                                <IconRobot className="mx-auto h-12 w-12 mb-3 text-zinc-600" />
                                <p className="text-sm">Select an agent from the list to view details.</p>
                            </div>
                        </main>
                    )}
                </div>
            )}
        </div>
    );
}

function StatusDot({ status }: { status: string }) {
    const statusColor = {
        online: "bg-emerald-500",
        degraded: "bg-amber-500",
        offline: "bg-zinc-600",
    }[status] || "bg-zinc-600";
    return <span className={cn("h-2 w-2 rounded-full", statusColor)} />;
}

function AgentAvatar({ agent, size = "lg" }: { agent: AgentDirectoryItem; size?: "sm" | "lg" }) {
    return (
        <div className={cn("shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900", size === "sm" ? "h-10 w-10" : "h-14 w-14")}>
            <img
                src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id || agent.name)}`}
                className="h-full w-full object-cover"
                alt=""
            />
        </div>
    );
}
