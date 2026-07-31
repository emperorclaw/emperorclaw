"use client";

import { useEffect, useMemo, useState } from "react";
import {
    IconArrowLeft,
    IconCheck,
    IconChevronDown,
    IconLayoutSidebarLeftCollapse,
    IconLayoutSidebarLeftExpand,
    IconMessages,
    IconSearch,
    IconUsers,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

const ACTIVE_CONVERSATION_KEY = "emperor-messages-active-conversation";
const FOCUS_MODE_KEY = "emperor-messages-focus-mode";
const TEAM_CONVERSATION = "team";

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
    teamThreadId,
}: {
    agents: Agent[];
    directThreads: DirectThreadSummary[];
    initialTeamMessages?: TeamMessage[];
    initialTeamHasMore?: boolean;
    teamThreadId: string;
}) {
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState("");
    const [mobileChatOpen, setMobileChatOpen] = useState(false);
    const [isFocused, setIsFocused] = useState(false);

    const filteredThreads = useMemo(() => {
        return directThreads.filter((thread) =>
            thread.agentName.toLowerCase().includes(searchQuery.toLowerCase())
        );
    }, [directThreads, searchQuery]);

    const activeAgent = useMemo(() => {
        return agents.find(a => a.id === selectedAgentId);
    }, [agents, selectedAgentId]);

    useEffect(() => {
        const savedConversation = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
        const savedFocusMode = localStorage.getItem(FOCUS_MODE_KEY) === "1";

        if (savedConversation === TEAM_CONVERSATION) {
            // eslint-disable-next-line react-hooks/set-state-in-effect
            setSelectedAgentId(null);
            setMobileChatOpen(true);
        } else if (savedConversation && agents.some((agent) => agent.id === savedConversation)) {
            setSelectedAgentId(savedConversation);
            setMobileChatOpen(true);
        } else if (savedConversation) {
            localStorage.setItem(ACTIVE_CONVERSATION_KEY, TEAM_CONVERSATION);
        }

        if (savedFocusMode) setIsFocused(true);
    }, [agents]);

    const openTeamChannel = () => {
        setSelectedAgentId(null);
        setMobileChatOpen(true);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, TEAM_CONVERSATION);
    };

    const openDirectThread = (agentId: string) => {
        setSelectedAgentId(agentId);
        setMobileChatOpen(true);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, agentId);
    };

    const toggleFocusMode = () => {
        setIsFocused((value) => {
            const nextValue = !value;
            localStorage.setItem(FOCUS_MODE_KEY, nextValue ? "1" : "0");
            return nextValue;
        });
    };

    const conversationTitle = activeAgent?.name || "Team Channel";
    const conversationDescription = activeAgent
        ? activeAgent.role || "Direct agent conversation"
        : "Everyone can see and reply";

    return (
        <div className="flex min-w-0 flex-1 overflow-hidden">
            {/* Sidebar */}
            <aside className={cn(
                "min-w-0 flex-1 flex-col border-zinc-800/80 bg-zinc-950/70 sm:flex-none sm:border-r",
                mobileChatOpen ? "hidden sm:flex" : "flex",
                isFocused ? "sm:hidden" : "sm:w-64 lg:w-72 xl:w-80"
            )}>
                <div className="flex h-16 items-center gap-3 border-b border-zinc-800/80 px-4 sm:hidden">
                    <div className="grid h-9 w-9 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
                        <IconMessages className="h-4 w-4" />
                    </div>
                    <div>
                        <h1 className="text-lg font-semibold tracking-tight text-zinc-100">Messages</h1>
                        <p className="text-[11px] text-zinc-500">Team and direct conversations</p>
                    </div>
                </div>
                <div className="border-b border-zinc-800/80 p-3 sm:p-4">
                    <div className="relative">
                        <IconSearch className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                        <input
                            type="text"
                            placeholder="Filter agents..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            aria-label="Filter conversations"
                            className="h-11 w-full rounded-xl border border-zinc-800 bg-zinc-950/80 py-2 pl-9 pr-4 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-2 focus:ring-cyan-400/70"
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto">
                    <div className="p-2 space-y-1">
                        {/* Team Channel */}
                        <button
                            onClick={openTeamChannel}
                            className={cn(
                                "group flex min-h-14 w-full items-center gap-3 rounded-xl p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70",
                                selectedAgentId === null
                                    ? "border border-cyan-400/30 bg-cyan-400/10"
                                    : "border border-transparent hover:bg-zinc-900/70"
                            )}
                        >
                            <div className={cn(
                                "w-10 h-10 rounded-xl flex items-center justify-center border transition-colors",
                                selectedAgentId === null
                                    ? "bg-cyan-400/15 border-cyan-400/35 text-cyan-300"
                                    : "bg-zinc-800 border-zinc-700 text-zinc-500 group-hover:text-zinc-300"
                            )}>
                                <IconUsers className="w-5 h-5" />
                            </div>
                            <div className="flex flex-col">
                                <span className={cn(
                                    "text-sm font-semibold tracking-tight",
                                    selectedAgentId === null ? "text-cyan-100" : "text-zinc-300"
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
                                onClick={() => openDirectThread(thread.agentId)}
                                className={cn(
                                    "group flex min-h-16 w-full items-start gap-3 rounded-xl p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70",
                                    selectedAgentId === thread.agentId
                                        ? "border border-cyan-400/30 bg-cyan-400/10"
                                        : "border border-transparent hover:bg-zinc-900/70"
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
                                                selectedAgentId === thread.agentId ? "text-cyan-100" : "text-zinc-300"
                                            )}>
                                                {thread.agentName}
                                            </span>
                                            <span className="block text-[10px] font-medium text-zinc-500 truncate">
                                                {thread.agentRole || "Operator"}
                                            </span>
                                        </div>
                                        <div className="flex flex-col items-end gap-1 shrink-0">
                                            {thread.unreadCount > 0 && (
                                                <span className="min-w-5 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">
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
                            <div className="mt-4 rounded-xl border border-dashed border-zinc-800 bg-zinc-950/70 p-8 text-center">
                                <div className="text-sm text-zinc-500">No agents found.</div>
                            </div>
                        )}
                    </div>
                </div>
            </aside>

            {/* Chat Content */}
            <section className={cn(
                "relative min-w-0 flex-1 flex-col overflow-hidden bg-zinc-950/60",
                mobileChatOpen ? "flex" : "hidden sm:flex"
            )}>
                <header className="flex h-16 shrink-0 items-center justify-between gap-3 border-b border-zinc-800/80 bg-zinc-950/70 px-3 sm:px-4">
                    <div className="flex min-w-0 items-center gap-1.5">
                        <button
                            type="button"
                            onClick={() => setMobileChatOpen(false)}
                            aria-label="Back to conversations"
                            className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 sm:hidden"
                        >
                            <IconArrowLeft className="h-5 w-5" />
                        </button>
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button
                                    type="button"
                                    aria-label={`Switch conversation. Current: ${conversationTitle}`}
                                    title="Switch conversation"
                                    className="group flex min-w-0 items-center gap-2.5 rounded-xl px-1.5 py-1 transition-colors hover:bg-zinc-800/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 sm:pr-2"
                                >
                                    {activeAgent ? (
                                        <div className="relative h-9 w-9 shrink-0 overflow-hidden rounded-xl border border-zinc-800">
                                            <img
                                                src={activeAgent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(activeAgent.id)}`}
                                                className="h-full w-full object-cover"
                                                alt=""
                                            />
                                        </div>
                                    ) : (
                                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
                                            <IconUsers className="h-4 w-4" />
                                        </div>
                                    )}
                                    <div className="min-w-0 text-left">
                                        <h2 className="truncate text-sm font-semibold text-zinc-100 sm:text-base">{conversationTitle}</h2>
                                        <p className="truncate text-[11px] text-zinc-500">{conversationDescription}</p>
                                    </div>
                                    <IconChevronDown className="h-4 w-4 shrink-0 text-zinc-600 transition-colors group-hover:text-zinc-400" />
                                </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent
                                align="start"
                                className="w-72 rounded-xl border-zinc-800 bg-zinc-950 p-1.5 text-zinc-200 shadow-2xl shadow-black/50"
                            >
                                <DropdownMenuLabel className="px-2.5 py-2 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-600">
                                    Switch conversation
                                </DropdownMenuLabel>
                                <DropdownMenuItem
                                    onSelect={openTeamChannel}
                                    className="min-h-12 cursor-pointer rounded-lg px-2.5 py-2 focus:bg-cyan-400/10 focus:text-zinc-100"
                                >
                                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-cyan-300">
                                        <IconUsers className="h-4 w-4" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="truncate text-sm font-medium">Team Channel</div>
                                        <div className="text-[10px] text-zinc-500">Everyone</div>
                                    </div>
                                    {selectedAgentId === null && <IconCheck className="h-4 w-4 text-cyan-400" />}
                                </DropdownMenuItem>
                                <DropdownMenuSeparator className="my-1.5 bg-zinc-800" />
                                <DropdownMenuLabel className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-600">
                                    Direct messages
                                </DropdownMenuLabel>
                                {directThreads.map((thread) => (
                                    <DropdownMenuItem
                                        key={thread.agentId}
                                        onSelect={() => openDirectThread(thread.agentId)}
                                        className="min-h-12 cursor-pointer rounded-lg px-2.5 py-2 focus:bg-cyan-400/10 focus:text-zinc-100"
                                    >
                                        <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-lg border border-zinc-800">
                                            <img
                                                src={thread.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(thread.agentId)}`}
                                                className="h-full w-full object-cover"
                                                alt=""
                                            />
                                        </div>
                                        <div className="min-w-0 flex-1">
                                            <div className="truncate text-sm font-medium">{thread.agentName}</div>
                                            <div className="truncate text-[10px] text-zinc-500">{thread.agentRole || "Operator"}</div>
                                        </div>
                                        {thread.unreadCount > 0 && (
                                            <span className="min-w-5 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">
                                                {thread.unreadCount}
                                            </span>
                                        )}
                                        {selectedAgentId === thread.agentId && <IconCheck className="h-4 w-4 text-cyan-400" />}
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    </div>
                    <button
                        type="button"
                        onClick={toggleFocusMode}
                        aria-label={isFocused ? "Show conversations" : "Focus on conversation"}
                        title={isFocused ? "Show conversations" : "Focus mode"}
                        className="hidden h-10 w-10 shrink-0 place-items-center rounded-xl border border-zinc-800 text-zinc-500 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70 sm:grid"
                    >
                        {isFocused ? <IconLayoutSidebarLeftExpand className="h-4 w-4" /> : <IconLayoutSidebarLeftCollapse className="h-4 w-4" />}
                    </button>
                </header>
                {selectedAgentId === null ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="relative min-h-0 flex-1 overflow-hidden">
                            <div className="h-full">
                                <AgentTeamChat
                                    initialMessages={initialTeamMessages}
                                    initialHasMore={initialTeamHasMore}
                                    agents={agents}
                                    sendable={true}
                                    teamThreadId={teamThreadId}
                                />
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        <AgentDirectChat key={selectedAgentId} agentId={selectedAgentId} agentName={activeAgent?.name || "Agent"} hideHeader={true} />
                    </div>
                )}
            </section>
        </div>
    );
}
