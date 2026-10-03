"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    IconArrowLeft,
    IconCheck,
    IconChevronDown,
    IconLayoutSidebarLeftCollapse,
    IconLayoutSidebarLeftExpand,
    IconMessages,
    IconPlus,
    IconSearch,
    IconSettings,
    IconUsers,
    IconUsersGroup,
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
import { GroupDialog, type GroupDialogHuman } from "./group-dialog";
import { EVERYONE_MENTION } from "./mention-textarea";

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

export type GroupThreadSummary = {
    id: string;
    title: string;
    description: string | null;
    members: { kind: "agent" | "human"; id: string; name: string; role: string; avatarUrl?: string | null }[];
    unreadCount: number;
    lastMessageText: string | null;
    lastMessageAt: string | null;
};

const GROUP_PREFIX = "group:";

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
    teamUnreadCount = 0,
    groups = [],
    humans = [],
    currentUserId = null,
}: {
    agents: Agent[];
    directThreads: DirectThreadSummary[];
    initialTeamMessages?: TeamMessage[];
    initialTeamHasMore?: boolean;
    teamThreadId: string;
    teamUnreadCount?: number;
    groups?: GroupThreadSummary[];
    humans?: GroupDialogHuman[];
    currentUserId?: string | null;
}) {
    const router = useRouter();
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
    const [groupDialog, setGroupDialog] = useState<{ mode: "create" } | { mode: "edit"; groupId: string } | null>(null);
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

    const activeGroup = useMemo(() => groups.find((g) => g.id === selectedGroupId) ?? null, [groups, selectedGroupId]);
    const filteredGroups = useMemo(
        () => groups.filter((group) => group.title.toLowerCase().includes(searchQuery.toLowerCase())),
        [groups, searchQuery],
    );
    const groupAgents = useMemo(() => {
        if (!activeGroup) return [];
        const ids = new Set(activeGroup.members.filter((m) => m.kind === "agent").map((m) => m.id));
        return agents.filter((agent) => ids.has(agent.id));
    }, [activeGroup, agents]);

    // Restore the conversation once per page load. The (app) layout refreshes
    // server props every 15s, which hands this component new `agents`/`groups`
    // arrays; re-running the restore then would yank the user back to the
    // deep-linked conversation after they had moved on.
    const restoredRef = useRef(false);
    useEffect(() => {
        if (restoredRef.current) return;
        restoredRef.current = true;
        // `?agent=<id>` is a deep link (onboarding "Open direct chat", shared
        // links). It wins over the last-remembered conversation for this load.
        const requestedAgent = new URLSearchParams(window.location.search).get("agent");
        // `?group=<id>`: a notification or shared link opens that group.
        const requestedGroup = new URLSearchParams(window.location.search).get("group");
        const savedConversation = localStorage.getItem(ACTIVE_CONVERSATION_KEY);
        const savedFocusMode = localStorage.getItem(FOCUS_MODE_KEY) === "1";

        if (requestedGroup && groups.some((g) => g.id === requestedGroup)) {
            setSelectedGroupId(requestedGroup);
            setSelectedAgentId(null);
            setMobileChatOpen(true);
            localStorage.setItem(ACTIVE_CONVERSATION_KEY, `${GROUP_PREFIX}${requestedGroup}`);
        } else if (requestedAgent && agents.some((agent) => agent.id === requestedAgent)) {
            setSelectedAgentId(requestedAgent);
            setMobileChatOpen(true);
            localStorage.setItem(ACTIVE_CONVERSATION_KEY, requestedAgent);
        } else if (savedConversation?.startsWith(GROUP_PREFIX) && groups.some((g) => `${GROUP_PREFIX}${g.id}` === savedConversation)) {
            setSelectedGroupId(savedConversation.slice(GROUP_PREFIX.length));
            setSelectedAgentId(null);
            setMobileChatOpen(true);
        } else if (savedConversation === TEAM_CONVERSATION) {
            setSelectedAgentId(null);
            setMobileChatOpen(true);
        } else if (savedConversation && agents.some((agent) => agent.id === savedConversation)) {
            setSelectedAgentId(savedConversation);
            setMobileChatOpen(true);
        } else if (savedConversation) {
            localStorage.setItem(ACTIVE_CONVERSATION_KEY, TEAM_CONVERSATION);
        }

        if (savedFocusMode) setIsFocused(true);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [agents]);

    const openGroup = (groupId: string) => {
        setSelectedAgentId(null);
        setSelectedGroupId(groupId);
        setMobileChatOpen(true);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, `${GROUP_PREFIX}${groupId}`);
    };

    const openTeamChannel = () => {
        setSelectedGroupId(null);
        setSelectedAgentId(null);
        setMobileChatOpen(true);
        localStorage.setItem(ACTIVE_CONVERSATION_KEY, TEAM_CONVERSATION);
    };

    const openDirectThread = (agentId: string) => {
        setSelectedGroupId(null);
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

    const conversationTitle = activeGroup?.title || activeAgent?.name || "Team Channel";
    const conversationDescription = activeGroup
        ? activeGroup.description || `${groupAgents.length} agent${groupAgents.length === 1 ? "" : "s"} · @mention a member to get a reply`
        : activeAgent
            ? activeAgent.role || "Direct agent conversation"
            : "Everyone can see & reply. @mention an agent to get replies.";
    const teamSelected = selectedAgentId === null && selectedGroupId === null;
    const editingGroup = groupDialog?.mode === "edit" ? groups.find((g) => g.id === groupDialog.groupId) ?? null : null;

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
                                teamSelected
                                    ? "border border-cyan-400/30 bg-cyan-400/10"
                                    : "border border-transparent hover:bg-zinc-900/70"
                            )}
                        >
                            <div className={cn(
                                "w-10 h-10 rounded-xl flex items-center justify-center border transition-colors",
                                teamSelected
                                    ? "bg-cyan-400/15 border-cyan-400/35 text-cyan-300"
                                    : "bg-zinc-800 border-zinc-700 text-zinc-500 group-hover:text-zinc-300"
                            )}>
                                <IconUsers className="w-5 h-5" />
                            </div>
                            <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                                <div className="flex flex-col">
                                    <span className={cn(
                                        "text-sm font-semibold tracking-tight",
                                        teamSelected ? "text-cyan-100" : "text-zinc-300"
                                    )}>
                                        Team Channel
                                    </span>
                                    <span className="text-[10px] uppercase font-bold text-zinc-500 tracking-wider">Everyone</span>
                                </div>
                                {teamUnreadCount > 0 && (
                                    <span className="min-w-5 shrink-0 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">
                                        {teamUnreadCount}
                                    </span>
                                )}
                            </div>
                        </button>

                        <div className="mt-6 mb-1 flex items-center justify-between px-3 text-[10px] font-bold uppercase tracking-[0.1em] text-zinc-600">
                            Groups
                            <button
                                type="button"
                                onClick={() => setGroupDialog({ mode: "create" })}
                                aria-label="New group"
                                title="New group"
                                className="grid h-6 w-6 place-items-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                            >
                                <IconPlus className="h-3.5 w-3.5" />
                            </button>
                        </div>
                        {filteredGroups.map((group) => {
                            const agentCount = group.members.filter((m) => m.kind === "agent").length;
                            const selected = selectedGroupId === group.id;
                            return (
                                <button
                                    key={group.id}
                                    onClick={() => openGroup(group.id)}
                                    className={cn(
                                        "group flex min-h-14 w-full items-center gap-3 rounded-xl p-3 text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70",
                                        selected ? "border border-cyan-400/30 bg-cyan-400/10" : "border border-transparent hover:bg-zinc-900/70"
                                    )}
                                >
                                    <div className={cn(
                                        "grid h-10 w-10 shrink-0 place-items-center rounded-xl border transition-colors",
                                        selected ? "border-cyan-400/35 bg-cyan-400/15 text-cyan-300" : "border-zinc-700 bg-zinc-800 text-zinc-500 group-hover:text-zinc-300"
                                    )}>
                                        <IconUsersGroup className="h-5 w-5" />
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-center justify-between gap-2">
                                            <span className={cn("truncate text-sm font-semibold tracking-tight", selected ? "text-cyan-100" : "text-zinc-300")}>{group.title}</span>
                                            {group.unreadCount > 0 && (
                                                <span className="min-w-5 shrink-0 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">{group.unreadCount}</span>
                                            )}
                                        </div>
                                        <span className="block truncate text-[11px] text-zinc-500">
                                            {group.lastMessageText || `${agentCount} agent${agentCount === 1 ? "" : "s"} · ${formatRelativeMessageTime(group.lastMessageAt)}`}
                                        </span>
                                    </div>
                                </button>
                            );
                        })}
                        {groups.length === 0 && (
                            <button
                                type="button"
                                onClick={() => setGroupDialog({ mode: "create" })}
                                className="flex w-full items-center gap-2 rounded-xl border border-dashed border-zinc-800 px-3 py-2.5 text-left text-xs text-zinc-500 transition-colors hover:border-cyan-400/40 hover:text-cyan-200"
                            >
                                <IconPlus className="h-3.5 w-3.5" />
                                Create a group for a team, like your devs and tester
                            </button>
                        )}

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
                                    {activeGroup ? (
                                        <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-cyan-400/25 bg-cyan-400/10 text-cyan-300">
                                            <IconUsersGroup className="h-4 w-4" />
                                        </div>
                                    ) : activeAgent ? (
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
                                        <p className="text-[11px] text-zinc-500 line-clamp-1">{conversationDescription}</p>
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
                                    {teamUnreadCount > 0 && (
                                        <span className="min-w-5 shrink-0 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">
                                            {teamUnreadCount}
                                        </span>
                                    )}
                                    {teamSelected && <IconCheck className="h-4 w-4 text-cyan-400" />}
                                </DropdownMenuItem>
                                {groups.length > 0 && (
                                    <>
                                        <DropdownMenuSeparator className="my-1.5 bg-zinc-800" />
                                        <DropdownMenuLabel className="px-2.5 py-1.5 text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-600">
                                            Groups
                                        </DropdownMenuLabel>
                                        {groups.map((group) => (
                                            <DropdownMenuItem
                                                key={group.id}
                                                onSelect={() => openGroup(group.id)}
                                                className="min-h-12 cursor-pointer rounded-lg px-2.5 py-2 focus:bg-cyan-400/10 focus:text-zinc-100"
                                            >
                                                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400">
                                                    <IconUsersGroup className="h-4 w-4" />
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="truncate text-sm font-medium">{group.title}</div>
                                                    <div className="text-[10px] text-zinc-500">{group.members.filter((m) => m.kind === "agent").length} agents</div>
                                                </div>
                                                {group.unreadCount > 0 && (
                                                    <span className="min-w-5 rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold text-cyan-950">{group.unreadCount}</span>
                                                )}
                                                {selectedGroupId === group.id && <IconCheck className="h-4 w-4 text-cyan-400" />}
                                            </DropdownMenuItem>
                                        ))}
                                    </>
                                )}
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
                    {activeGroup && (
                        <button
                            type="button"
                            onClick={() => setGroupDialog({ mode: "edit", groupId: activeGroup.id })}
                            aria-label="Manage group members"
                            title="Members & settings"
                            className="ml-auto flex h-10 shrink-0 items-center gap-2 rounded-xl border border-zinc-800 px-2 text-zinc-400 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/70"
                        >
                            <span className="hidden -space-x-2 sm:flex">
                                {groupAgents.slice(0, 4).map((agent) => (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img
                                        key={agent.id}
                                        src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id)}`}
                                        alt=""
                                        title={agent.name}
                                        className="h-6 w-6 rounded-full border-2 border-zinc-950 bg-zinc-800 object-cover"
                                    />
                                ))}
                            </span>
                            <span className="text-xs tabular-nums">{activeGroup.members.length}</span>
                            <IconSettings className="h-4 w-4" />
                        </button>
                    )}
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
                {activeGroup ? (
                    <div className="flex min-h-0 flex-1 flex-col">
                        <div className="relative min-h-0 flex-1 overflow-hidden">
                            <div className="h-full">
                                <AgentTeamChat
                                    key={activeGroup.id}
                                    initialMessages={[]}
                                    agents={agents}
                                    mentionAgents={groupAgents.length > 1 ? [EVERYONE_MENTION, ...groupAgents] : groupAgents}
                                    sendable={true}
                                    groupId={activeGroup.id}
                                    placeholder={`Message ${activeGroup.title}… (@ a member, or @all)`}
                                />
                            </div>
                        </div>
                    </div>
                ) : selectedAgentId === null ? (
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
            {groupDialog && (
                <GroupDialog
                    key={groupDialog.mode === "edit" ? groupDialog.groupId : "create"}
                    open
                    onOpenChange={(open) => { if (!open) setGroupDialog(null); }}
                    agents={agents}
                    humans={humans}
                    currentUserId={currentUserId}
                    group={editingGroup}
                    onSaved={(groupId) => {
                        router.refresh();
                        openGroup(groupId);
                    }}
                    onArchived={() => {
                        router.refresh();
                        openTeamChannel();
                    }}
                />
            )}
        </div>
    );
}
