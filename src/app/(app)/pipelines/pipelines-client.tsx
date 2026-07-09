"use client";

// Pipelines registry client — renders system-generated mermaid diagrams.
import { useEffect, useRef, useState, useCallback } from "react";
import Script from "next/script";
import { Bot, ChevronDown, ChevronRight, Clock, FileText, GitBranch, Pause, Play, Repeat, Trash2, Zap } from "lucide-react";

type PipelineRow = {
    id: string;
    name: string;
    purpose: string | null;
    docMarkdown: string | null;
    trigger: string;
    triggerConfig: Record<string, unknown> | null;
    stepsJson: unknown;
    diagramMermaid: string | null;
    contextQuery: string | null;
    contextResourceIds: string[] | null;
    contextTagFilters: string[] | null;
    contextMaxChars: number | null;
    runtimeRef: string | null;
    status: string;
    runCount: number;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    nextRunAt: string | null;
    ownerAgentId: string | null;
    projectId: string | null;
    customerId: string | null;
    updatedAt: string;
};

type RunRow = {
    id: string;
    pipelineId: string;
    status: string;
    summary: string | null;
    statsJson?: Record<string, unknown> | null;
    contextSourceIds?: string[] | null;
    contextSnapshot?: Record<string, unknown> | null;
    startedAt: string;
    endedAt: string | null;
};

declare global {
    interface Window {
        mermaid?: {
            initialize: (config: Record<string, unknown>) => void;
            render: (id: string, text: string) => Promise<{ svg: string }>;
        };
    }
}

const STATUS_STYLES: Record<string, string> = {
    active: "border-emerald-500/20 bg-emerald-500/10 text-emerald-300",
    draft: "border-zinc-500/20 bg-zinc-500/10 text-zinc-300",
    paused: "border-amber-500/20 bg-amber-500/10 text-amber-300",
    retired: "border-red-500/20 bg-red-500/10 text-red-300",
};

const RUN_STATUS_STYLES: Record<string, string> = {
    succeeded: "text-emerald-400",
    failed: "text-red-400",
    partial: "text-amber-400",
    running: "text-sky-400",
};

function MermaidDiagram({ code, mermaidReady }: { code: string; mermaidReady: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        async function render() {
            if (!mermaidReady || !window.mermaid || !ref.current) return;
            try {
                const { svg } = await window.mermaid.render(`mmd-${Math.random().toString(36).slice(2)}`, code);
                if (!cancelled && ref.current) {
                    ref.current.innerHTML = svg;
                    setError(null);
                }
            } catch {
                if (!cancelled) setError("Could not render diagram");
            }
        }
        render();
        return () => { cancelled = true; };
    }, [code, mermaidReady]);

    if (error) {
        return <pre className="text-xs text-zinc-500 bg-zinc-900/60 rounded-lg p-3 overflow-x-auto">{code}</pre>;
    }
    return <div ref={ref} className="overflow-x-auto [&_svg]:max-w-full" />;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function runEvidence(run: RunRow) {
    const stats = run.statsJson || {};
    return {
        contextSourceIds: stringArray(run.contextSourceIds).length > 0 ? stringArray(run.contextSourceIds) : stringArray(stats.contextSourceIds),
        artifactIds: stringArray(stats.artifactIds),
        taskIds: stringArray(stats.taskIds),
    };
}

export default function PipelinesClient({
    initialPipelines,
    initialRuns,
    agentsMap,
    projectsMap,
    customersMap,
}: {
    initialPipelines: PipelineRow[];
    initialRuns: RunRow[];
    agentsMap: Record<string, string>;
    projectsMap: Record<string, string>;
    customersMap: Record<string, string>;
}) {
    const [pipelines, setPipelines] = useState(initialPipelines);
    const [runs, setRuns] = useState(initialRuns);
    const [expanded, setExpanded] = useState<string | null>(null);
    const [mermaidReady, setMermaidReady] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

    const onMermaidLoad = useCallback(() => {
        window.mermaid?.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict" });
        setMermaidReady(true);
    }, []);

    useEffect(() => {
        const interval = setInterval(async () => {
            try {
                const res = await fetch("/api/pipelines");
                if (!res.ok) return;
                const data = await res.json();
                if (Array.isArray(data.pipelines)) setPipelines(data.pipelines);
                if (Array.isArray(data.runs)) setRuns(data.runs);
            } catch (error) {
                console.error("Error polling pipelines", error);
            }
        }, 15000);
        return () => clearInterval(interval);
    }, []);

    async function changeStatus(id: string, status: string) {
        setActionError(null);
        try {
            const res = await fetch(`/api/pipelines/${id}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status }),
            });
            const data = await res.json();
            if (!res.ok) {
                setActionError(data.error || "Update failed");
                return;
            }
            if (status === "retired") {
                setPipelines(prev => prev.filter(p => p.id !== id));
            } else {
                setPipelines(prev => prev.map(p => p.id === id ? { ...p, status } : p));
            }
        } catch {
            setActionError("Update failed");
        }
    }

    function scopeLabel(p: PipelineRow): string | null {
        if (p.projectId && projectsMap[p.projectId]) return projectsMap[p.projectId];
        if (p.customerId && customersMap[p.customerId]) return customersMap[p.customerId];
        return null;
    }

    function triggerText(p: PipelineRow): string {
        const cfg = p.triggerConfig || {};
        if (p.trigger === "cron" && typeof cfg.cron === "string") return cfg.cron;
        if (p.trigger === "event" && typeof cfg.event === "string") return `on ${cfg.event}`;
        return p.trigger;
    }

    return (
        <div className="max-w-6xl mx-auto space-y-6 animate-in fade-in duration-500">
            <Script
                src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"
                strategy="lazyOnload"
                onReady={onMermaidLoad}
            />

            <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-white flex items-center">
                    <GitBranch className="w-8 h-8 mr-3 text-indigo-400" /> Pipelines
                </h1>
                <p className="max-w-3xl text-sm font-medium leading-6 text-zinc-400">
                    Recurring work your agents run in their own runtimes. Agents build pipelines locally and register
                    them here; the diagram is generated by the system from the declared steps, and every run is reported back.
                    A pipeline cannot go active without a written purpose and explanation.
                </p>
            </div>

            {actionError && (
                <div className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-2 text-sm text-red-300">
                    {actionError}
                </div>
            )}

            {pipelines.length === 0 ? (
                <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 space-y-3">
                    <p className="text-zinc-300 font-medium flex items-center gap-2">
                        <Repeat className="w-4 h-4 text-zinc-500" /> No pipelines registered yet.
                    </p>
                    <p className="text-sm text-zinc-500">
                        Your agents register pipelines from their own runtime via MCP:
                    </p>
                    <pre className="text-xs text-zinc-400 bg-zinc-950 rounded-lg p-4 overflow-x-auto">{`POST /api/mcp/pipelines
{
  "name": "daily-lead-mining",
  "purpose": "Find and enrich new leads every morning before standup.",
  "docMarkdown": "## How it works\\n1. Scrapes sources...\\n2. Enriches and dedupes...",
  "trigger": "cron",
  "triggerConfig": { "cron": "0 6 * * *" },
  "steps": [
    { "name": "scrape sources", "agentRef": "lead-miner" },
    { "name": "enrich + dedupe", "agentRef": "lead-enricher" },
    { "name": "draft outreach", "agentRef": "copy-personalizer", "gate": true }
  ],
  "agentId": "lead-miner",
  "status": "active"
}`}</pre>
                </div>
            ) : (
                <div className="space-y-3">
                    {pipelines.map(p => {
                        const isOpen = expanded === p.id;
                        const pipelineRuns = runs.filter(r => r.pipelineId === p.id).slice(0, 10);
                        const scope = scopeLabel(p);
                        return (
                            <div key={p.id} className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
                                <button
                                    onClick={() => setExpanded(isOpen ? null : p.id)}
                                    className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-zinc-900/80 transition-colors"
                                >
                                    {isOpen ? <ChevronDown className="w-4 h-4 text-zinc-500 shrink-0" /> : <ChevronRight className="w-4 h-4 text-zinc-500 shrink-0" />}
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                            <span className="font-semibold text-zinc-100">{p.name}</span>
                                            <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${STATUS_STYLES[p.status] || STATUS_STYLES.draft}`}>
                                                {p.status}
                                            </span>
                                            {scope && (
                                                <span className="text-xs text-zinc-500 truncate">· {scope}</span>
                                            )}
                                        </div>
                                        {p.purpose && <p className="text-sm text-zinc-400 truncate mt-0.5">{p.purpose}</p>}
                                    </div>
                                    <div className="hidden sm:flex items-center gap-4 text-xs text-zinc-500 shrink-0">
                                        <span className="inline-flex items-center gap-1"><Repeat className="w-3.5 h-3.5" />{triggerText(p)}</span>
                                        {p.ownerAgentId && agentsMap[p.ownerAgentId] && (
                                            <span className="inline-flex items-center gap-1"><Bot className="w-3.5 h-3.5" />{agentsMap[p.ownerAgentId]}</span>
                                        )}
                                        <span className="inline-flex items-center gap-1">
                                            <Zap className="w-3.5 h-3.5" />{p.runCount} runs
                                            {p.lastRunStatus && (
                                                <span className={RUN_STATUS_STYLES[p.lastRunStatus] || "text-zinc-400"}>· {p.lastRunStatus}</span>
                                            )}
                                        </span>
                                    </div>
                                </button>

                                {isOpen && (
                                    <div className="border-t border-zinc-800 px-5 py-4 space-y-5">
                                        <div className="flex items-center gap-2">
                                            {p.status !== "active" && (
                                                <button onClick={() => changeStatus(p.id, "active")} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/20 transition-colors">
                                                    <Play className="w-3.5 h-3.5" /> Activate
                                                </button>
                                            )}
                                            {p.status === "active" && (
                                                <button onClick={() => changeStatus(p.id, "paused")} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors">
                                                    <Pause className="w-3.5 h-3.5" /> Pause
                                                </button>
                                            )}
                                            <button onClick={() => changeStatus(p.id, "retired")} className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-300 hover:bg-red-500/20 transition-colors">
                                                <Trash2 className="w-3.5 h-3.5" /> Retire
                                            </button>
                                            {p.runtimeRef && (
                                                <span className="ml-auto text-[11px] text-zinc-600 font-mono truncate">runtime: {p.runtimeRef}</span>
                                            )}
                                        </div>

                                        {p.diagramMermaid && (
                                            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-4">
                                                <MermaidDiagram code={p.diagramMermaid} mermaidReady={mermaidReady} />
                                            </div>
                                        )}

                                        <div className="rounded-lg border border-indigo-500/15 bg-indigo-500/[0.04] p-4 space-y-3">
                                            <h3 className="text-xs font-bold uppercase tracking-wider text-indigo-300 flex items-center gap-1.5">
                                                <GitBranch className="w-3.5 h-3.5" /> Context Pack
                                            </h3>
                                            <p className="text-sm text-zinc-400">
                                                Company Brain context the agent should retrieve before a run. The diagram is the contract; these sources ground the work.
                                            </p>
                                            <div className="grid gap-2 text-xs text-zinc-500 sm:grid-cols-2">
                                                <div>
                                                    <span className="font-semibold text-zinc-400">Query:</span>{" "}
                                                    {p.contextQuery || "Scope-based Company Brain context"}
                                                </div>
                                                <div>
                                                    <span className="font-semibold text-zinc-400">Budget:</span>{" "}
                                                    {p.contextMaxChars || 8000} chars
                                                </div>
                                                <div>
                                                    <span className="font-semibold text-zinc-400">Pinned sources:</span>{" "}
                                                    {stringArray(p.contextResourceIds).length || "None"}
                                                </div>
                                                <div>
                                                    <span className="font-semibold text-zinc-400">Tags:</span>{" "}
                                                    {stringArray(p.contextTagFilters).length > 0 ? stringArray(p.contextTagFilters).map((tag) => `#${tag}`).join(", ") : "None"}
                                                </div>
                                            </div>
                                        </div>

                                        {p.docMarkdown && (
                                            <div className="space-y-1.5">
                                                <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                                                    <FileText className="w-3.5 h-3.5" /> How it works
                                                </h3>
                                                <div className="text-sm text-zinc-300 whitespace-pre-wrap bg-zinc-950/40 rounded-lg p-4 border border-zinc-800/60">
                                                    {p.docMarkdown}
                                                </div>
                                            </div>
                                        )}

                                        <div className="space-y-1.5">
                                            <h3 className="text-xs font-bold uppercase tracking-wider text-zinc-500 flex items-center gap-1.5">
                                                <Clock className="w-3.5 h-3.5" /> Recent runs
                                            </h3>
                                            {pipelineRuns.length === 0 ? (
                                                <p className="text-sm text-zinc-600">No runs reported yet.</p>
                                            ) : (
                                                <ul className="divide-y divide-zinc-800/60 rounded-lg border border-zinc-800/60 bg-zinc-950/40">
                                                    {pipelineRuns.map(r => {
                                                        const evidence = runEvidence(r);
                                                        return (
                                                        <li key={r.id} className="space-y-1 px-4 py-2 text-sm">
                                                            <div className="flex items-center gap-3">
                                                                <span className={`font-medium ${RUN_STATUS_STYLES[r.status] || "text-zinc-400"}`}>{r.status}</span>
                                                                <span className="text-zinc-500 text-xs">{new Date(r.startedAt).toLocaleString()}</span>
                                                                {r.summary && <span className="text-zinc-400 truncate">{r.summary}</span>}
                                                            </div>
                                                            {(evidence.contextSourceIds.length > 0 || evidence.artifactIds.length > 0 || evidence.taskIds.length > 0) && (
                                                                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-zinc-600">
                                                                    {evidence.contextSourceIds.length > 0 && <span>Sources used: {evidence.contextSourceIds.length}</span>}
                                                                    {(evidence.artifactIds.length > 0 || evidence.taskIds.length > 0) && (
                                                                        <span>Evidence produced: {evidence.taskIds.length} tasks · {evidence.artifactIds.length} artifacts</span>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </li>
                                                    );})}
                                                </ul>
                                            )}
                                        </div>
                                    </div>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
