"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
    IconExternalLink,
    IconRobot,
    IconPlugConnected,
    IconClock,
    IconDeviceSdCard,
    IconFileText,
} from "@tabler/icons-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AgentDirectChat } from "@/components/agent-direct-chat";
import { AgentInstructionsTab } from "./agent-instructions-tab";
import { DeleteAgentDialog } from "./delete-agent-dialog";
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
        doctrineJson?: Record<string, string>;
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
                        <div className="mt-1.5 flex items-center gap-2 text-sm text-zinc-400">
                            <StatusDot status={agent.status} />
                            <span className="capitalize">{agent.status}</span>
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
