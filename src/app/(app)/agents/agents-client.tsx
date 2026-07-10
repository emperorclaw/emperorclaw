"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { Bot, Search } from "lucide-react";
import { CreateAgentDialog } from "./create-agent-dialog";
import { DeleteAgentDialog } from "./delete-agent-dialog";
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
};

export function AgentsClient({ agents }: { agents: AgentDirectoryItem[] }) {
    const [query, setQuery] = useState("");
    const [status, setStatus] = useState("all");
    const [selectedId, setSelectedId] = useState(agents[0]?.id || "");

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
            <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="space-y-1">
                    <p className="text-xs font-bold uppercase tracking-[0.24em] text-cyan-300">Agents</p>
                    <h1 className="text-2xl font-semibold tracking-tight text-zinc-100 sm:text-3xl">Agent Directory</h1>
                    <p className="text-sm text-zinc-400">Find agents, inspect workload, and jump into the durable profile when you need details.</p>
                </div>
                <CreateAgentDialog />
            </div>

            {agents.length === 0 ? (
                <div className="emperor-panel rounded-2xl py-12 text-center">
                    <Bot className="mx-auto mb-4 h-12 w-12 text-zinc-500" />
                    <h3 className="mb-1 font-medium text-zinc-200">No agents yet</h3>
                    <p className="text-sm text-zinc-500">Add an agent profile, then connect a Hermes/OpenClaw runtime when it is ready to work.</p>
                </div>
            ) : (
                <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
                    <aside className="emperor-panel rounded-2xl p-4">
                        <label className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-400">
                            <Search className="h-4 w-4" />
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
                                        <span className="block truncate font-medium text-zinc-100">{agent.name}</span>
                                        <span className="block truncate text-xs text-zinc-500">{agent.role}</span>
                                    </span>
                                    <StatusDot status={agent.status} />
                                </button>
                            ))}
                            {filteredAgents.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No agents match that search.</div> : null}
                        </div>
                    </aside>

                    {selectedAgent ? <AgentDetail agent={selectedAgent} /> : null}
                </div>
            )}
        </div>
    );
}

function AgentDetail({ agent }: { agent: AgentDirectoryItem }) {
    return (
        <main className="emperor-panel rounded-2xl p-5">
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-zinc-800/80 pb-5">
                <div className="flex items-center gap-4">
                    <AgentAvatar agent={agent} />
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-2xl font-semibold text-zinc-100">{agent.name}</h2>
                            <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">{agent.role}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2 text-sm text-zinc-400">
                            <StatusDot status={agent.status} />
                            <span className="capitalize">{agent.status}</span>
                        </div>
                    </div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <Link href={`/agents/${agent.id}`} className="rounded-full border border-cyan-400/40 bg-cyan-400/10 px-4 py-2 text-xs font-bold uppercase tracking-[0.16em] text-cyan-100 transition-colors hover:bg-cyan-400/15">
                        Open detail
                    </Link>
                    <DeleteAgentDialog agentId={agent.id} agentName={agent.name} />
                </div>
            </div>

            <div className="mt-5 grid gap-3 md:grid-cols-3">
                <Metric label="Current Load" value={`${agent.currentLoad}%`} />
                <Metric label="Tasks Done" value={agent.tasksCompleted.toLocaleString()} />
                <Metric label="Uptime" value={agent.uptime} />
            </div>
        </main>
    );
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

function StatusDot({ status }: { status: string }) {
    const statusColor = {
        online: "bg-emerald-500",
        degraded: "bg-amber-500",
        offline: "bg-zinc-600",
    }[status] || "bg-zinc-600";
    return <span className={cn("h-2 w-2 rounded-full", statusColor)} />;
}

function Metric({ label, value }: { label: string; value: string }) {
    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-4">
            <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">{label}</div>
            <div className="mt-2 font-mono text-lg text-zinc-100">{value}</div>
        </div>
    );
}
