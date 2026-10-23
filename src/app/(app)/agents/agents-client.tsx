"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { IconArrowLeft, IconHierarchy2, IconHeartbeat, IconLoader2, IconRobot, IconSearch, IconWallet } from "@tabler/icons-react";
import { CreateAgentDialog } from "./create-agent-dialog";
import { EasySetupDialog } from "./easy-setup-dialog";
import { AgentDetailPanel } from "./agent-detail-panel";
import { AgentNowCard, BridgeBadge, formatDuration } from "./agent-now-card";
import { useAgentActivity } from "./use-agent-activity";
import { PageHeader } from "@/components/page-header";
import { agentAvatarSrc } from "@/lib/avatar";
import { cn } from "@/lib/utils";
import type { AgentNow } from "@/lib/agent-activity";

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
    // `?agent=<id>` opens that agent (old /agents/<id> links redirect here).
    const searchParams = useSearchParams();
    const linkedId = searchParams.get("agent");
    // `?hire=1` (the command palette's Hire agent) opens the hiring dialog.
    const hireRequested = searchParams.get("hire") === "1";
    const [selectedId, setSelectedId] = useState((linkedId && agents.some((a) => a.id === linkedId) ? linkedId : agents[0]?.id) || "");
    const [mobileView, setMobileView] = useState<"list" | "detail">(linkedId ? "detail" : "list");
    const [advancedDialogOpen, setAdvancedDialogOpen] = useState(false);
    const router = useRouter();
    // A freshly hired agent is not instantly reachable: the runtime has to boot
    // and check in. Track it here and drop the operator into its direct chat as
    // soon as it is actually online, instead of leaving them on the directory.
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [pendingStalled, setPendingStalled] = useState(false);
    const [pendingRetrying, setPendingRetrying] = useState(false);
    const activity = useAgentActivity();

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
                    <div className="flex flex-wrap items-center gap-2">
                        <Link href="/agents/organization" className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/5 px-3 text-sm text-cyan-400 hover:bg-cyan-500/10"><IconHierarchy2 className="h-4 w-4" />Organization</Link>
                        <Link
                            href="/agents/health"
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-zinc-800 px-3 text-sm text-zinc-300 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
                        >
                            <IconHeartbeat className="h-4 w-4" />
                            Health
                        </Link>
                        <Link
                            href="/budgets"
                            className="inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-zinc-800 px-3 text-sm text-zinc-300 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
                        >
                            <IconWallet className="h-4 w-4" />
                            Budgets
                        </Link>
                        <EasySetupDialog key={hireRequested ? "hire" : "idle"} defaultOpen={hireRequested} onAgentCreated={handleAgentCreated} onSwitchToAdvanced={() => setAdvancedDialogOpen(true)} />
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
                <div className="grid grid-cols-1 gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
                    <aside className={cn("emperor-panel min-w-0 overflow-hidden rounded-2xl p-3 sm:p-4", mobileView === "detail" ? "hidden lg:block" : "")}>
                        <label className="flex min-h-11 min-w-0 items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-400">
                            <IconSearch className="h-4 w-4" />
                            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search agents" className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500" />
                        </label>
                        <div className="mt-3 flex flex-wrap gap-2">
                            {["all", "online", "degraded", "offline"].map((item) => (
                                <button key={item} type="button" onClick={() => setStatus(item)} className={cn("inline-flex min-h-9 items-center rounded-full border px-3.5 text-xs font-medium capitalize lg:min-h-8 lg:px-2.5 transition-colors", status === item ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100" : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100")}>
                                    {item}
                                </button>
                            ))}
                        </div>
                        <div className="mt-4 space-y-2">
                            {filteredAgents.map((agent) => (
                                <button key={agent.id} type="button" onClick={() => { setSelectedId(agent.id); setMobileView("detail"); window.scrollTo({ top: 0 }); document.querySelector("main")?.scrollTo({ top: 0 }); }} className={cn("flex min-w-0 w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors", selectedAgent?.id === agent.id ? "border-cyan-400/40 bg-cyan-400/10" : "border-zinc-800 bg-zinc-950/60 hover:border-zinc-700")}>
                                    <AgentAvatar agent={agent} size="sm" />
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2 truncate font-medium text-zinc-100">
                                            {agent.name}
                                            {(agent.deadLetterCount > 0 || agent.failedCount > 0) && (
                                                <span className="shrink-0 rounded-full bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300" title={`${agent.deadLetterCount} dead-lettered, ${agent.failedCount} failed`}>
                                                    {agent.deadLetterCount + agent.failedCount}
                                                </span>
                                            )}
                                            <BridgeBadge runtime={activity[agent.id]?.runtime} compact />
                                        </span>
                                        <AgentSubtitle agent={agent} now={activity[agent.id]} />
                                    </span>
                                    <LiveStatusDot agent={agent} now={activity[agent.id]} />
                                </button>
                            ))}
                            {filteredAgents.length === 0 ? <div className="rounded-xl border border-dashed border-zinc-800 p-6 text-center text-sm text-zinc-500">No agents match that search.</div> : null}
                        </div>
                    </aside>

                    {selectedAgent ? (
                        <div className={cn("min-w-0 space-y-4", mobileView === "list" ? "hidden lg:block" : "")}>
                            <button type="button" onClick={() => setMobileView("list")} className="lg:hidden inline-flex min-h-11 items-center gap-1.5 text-sm text-zinc-300 hover:text-zinc-100">
                                <IconArrowLeft className="h-4 w-4" />
                                All agents
                            </button>
                            <AgentNowCard now={activity[selectedAgent.id]} />
                            <AgentDetailPanel agentId={selectedAgent.id} agentName={selectedAgent.name} runtime={activity[selectedAgent.id]?.runtime ?? null} />
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

function AgentSubtitle({ agent, now }: { agent: AgentDirectoryItem; now: AgentNow | undefined }) {
    if (now && (now.state === "working" || now.state === "typing")) {
        const text = now.activity || now.task?.title || "";
        return (
            <span className="block truncate text-xs text-cyan-300">
                {now.run ? <RunElapsed startedAt={now.run.startedAt} /> : null}
                {now.run && text ? " · " : null}
                {text || (now.run ? null : "Active")}
            </span>
        );
    }
    return <span className="block truncate text-xs text-zinc-500">{agent.role}{agent.tasksCompleted > 0 ? ` · ${agent.tasksCompleted} done` : ""}</span>;
}

/** Elapsed time of an open run, ticking every second from its own clock. */
function RunElapsed({ startedAt }: { startedAt: string }) {
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);
    return <>{formatDuration(nowMs - Date.parse(startedAt))}</>;
}

function LiveStatusDot({ agent, now }: { agent: AgentDirectoryItem; now: AgentNow | undefined }) {
    let color: string;
    if (now) {
        if (now.state === "working" || now.state === "typing") color = "bg-cyan-400 animate-pulse";
        else if (agent.status === "degraded") color = "bg-amber-500";
        else if (now.state === "idle") color = "bg-emerald-500";
        else color = "bg-zinc-600";
    } else {
        color = {
            online: "bg-emerald-500",
            degraded: "bg-amber-500",
            offline: "bg-zinc-600",
        }[agent.status] || "bg-zinc-600";
    }
    return <span className={cn("h-2 w-2 rounded-full", color)} />;
}

function AgentAvatar({ agent, size = "lg" }: { agent: AgentDirectoryItem; size?: "sm" | "lg" }) {
    return (
        <div className={cn("shrink-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900", size === "sm" ? "h-10 w-10" : "h-14 w-14")}>
            <img
                src={agentAvatarSrc({ id: agent.id || agent.name, avatarUrl: agent.avatarUrl })}
                className="h-full w-full object-cover"
                alt=""
            />
        </div>
    );
}
