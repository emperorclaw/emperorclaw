"use client";

import { useState, useMemo } from "react";
import { Users, Search } from "lucide-react";
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
    initialTeamHasMore = false,
}: {
    agents: Agent[];
    directThreads: DirectThreadSummary[];
    initialTeamMessages?: TeamMessage[];
    initialTeamHasMore?: boolean;
}) {
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");

    const filteredThreads = useMemo(() => {
        return directThreads.filter((thread) =>
            thread.agentName.toLowerCase().includes(searchQuery.toLowerCase())
        );
    }, [directThreads, searchQuery]);

    const activeAgent = useMemo(() => {
        return agents.find(a => a.id === selectedAgentId);
    }, [agents, selectedAgentId]);

    return (
        <div className="flex-1 flex overflow-hidden">
            {/* Sidebar */}
            <div className="w-80 border-r border-zinc-800 flex flex-col bg-zinc-950/40">
                <div className="p-4 border-b border-zinc-800">
                    <div className="relative">
                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Filter agents..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-9 pr-4 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <div className="p-2 space-y-1">
                        {/* Team Channel */}
                        <button
                            onClick={() => setSelectedAgentId(null)}
                            className={cn(
                                "w-full text-left p-3 rounded-xl flex items-center gap-3 transition-all group",
                                selectedAgentId === null
                                    ? "bg-indigo-600/10 border border-indigo-500/20 shadow-sm"
                                    : "hover:bg-zinc-900 border border-transparent"
                            )}
                        >
                            <div className={cn(
                                "w-10 h-10 rounded-xl flex items-center justify-center border transition-colors",
                                selectedAgentId === null
                                    ? "bg-indigo-500/20 border-indigo-400/30 text-indigo-400"
                                    : "bg-zinc-800 border-zinc-700 text-zinc-500 group-hover:text-zinc-300"
                            )}>
                                <Users className="w-5 h-5" />
                            </div>
                            <div className="flex flex-col">
                                <span className={cn(
                                    "text-sm font-semibold tracking-tight",
                                    selectedAgentId === null ? "text-indigo-100" : "text-zinc-300"
                                )}>
                                    Team Channel
                                </span>
                                <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Everyone</span>
                            </div>
                        </button>

                        <div className="mt-6 px-3 mb-2 flex items-center text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-600">
                            Direct Messages
                        </div>

                        {filteredThreads.map((thread) => (
                            <button
                                key={thread.agentId}
                                onClick={() => setSelectedAgentId(thread.agentId)}
                                className={cn(
                                    "w-full text-left p-3 rounded-xl flex items-start gap-3 transition-all group",
                                    selectedAgentId === thread.agentId
                                        ? "bg-indigo-600/10 border border-indigo-500/20 shadow-sm"
                                        : "hover:bg-zinc-900 border border-transparent"
                                )}
                            >
                                <div className="w-10 h-10 rounded-xl overflow-hidden border border-zinc-800 relative shadow-inner shrink-0">
                                    <img
                                        src={thread.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(thread.agentId)}`}
                                        className="w-full h-full object-cover"
                                        alt=""
                                    />
                                    <div className={cn(
                                        "absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-zinc-950 shadow-sm",
                                        thread.status === "online" ? "bg-emerald-500" : "bg-zinc-700"
                                    )} />
                                </div>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-start justify-between gap-2">
                                        <div className="min-w-0">
                                            <span className={cn(
                                                "block text-sm font-semibold tracking-tight truncate",
                                                selectedAgentId === thread.agentId ? "text-indigo-100" : "text-zinc-300"
                                            )}>
                                                {thread.agentName}
                                            </span>
                                            <span className="block text-[10px] font-medium text-zinc-500 truncate">
                                                {thread.agentRole || "Operator"}
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-end gap-1 shrink-0">
                                            {thread.unreadCount > 0 && (
                                                <span className="min-w-5 rounded-full bg-indigo-500 px-1.5 py-0.5 text-center text-[10px] font-bold text-white shadow-sm">
                                                    {thread.unreadCount}
                                                </span>
                                            )}
                                            <span className="text-[10px] text-zinc-600">
                                                {formatRelativeMessageTime(thread.lastMessageAt)}
                                            </span>
                                        </div>
                                    </div>
                                    <div className="mt-2 text-xs leading-relaxed text-zinc-500 truncate">
                                        {thread.lastMessageText || "No direct conversation yet."}
                                    </div>
                                </div>
                            </button>
                        ))}

                        {filteredThreads.length === 0 && (
                            <div className="p-8 text-center bg-zinc-900/40 rounded-xl border border-dashed border-zinc-800 mt-4">
                                <div className="text-sm text-zinc-500">No agents found.</div>
                            </div>
                        )}
                    </div>
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
                                <AgentTeamChat
                                    initialMessages={initialTeamMessages}
                                    initialHasMore={initialTeamHasMore}
                                    agents={agents}
                                    sendable={true}
                                />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="h-full flex flex-col flex-1 overflow-hidden">
                        <AgentDirectChat agentId={selectedAgentId} agentName={activeAgent?.name || "Agent"} hideHeader={true} />
                    </div>
                )}
            </div>
        </div>
    );
}
