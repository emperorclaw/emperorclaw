"use client";

import { useEffect, useState, useRef } from "react";
import Link from "next/link";
import {
    IconExternalLink,
    IconRobot,
    IconPlugConnected,
    IconClock,
    IconDeviceSdCard,
    IconFileText,
    IconCopy,
    IconCircleCheck,
    IconPlayerPlay,
    IconLoader,
    IconAlertTriangle,
    IconPencil,
} from "@tabler/icons-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentDirectChat } from "@/components/agent-direct-chat";
import { AgentInstructionsTab } from "./agent-instructions-tab";
import { DeleteAgentDialog } from "./delete-agent-dialog";
import { getProvider, buildAgentSetupPrompt } from "@/lib/agent-providers";
import { getAgentTemplate } from "@/lib/agent-templates";
import { cn } from "@/lib/utils";

type AgentDetailData = {
    agent: {
        id: string;
        name: string;
        avatarUrl: string | null;
        role: string;
        status: string;
        memory: string | null;
        provider?: string;
        deploymentMode?: string;
        llmProvider?: string | null;
        lastSeenAt?: string;
        doctrineJson?: Record<string, string>;
        monthlyBudgetCents?: number;
        monthlyTokenUsage?: number;
        budgetStatus?: string;
    };
    latestSnapshot: { id: string; content: string; createdAt: string } | null;
    memoryEntries: Array<{
        id: string;
        kind: string;
        summary: string | null;
        content: string;
        createdAt: string;
    }>;
    sessions: Array<{
        id: string;
        status: string;
        startedAt: string;
        summary: string | null;
        openclawSessionId: string | null;
    }>;
    runs: Array<{
        id: string;
        kind: string;
        status: string;
        startedAt: string;
        summary: string | null;
    }>;
    threads: Array<{
        id: string;
        type: string;
        title: string | null;
        createdAt: string;
        lastMessage: string | null;
    }>;
};

export function AgentDetailPanel({ agentId, agentName }: { agentId: string; agentName: string }) {
    const [data, setData] = useState<AgentDetailData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);

        fetch(`/api/agents/${agentId}`)
            .then(r => {
                if (!r.ok) throw new Error(r.status === 404 ? "Agent not found" : "Failed to load");
                return r.json();
            })
            .then(d => {
                if (!cancelled) {
                    setData(d);
                    setLoading(false);
                }
            })
            .catch(e => {
                if (!cancelled) {
                    setError(e.message);
                    setLoading(false);
                }
            });

        return () => { cancelled = true; };
    }, [agentId]);

    // ALL hooks must be called before any conditional return
    const [editingProvider, setEditingProvider] = useState(false);
    const [editingDeployment, setEditingDeployment] = useState(false);
    const [editingLlm, setEditingLlm] = useState(false);
    const [saving, setSaving] = useState(false);
    const editingLlmProviderRef = useRef("");

    if (loading) {
        return (
            <main className="emperor-panel rounded-2xl p-6 flex items-center justify-center min-h-[400px]">
                <div className="flex flex-col items-center gap-3 text-zinc-500">
                    <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-cyan-400" />
                    <span className="text-sm">Loading agent details…</span>
                </div>
            </main>
        );
    }

    if (error || !data) {
        return (
            <main className="emperor-panel rounded-2xl p-6 flex items-center justify-center min-h-[400px]">
                <div className="text-center text-zinc-500">
                    <IconRobot className="mx-auto h-10 w-10 mb-3 text-zinc-600" />
                    <p className="text-sm">{error || "Could not load agent details."}</p>
                </div>
            </main>
        );
    }

    const { agent, latestSnapshot, memoryEntries, sessions, runs, threads } = data;
    const provider = getProvider(agent.provider || "mcp");

    const updateAgent = async (fields: Record<string, unknown>) => {
        setSaving(true);
        try {
            const res = await fetch(`/api/agents/${agent.id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(fields),
            });
            if (res.ok) {
                const updated = await res.json();
                // Merge updated fields into local state
                setData((prev) => prev ? { ...prev, agent: { ...prev.agent, ...updated.agent } } : prev);
            }
        } catch { /* ignore */ }
        setSaving(false);
    };

    return (
        <main className="emperor-panel rounded-2xl overflow-hidden">
            {/* Header */}
            <div className="flex flex-wrap items-start justify-between gap-3 p-4 sm:p-5 border-b border-zinc-800/80">
                <div className="flex items-center gap-3 sm:gap-4">
                    <div className="shrink-0 h-14 w-14 rounded-xl border border-zinc-800 bg-zinc-900 overflow-hidden">
                        <img
                            src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id)}`}
                            className="h-full w-full object-cover"
                            alt=""
                        />
                    </div>
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-xl sm:text-2xl font-semibold text-zinc-100">{agent.name}</h2>
                            <span className="rounded border border-zinc-800 bg-zinc-950 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                                {agent.role || "operator"}
                            </span>
                        </div>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
                            <StatusDot status={agent.status} />
                            <span className="capitalize">{agent.status}</span>
                            {agent.deploymentMode === "local" && (
                                <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 font-medium">🖥️ Local</span>
                            )}
                            {agent.deploymentMode === "remote" && agent.provider && agent.provider !== "mcp" && (
                                <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400 font-medium">🌐 Remote</span>
                            )}
                            {provider && (
                                <span className="rounded bg-zinc-800/50 px-1.5 py-0.5 text-[10px] text-zinc-400">
                                    {provider.id === "hermes" ? "👑" : provider.id === "openclaw" ? "🦀" : provider.id === "codex" ? "🧠" : "🔌"} {provider.name}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Link
                        href={`/agents/${agent.id}`}
                        className="rounded-full border border-zinc-700 bg-zinc-900/60 p-2 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600 transition-colors"
                        title="Open in full page"
                    >
                        <IconExternalLink className="h-4 w-4" />
                    </Link>
                    <DeleteAgentDialog agentId={agent.id} agentName={agent.name} />
                </div>
            </div>

            {/* Setup banner — only for offline agents that need configuration */}
            {agent.status === "offline" && (
                <>
                <SetupBanner
                    agentId={agent.id}
                    agentName={agent.name}
                    agentRole={agent.role}
                    agentStatus={agent.status}
                    providerId={agent.provider || "mcp"}
                    deploymentMode={(agent.deploymentMode as "local" | "remote") || "remote"}
                />
                {!agent.lastSeenAt && (
                    <div className="border-b border-rose-500/15 bg-rose-500/[0.04] px-4 py-2 text-[10px] text-rose-300/70">
                        ⚠️ This agent has never connected — no heartbeat received yet. The bridge must be running for the agent to appear online.
                        {agent.provider === "hermes" ? " See the setup guide below." : ""}
                    </div>
                )}
                </>
            )}

            {/* Operational status bar — for online/active agents */}
            {agent.status !== "offline" && (
                <div className="border-b border-emerald-500/10 bg-emerald-500/[0.03] px-4 sm:px-5 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-1.5 text-xs">
                    {/* Provider — editable */}
                    <span className="text-zinc-500 inline-flex items-center gap-1.5">
                        Provider:{" "}
                        {editingProvider ? (
                            <select
                                value={agent.provider || "mcp"}
                                disabled={saving}
                                onChange={(e) => {
                                    updateAgent({ provider: e.target.value });
                                    setEditingProvider(false);
                                }}
                                onBlur={() => setEditingProvider(false)}
                                className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-400"
                                autoFocus
                            >
                                <option value="mcp">🔌 Generic MCP</option>
                                <option value="hermes">👑 Hermes</option>
                                <option value="openclaw">🦀 OpenClaw</option>
                                <option value="codex">🧠 Codex</option>
                                <option value="claude">🧠 Claude</option>
                            </select>
                        ) : (
                            <>
                                <span className="text-zinc-300 font-medium">{provider?.id === "hermes" ? "👑" : provider?.id === "openclaw" ? "🦀" : provider?.id === "codex" ? "🧠" : "🔌"} {provider?.name || "Generic MCP"}</span>
                                <button type="button" onClick={() => setEditingProvider(true)} className="text-zinc-600 hover:text-zinc-400 transition-colors" title="Change provider">
                                    <IconPencil className="h-3 w-3" />
                                </button>
                            </>
                        )}
                    </span>
                    {/* Deployment mode — editable */}
                    <span className="text-zinc-500 inline-flex items-center gap-1.5">
                        Deployment:{" "}
                        {editingDeployment ? (
                            <select
                                value={agent.deploymentMode || "remote"}
                                disabled={saving}
                                onChange={(e) => {
                                    updateAgent({ deploymentMode: e.target.value });
                                    setEditingDeployment(false);
                                }}
                                onBlur={() => setEditingDeployment(false)}
                                className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-400"
                                autoFocus
                            >
                                <option value="remote">🌐 Remote</option>
                                <option value="local">🖥️ Local (This server)</option>
                            </select>
                        ) : (
                            <>
                                <span className="text-zinc-300 font-medium">{agent.deploymentMode === "local" ? "🖥️ Local" : "🌐 Remote"}</span>
                                <button type="button" onClick={() => setEditingDeployment(true)} className="text-zinc-600 hover:text-zinc-400 transition-colors" title="Change deployment">
                                    <IconPencil className="h-3 w-3" />
                                </button>
                            </>
                        )}
                    </span>
                    {/* LLM Provider — editable; keys live in the agent runtime, not here */}
                    <span className="text-zinc-500 inline-flex items-center gap-1.5">
                        LLM:{" "}
                        {editingLlm ? (
                            <span className="inline-flex items-center gap-1.5">
                                <select
                                    defaultValue={agent.llmProvider || ""}
                                    disabled={saving}
                                    onChange={(e) => { editingLlmProviderRef.current = e.target.value; }}
                                    className="h-6 rounded border border-zinc-700 bg-zinc-900 px-1.5 text-xs text-zinc-200 outline-none focus:border-cyan-400"
                                >
                                    <option value="">None</option>
                                    <option value="openai">OpenAI</option>
                                    <option value="anthropic">Anthropic</option>
                                    <option value="google">Google Gemini</option>
                                    <option value="openrouter">OpenRouter</option>
                                    <option value="grok">Grok</option>
                                    <option value="deepseek">DeepSeek</option>
                                </select>
                                <button
                                    type="button"
                                    disabled={saving}
                                    onClick={async () => {
                                        await updateAgent({ llmProvider: editingLlmProviderRef.current || "" });
                                        setEditingLlm(false);
                                    }}
                                    className="text-[10px] text-cyan-400 hover:text-cyan-300 font-medium disabled:opacity-50"
                                >
                                    Save
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setEditingLlm(false)}
                                    className="text-zinc-600 hover:text-zinc-400 text-[10px]"
                                >
                                    Cancel
                                </button>
                            </span>
                        ) : (
                            <>
                                <span className="text-zinc-300 font-medium">
                                    {agent.llmProvider ? agent.llmProvider.charAt(0).toUpperCase() + agent.llmProvider.slice(1) : "None"}
                                </span>
                                <button type="button" onClick={() => { editingLlmProviderRef.current = agent.llmProvider || ""; setEditingLlm(true); }} className="text-zinc-600 hover:text-zinc-400 transition-colors" title="Configure LLM provider">
                                    <IconPencil className="h-3 w-3" />
                                </button>
                                {agent.llmProvider && (
                                    <a href="/docs/v1.1/troubleshooting#5-agent-setup--llm-configuration" target="_blank" className="text-[9px] text-cyan-400 hover:text-cyan-300 underline underline-offset-2" title="API keys are configured in the agent runtime, not stored in EmperorClaw. Click for setup guide.">
                                        ⓘ setup guide
                                    </a>
                                )}
                            </>
                        )}
                    </span>
                    {agent.lastSeenAt && (
                        <span className="text-zinc-500">
                            Last seen: <span className="text-zinc-300 font-medium">{new Date(agent.lastSeenAt).toLocaleTimeString()}</span>
                        </span>
                    )}
                    {(agent.monthlyBudgetCents ?? 0) > 0 && (
                        <span className={cn(
                            "font-medium",
                            agent.budgetStatus === "paused" ? "text-rose-400" :
                            agent.budgetStatus === "warning" ? "text-amber-400" : "text-emerald-400"
                        )}>
                            Budget: ${((agent.monthlyTokenUsage ?? 0) / 1_000_000 * 1).toFixed(2)} / ${((agent.monthlyBudgetCents ?? 0) / 100).toFixed(0)}
                            {agent.budgetStatus === "paused" ? " ⏸️" : agent.budgetStatus === "warning" ? " ⚠️" : ""}
                        </span>
                    )}
                </div>
            )}

            {/* Tabs */}
            <Tabs defaultValue="memory" className="p-4 sm:p-5">
                <TabsList className="bg-zinc-900 border border-zinc-800">
                    <TabsTrigger value="memory">Memory</TabsTrigger>
                    <TabsTrigger value="instructions">Instructions</TabsTrigger>
                    <TabsTrigger value="chat">Direct Chat</TabsTrigger>
                    <TabsTrigger value="threads">Threads</TabsTrigger>
                    <TabsTrigger value="runs">Runs</TabsTrigger>
                </TabsList>

                <TabsContent value="memory" className="mt-4">
                    <div className="grid grid-cols-1 lg:grid-cols-[1.2fr_0.8fr] gap-4">
                        <section className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <IconDeviceSdCard className="w-4 h-4 text-cyan-400" />
                                <h3 className="text-sm font-medium text-zinc-200">Latest Snapshot</h3>
                            </div>
                            <div className="bg-zinc-950 border border-zinc-800 rounded-lg p-3 font-mono text-xs text-zinc-300 whitespace-pre-wrap min-h-[180px] max-h-[300px] overflow-y-auto">
                                {latestSnapshot?.content || agent.memory || "No snapshot recorded yet."}
                            </div>
                        </section>

                        <section className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
                            <div className="flex items-center gap-2 mb-3">
                                <IconFileText className="w-4 h-4 text-cyan-400" />
                                <h3 className="text-sm font-medium text-zinc-200">Memory Timeline</h3>
                            </div>
                            <div className="space-y-2 max-h-[340px] overflow-y-auto pr-1">
                                {memoryEntries.length === 0 ? (
                                    <EmptyState text="No append-only memory entries yet." />
                                ) : memoryEntries.map(entry => (
                                    <div key={entry.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                        <div className="flex items-center justify-between gap-2 mb-1">
                                            <span className="text-[10px] uppercase tracking-wider font-bold text-cyan-400">{entry.kind}</span>
                                            <span className="text-[10px] text-zinc-600">{new Date(entry.createdAt).toLocaleString()}</span>
                                        </div>
                                        {entry.summary && <div className="text-xs text-zinc-200 mb-1">{entry.summary}</div>}
                                        <div className="text-[11px] text-zinc-400 whitespace-pre-wrap line-clamp-4">{entry.content}</div>
                                    </div>
                                ))}
                            </div>
                        </section>
                    </div>
                </TabsContent>

                <TabsContent value="instructions" className="mt-4">
                    <AgentInstructionsTab
                        agentId={agent.id}
                        initialDoctrine={agent.doctrineJson || {}}
                    />
                </TabsContent>

                <TabsContent value="chat" className="mt-4">
                    <AgentDirectChat agentId={agent.id} agentName={agent.name} />
                </TabsContent>

                <TabsContent value="threads" className="mt-4">
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-3">
                            <IconPlugConnected className="w-4 h-4 text-cyan-400" />
                            <h3 className="text-sm font-medium text-zinc-200">Message Threads</h3>
                        </div>
                        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                            {threads.length === 0 ? (
                                <EmptyState text="No threads recorded for this agent yet." />
                            ) : threads.map(thread => (
                                <div key={thread.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                    <div className="flex items-center justify-between gap-2 mb-1">
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] uppercase tracking-wider font-bold text-cyan-400">{thread.type}</span>
                                            <span className="text-xs text-zinc-200">{thread.title || "Untitled thread"}</span>
                                        </div>
                                        <span className="text-[10px] text-zinc-600">{new Date(thread.createdAt).toLocaleString()}</span>
                                    </div>
                                    <div className="text-[11px] text-zinc-500 line-clamp-2">
                                        {thread.lastMessage || "No messages yet."}
                                    </div>
                                </div>
                            ))}
                        </div>
                    </div>
                </TabsContent>

                <TabsContent value="runs" className="mt-4">
                    <div className="bg-zinc-900/50 border border-zinc-800 rounded-xl p-4">
                        <div className="flex items-center gap-2 mb-3">
                            <IconRobot className="w-4 h-4 text-cyan-400" />
                            <h3 className="text-sm font-medium text-zinc-200">Execution Runs</h3>
                        </div>
                        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
                            {runs.length === 0 && sessions.length === 0 ? (
                                <EmptyState text="No execution runs or sessions recorded yet." />
                            ) : (
                                <>
                                    {sessions.map(session => (
                                        <div key={session.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                            <div className="flex items-center justify-between gap-2 mb-1">
                                                <span className="text-[10px] uppercase tracking-wider font-bold text-emerald-400">session</span>
                                                <span className="text-[10px] text-zinc-600">{new Date(session.startedAt).toLocaleString()}</span>
                                            </div>
                                            <div className="text-xs text-zinc-200">{session.status}</div>
                                            {session.openclawSessionId && (
                                                <div className="text-[10px] text-zinc-500 mt-1 font-mono truncate">{session.openclawSessionId}</div>
                                            )}
                                            {session.summary && <div className="text-[11px] text-zinc-400 mt-1 line-clamp-2">{session.summary}</div>}
                                        </div>
                                    ))}
                                    {runs.map(run => (
                                        <div key={run.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                                            <div className="flex items-center justify-between gap-2 mb-1">
                                                <span className="text-[10px] uppercase tracking-wider font-bold text-cyan-400">{run.kind}</span>
                                                <span className="text-[10px] text-zinc-600">{new Date(run.startedAt).toLocaleString()}</span>
                                            </div>
                                            <div className="text-xs text-zinc-200">{run.status}</div>
                                            {run.summary && <div className="text-[11px] text-zinc-400 mt-1 line-clamp-2">{run.summary}</div>}
                                        </div>
                                    ))}
                                </>
                            )}
                        </div>
                    </div>
                </TabsContent>
            </Tabs>
        </main>
    );
}

function StatusDot({ status }: { status: string }) {
    const color = {
        online: "bg-emerald-500",
        degraded: "bg-amber-500",
        offline: "bg-zinc-600",
    }[status] || "bg-zinc-600";
    return <span className={cn("h-2 w-2 rounded-full shrink-0", color)} />;
}

function EmptyState({ text }: { text: string }) {
    return (
        <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center">
            <p className="text-xs text-zinc-500">{text}</p>
        </div>
    );
}

function SetupBanner({ agentId, agentName, agentRole, agentStatus, providerId, deploymentMode }: { agentId: string; agentName: string; agentRole: string; agentStatus: string; providerId: string; deploymentMode: "local" | "remote" }) {
    const [copied, setCopied] = useState(false);
    const [copiedCmd, setCopiedCmd] = useState(false);
    const [setupRunning, setSetupRunning] = useState(false);
    const [setupResult, setSetupResult] = useState<{ success: boolean; message: string; outputs?: { command: string; stdout: string; stderr: string; exitCode: number | null }[] } | null>(null);
    const provider = getProvider(providerId) || getProvider("mcp")!;
    const isLocal = deploymentMode === "local";
    const isOnline = agentStatus === "online";
    const template = getAgentTemplate(
        Object.entries({
            "SEO Specialist": "seo",
            "Technical Developer": "developer",
            "QA & Testing Agent": "qa",
            "Growth & Lead Gen": "growth",
            "Content & Copywriter": "content",
            "Accountant & Bookkeeper": "accountant",
            "Customer Support": "support",
            "Data Analyst": "analyst",
        }).find(([title]) => agentRole?.includes(title))?.[1] || ""
    );

    const setupPrompt = template
        ? buildAgentSetupPrompt(template, provider, typeof window !== "undefined" ? window.location.origin : "http://localhost:3000")
        : `Set up a ${agentRole} agent using ${provider.name}. See the Instructions tab for doctrine files.`;

    const handleCopy = async () => {
        await navigator.clipboard.writeText(setupPrompt);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className={cn(
            "border-b p-4 sm:p-5 space-y-4",
            isLocal
                ? "border-emerald-500/20 bg-emerald-500/[0.06]"
                : "border-amber-500/20 bg-amber-500/[0.06]"
        )}>
            <div className="flex items-start gap-3">
                <span className="text-xl mt-0.5">{isLocal ? "🖥️" : "🚀"}</span>
                <div className="flex-1">
                    <h3 className={cn("text-sm font-semibold", isLocal ? "text-emerald-100" : "text-amber-100")}>
                        {isOnline
                            ? `${agentName} is running`
                            : isLocal ? "Agent created — connect on this server" : "Agent created — now connect it"
                        }
                    </h3>
                    <p className={cn("text-xs mt-1", isLocal ? "text-emerald-100/70" : "text-amber-100/70")}>
                        {isOnline
                            ? `${agentName} is online and processing tasks on ${provider.name}. Bridge is active.`
                            : agentName + " is configured as a " + agentRole + " running on " + provider.name + " " +
                                (isLocal
                                    ? "on this machine. Run the commands below directly — no SSH needed."
                                    : "on a remote machine. Copy the prompt below into Claude, ChatGPT, or Codex and it will walk you through the setup."
                                )
                        }
                    </p>
                </div>
            </div>

            {/* Setup guide — Hermes-specific */}
            {providerId === "hermes" && !isOnline && (
                <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4 space-y-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">🔧 What you need to do</span>
                    <ol className="space-y-1.5 text-[11px] text-amber-100/80 list-decimal list-inside">
                        <li>Install Hermes: <code className="text-amber-200 bg-amber-500/10 px-1 rounded">pip install hermes-agent</code></li>
                        <li>Set your LLM key in <code className="text-amber-200 bg-amber-500/10 px-1 rounded">~/.hermes/.env</code></li>
                        <li>Set up the bridge env at <code className="text-amber-200 bg-amber-500/10 px-1 rounded">~/.hermes/emperor-bridge/{agentName}/.env</code></li>
                        <li>Run the bridge: <code className="text-amber-200 bg-amber-500/10 px-1 rounded">python emperor_hermes_bridge.py</code></li>
                    </ol>
                    <p className="text-[10px] text-amber-100/60 mt-2">
                        The bridge script is in <code className="text-amber-200/60 bg-amber-500/5 px-1 rounded">integrations/hermes/emperor-claw/bridge/</code>.
                        Once running, this agent will appear <span className="text-emerald-300">online</span> here automatically.
                    </p>
                </div>
            )}

            {/* Direct install commands — for providers that have them */}
            {provider.installCommands.length > 0 && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] overflow-hidden">
                    <div className="flex items-center justify-between px-4 py-2 bg-emerald-500/10 border-b border-emerald-500/20">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                            ⚡ Quick Connect Commands
                        </span>
                        <button
                            type="button"
                            onClick={async () => {
                                const cmds = provider.installCommands.map(c => c.replace(/\{name\}/g, agentName).replace(/\{role\}/g, agentRole)).join("\n");
                                await navigator.clipboard.writeText(cmds);
                                setCopiedCmd(true);
                                setTimeout(() => setCopiedCmd(false), 2000);
                            }}
                            className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors"
                        >
                            {copiedCmd ? <IconCircleCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                            {copiedCmd ? "Copied!" : "Copy all"}
                        </button>
                    </div>
                    <div className="p-3 space-y-2">
                        {provider.installCommands.map((cmd, i) => (
                            <div key={i} className="flex items-start gap-2">
                                <span className="text-[10px] text-emerald-500 mt-0.5 shrink-0">{i + 1}.</span>
                                <code className="text-[11px] text-emerald-100/80 font-mono break-all">
                                    {cmd.replace(/\{name\}/g, agentName).replace(/\{role\}/g, agentRole).replace(/\{token\}/g, "YOUR_TOKEN")}
                                </code>
                            </div>
                        ))}
                        <p className="text-[10px] text-emerald-100/50 mt-1">
                            {isLocal
                                ? `Assumes ${provider.name} CLI is installed on this server. Run these commands in a terminal.`
                                : `Assumes ${provider.name} CLI is already installed. Run these on the agent's machine (or this server). Then paste the LLM prompt for doctrine + systemd configuration.`
                            }
                        </p>
                    </div>
                </div>
            )}

            {/* Setup prompt — always show for remote, optional for local */}
            <div className={cn(
                "rounded-xl border bg-black/30 overflow-hidden",
                isLocal
                    ? "border-emerald-500/20"
                    : "border-amber-500/20"
            )}>
                <div className={cn(
                    "flex items-center justify-between px-4 py-2 border-b",
                    isLocal
                        ? "bg-emerald-500/10 border-emerald-500/20"
                        : "bg-amber-500/10 border-amber-500/20"
                )}>
                    <span className={cn("text-[10px] font-bold uppercase tracking-wider", isLocal ? "text-emerald-200" : "text-amber-200")}>
                        {isLocal ? "📋 LLM Setup Prompt (optional)" : "🤖 LLM Setup Prompt"}
                    </span>
                    <button
                        type="button"
                        onClick={handleCopy}
                        className={cn(
                            "flex items-center gap-1.5 rounded-lg border px-3 py-1 text-[11px] font-medium transition-colors",
                            isLocal
                                ? "border-emerald-500/30 text-emerald-200 hover:bg-emerald-500/15"
                                : "border-amber-500/30 text-amber-200 hover:bg-amber-500/15"
                        )}
                    >
                        {copied ? <IconCircleCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                        {copied ? "Copied!" : "Copy prompt"}
                    </button>
                </div>
                <pre className={cn("p-4 text-[11px] whitespace-pre-wrap max-h-[200px] overflow-y-auto font-mono leading-relaxed select-all", isLocal ? "text-emerald-100/80" : "text-amber-100/80")}>
                    {setupPrompt}
                </pre>
            </div>

            {/* Bridge config generator — Hermes only */}
            {providerId === "hermes" && (
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.04] p-3 space-y-2">
                    <div className="flex items-center justify-between">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-emerald-200">
                            🔌 Bridge Configuration
                        </span>
                        <button
                            type="button"
                            onClick={async () => {
                                const baseUrl = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
                                const env = [
                                    `EMPEROR_CLAW_API_URL="${baseUrl}"`,
                                    `EMPEROR_CLAW_API_TOKEN="<generate in Settings > Access Tokens>"`,
                                    `EMPEROR_CLAW_AGENT_NAME="${agentName}"`,
                                    `EMPEROR_CLAW_AGENT_ID="${agentId}"`,
                                    `EMPEROR_CLAW_AGENT_ROLE="${agentRole}"`,
                                    `HERMES_TOOLSETS="emperor-claw,web,terminal,code_execution"`,
                                    `HERMES_BIN="hermes"`,
                                    `EMPEROR_CLAW_HERMES_POLL_SECONDS="5"`,
                                    `DEEPSEEK_API_KEY="<your-api-key>"`,
                                ].join("\n");
                                await navigator.clipboard.writeText(env);
                                setCopiedCmd(true);
                                setTimeout(() => setCopiedCmd(false), 2000);
                            }}
                            className="flex items-center gap-1.5 rounded-lg border border-emerald-500/30 px-3 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/15 transition-colors"
                        >
                            {copiedCmd ? <IconCircleCheck className="h-3 w-3" /> : <IconCopy className="h-3 w-3" />}
                            {copiedCmd ? "Copied!" : "Copy .env"}
                        </button>
                    </div>
                    <p className="text-[10px] text-emerald-100/60">
                        Save this as <code className="text-emerald-200/80 bg-emerald-500/5 px-1 rounded">~/.hermes/emperor-bridge/{agentName}/.env</code>.
                        Generate an API token in <strong>Settings → Access Tokens</strong>, replace the placeholders, and start the bridge.
                    </p>
                </div>
            )}

            {/* Checklist */}
            <div className="space-y-2">
                <span className={cn("text-[10px] font-bold uppercase tracking-wider", isLocal ? "text-emerald-300" : "text-amber-300")}>
                    Post-Connect Checklist
                </span>
                <div className="grid gap-1.5">
                    {provider.postInstallChecklist.map((step, i) => (
                        <div key={i} className={cn("flex items-center gap-2 text-[11px]", isLocal ? "text-emerald-100/70" : "text-amber-100/70")}>
                            <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]", isLocal ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300")}>
                                {i + 1}
                            </span>
                            <span>{step.replace(/\{name\}/g, agentName).replace(/\{role\}/g, agentRole).replace(/\{token\}/g, "your-token")}</span>
                        </div>
                    ))}
                    <div className={cn("flex items-center gap-2 text-[11px]", isLocal ? "text-emerald-100/70" : "text-amber-100/70")}>
                        <span className={cn("flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]", isLocal ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300")}>
                            ✓
                        </span>
                        <span>Check Emperor dashboard — {agentName} should appear as <strong>online</strong></span>
                    </div>
                </div>
            </div>
        </div>
    );
}
