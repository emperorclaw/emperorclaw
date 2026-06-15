"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import { Users, ChevronDown, MessageSquare } from "lucide-react";
import { cn } from "@/lib/utils";
import { AgentDirectChat } from "./agent-direct-chat";
import { AgentTeamChat } from "./agent-team-chat";

type Agent = {
    id: string;
    name: string;
    role: string | null;
    avatarUrl: string | null;
    status: string;
};

type TeamMessage = {
    id: string;
    senderType: string;
    senderId?: string | null;
    fromUserId?: string | null;
    text: string;
    createdAt: string | Date;
};

type DirectThreadSummary = {
    agentId: string;
    threadId: string | null;
    agentName: string;
    agentRole: string | null;
    avatarUrl: string | null;
    status: string;
    unreadCount: number;
    lastMessageText: string | null;
    lastMessageAt: string | null;
};

function formatRelativeMessageTime(value: string | null) {
    if (!value) return "No messages yet";
    const timestamp = new Date(value).getTime();
    if (Number.isNaN(timestamp)) return "No messages yet";
    const diffMs = Date.now() - timestamp;
    const diffMinutes = Math.floor(diffMs / 60000);
    if (diffMinutes < 1) return "Just now";
    if (diffMinutes < 60) return `${diffMinutes}m ago`;
    const diffHours = Math.floor(diffMinutes / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(value).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function MessagingHub({
    agents,
    directThreads,
    initialTeamMessages = [],
}: {
    agents: Agent[];
    directThreads: DirectThreadSummary[];
    initialTeamMessages?: TeamMessage[];
}) {
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [dmOpen, setDmOpen] = useState(false);
    const [dmSearch, setDmSearch] = useState("");
    const dmRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (dmRef.current && !dmRef.current.contains(e.target as Node)) {
                setDmOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    const filteredThreads = useMemo(() => {
        return directThreads.filter((thread) =>
            thread.agentName.toLowerCase().includes(dmSearch.toLowerCase())
        );
    }, [directThreads, dmSearch]);

    const activeAgent = useMemo(() => {
        return agents.find(a => a.id === selectedAgentId);
    }, [agents, selectedAgentId]);

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Sidebar List */}
            <div className="w-64 border-r border-zinc-800 flex flex-col bg-zinc-950/40">
                {/* Team Channel */}
                <div className="p-3">
                    <button
                        onClick={() => setSelectedAgentId(null)}
                        className={cn(
                            "w-full text-left px-3 py-2.5 rounded-xl flex items-center gap-3 transition-all group",
                            selectedAgentId === null
                                ? "bg-indigo-600/10 border border-indigo-500/20"
                                : "hover:bg-zinc-900 border border-transparent"
                        )}
                    >
                        <div className={cn(
                            "w-8 h-8 rounded-lg flex items-center justify-center border transition-colors shrink-0",
                            selectedAgentId === null
                                ? "bg-indigo-500/20 border-indigo-400/30 text-indigo-400"
                                : "bg-zinc-800 border-zinc-700 text-zinc-500 group-hover:text-zinc-300"
                        )}>
                            <Users className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                            <span className={cn("block text-sm font-semibold tracking-tight truncate", selectedAgentId === null ? "text-indigo-100" : "text-zinc-300")}>
                                Team Channel
                            </span>
                            <span className="block text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Everyone</span>
                        </div>
                    </button>
                </div>

                <div className="px-3 pb-1">
                    <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-600 px-1 mb-2">Direct Messages</div>

                    {/* Agent dropdown */}
                    <div className="relative" ref={dmRef}>
                        <button
                            onClick={() => setDmOpen(v => !v)}
                            className={cn(
                                "w-full flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-all",
                                selectedAgentId
                                    ? "bg-indigo-600/10 border-indigo-500/20 text-indigo-100"
                                    : "bg-zinc-900 border-zinc-800 text-zinc-400 hover:border-zinc-700"
                            )}
                        >
                            {selectedAgentId && activeAgent ? (
                                <>
                                    <div className="relative shrink-0">
                                        <img
                                            src={activeAgent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(activeAgent.id)}`}
                                            className="w-5 h-5 rounded-full object-cover"
                                            alt=""
                                        />
                                        <div className={cn("absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-zinc-900", activeAgent.status === "online" ? "bg-emerald-500" : "bg-zinc-600")} />
                                    </div>
                                    <span className="flex-1 truncate font-medium">{activeAgent.name}</span>
                                </>
                            ) : (
                                <>
                                    <MessageSquare className="w-4 h-4 shrink-0" />
                                    <span className="flex-1 truncate">Select agent…</span>
                                </>
                            )}
                            <ChevronDown className={cn("w-3.5 h-3.5 shrink-0 transition-transform text-zinc-500", dmOpen && "rotate-180")} />
                        </button>

                        {dmOpen && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl z-20 overflow-hidden">
                                <div className="p-2 border-b border-zinc-800">
                                    <input
                                        autoFocus
                                        type="text"
                                        placeholder="Search…"
                                        value={dmSearch}
                                        onChange={e => setDmSearch(e.target.value)}
                                        className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                                    />
                                </div>
                                <div className="max-h-60 overflow-y-auto p-1">
                                    {filteredThreads.map(thread => (
                                        <button
                                            key={thread.agentId}
                                            onClick={() => { setSelectedAgentId(thread.agentId); setDmOpen(false); setDmSearch(""); }}
                                            className={cn(
                                                "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left transition-colors",
                                                selectedAgentId === thread.agentId ? "bg-indigo-600/15 text-indigo-100" : "hover:bg-zinc-800 text-zinc-300"
                                            )}
                                        >
                                            <div className="relative shrink-0">
                                                <img
                                                    src={thread.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(thread.agentId)}`}
                                                    className="w-7 h-7 rounded-full object-cover"
                                                    alt=""
                                                />
                                                <div className={cn("absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-zinc-900", thread.status === "online" ? "bg-emerald-500" : "bg-zinc-600")} />
                                            </div>
                                            <div className="min-w-0 flex-1">
                                                <div className="flex items-center justify-between gap-1">
                                                    <span className="text-xs font-semibold truncate">{thread.agentName}</span>
                                                    {thread.unreadCount > 0 && (
                                                        <span className="shrink-0 min-w-4 rounded-full bg-indigo-500 px-1 text-center text-[10px] font-bold text-white">{thread.unreadCount}</span>
                                                    )}
                                                </div>
                                                <span className="block text-[10px] text-zinc-500 truncate">{thread.lastMessageText || thread.agentRole || "No messages yet"}</span>
                                            </div>
                                        </button>
                                    ))}
                                    {filteredThreads.length === 0 && (
                                        <div className="py-4 text-center text-xs text-zinc-500">No agents found</div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>

                    {/* Selected agent preview */}
                    {selectedAgentId && activeAgent && (() => {
                        const thread = directThreads.find(t => t.agentId === selectedAgentId);
                        return thread?.lastMessageText ? (
                            <div className="mt-2 px-3 py-2 rounded-xl bg-zinc-900/60 border border-zinc-800/60">
                                <p className="text-xs text-zinc-500 line-clamp-2">{thread.lastMessageText}</p>
                                <p className="text-[10px] text-zinc-600 mt-1">{formatRelativeMessageTime(thread.lastMessageAt)}</p>
                            </div>
                        ) : null;
                    })()}
                </div>
            </div>

            {/* Chat Content */}
            <div className="flex-1 flex flex-col bg-zinc-950 relative overflow-hidden">
                {selectedAgentId === null ? (
                    <div className="h-full flex flex-col">
                        <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-900/30">
                            <div>
                                <h1 className="text-xl font-bold tracking-tight text-zinc-100 flex items-center gap-2">
                                    <Users className="w-5 h-5 text-indigo-400" />
                                    Team Channel
                                </h1>
                                <p className="text-xs text-zinc-500 mt-0.5 font-medium">Shared channel — everyone on the team sees and can reply here.</p>
                            </div>
                        </div>
                        <div className="flex-1 overflow-hidden relative">
                            <div className="h-full">
                                <AgentTeamChat initialMessages={initialTeamMessages} agents={agents} sendable={true} />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex flex-col">
                        {/* We are reusing AgentDirectChat component but wrapping it slightly for layout */}
                        <div className="h-full flex flex-col flex-1 overflow-hidden">
                            <AgentDirectChat agentId={selectedAgentId} agentName={activeAgent?.name || "Agent"} hideHeader={true} />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
