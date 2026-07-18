"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { User, Send, AtSign } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { MentionTextarea } from "@/components/mention-textarea";
import { cn } from "@/lib/utils";

const CHAT_PAGE_SIZE = 25;

type Agent = {
    id: string;
    name: string;
    avatarUrl?: string | null;
    status?: string | null;
};

type TeamMessage = {
    id: string;
    senderType: "human" | "agent" | "system" | string;
    senderId?: string | null;
    fromUserId?: string | null;
    text: string;
    createdAt: string | Date;
};

type TeamParticipant = {
    participantType: "human" | "agent" | "system" | string;
    participantId?: string | null;
    typingUntil?: string | null;
    lastReadAt?: string | null;
};

type ChatResponse = {
    messages?: TeamMessage[];
    participants?: TeamParticipant[];
    hasMore?: boolean;
    message?: TeamMessage;
};

// --- Grouping helpers ---

function isSameDay(a: string | Date, b: string | Date) {
    const da = new Date(a), db = new Date(b);
    return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
}

function isGroupContinuation(
    curr: { senderType: string; senderId?: string | null; fromUserId?: string | null; createdAt: string | Date },
    prev: typeof curr
) {
    if (curr.senderType !== prev.senderType) return false;
    const currId = curr.senderId ?? curr.fromUserId ?? null;
    const prevId = prev.senderId ?? prev.fromUserId ?? null;
    if (currId !== prevId) return false;
    return (new Date(curr.createdAt).getTime() - new Date(prev.createdAt).getTime()) < 5 * 60 * 1000;
}

function dateSeparatorLabel(date: string | Date) {
    const d = new Date(date);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);
    if (isSameDay(d, today)) return "Today";
    if (isSameDay(d, yesterday)) return "Yesterday";
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function messageCursor(value: string | Date) {
    return value instanceof Date ? value.toISOString() : value;
}

export function AgentTeamChat({
    initialMessages = [],
    initialHasMore = false,
    agents = [],
    sendable = false,
    teamThreadId,
}: {
    initialMessages: TeamMessage[];
    initialHasMore?: boolean;
    agents: Agent[];
    sendable?: boolean;
    teamThreadId?: string;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const preserveScrollHeightRef = useRef<number | null>(null);
    const [messages, setMessages] = useState<TeamMessage[]>(initialMessages);
    const [participants, setParticipants] = useState<TeamParticipant[]>([]);
    const [draft, setDraft] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [hasOlderMessages, setHasOlderMessages] = useState(initialHasMore);
    const [isLoadingOlder, setIsLoadingOlder] = useState(false);
    const teamTextareaRef = useRef<HTMLTextAreaElement>(null);

    const [unreadCount, setUnreadCount] = useState(0);
    const [lastSeenAt, setLastSeenAt] = useState<string | null>(
        initialMessages.length > 0 ? messageCursor(initialMessages[initialMessages.length - 1].createdAt) : null
    );
    const [isAtBottom, setIsAtBottom] = useState(true);

    const rowVirtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => 72,
        overscan: 8,
        getItemKey: (index) => messages[index].id,
    });

    useEffect(() => {
        setMessages(initialMessages);
        setLastSeenAt(initialMessages.length > 0 ? messageCursor(initialMessages[initialMessages.length - 1].createdAt) : null);
        setHasOlderMessages(initialHasMore);
    }, [initialHasMore, initialMessages]);

    const loadOlderMessages = useCallback(async () => {
        if (isLoadingOlder || !hasOlderMessages || messages.length === 0) return;

        preserveScrollHeightRef.current = scrollRef.current?.scrollHeight ?? null;
        setIsLoadingOlder(true);
        try {
            const params = new URLSearchParams({
                before: String(messages[0].createdAt),
                limit: String(CHAT_PAGE_SIZE),
            });
            const res = await fetch(`/api/chat?${params.toString()}`);
            if (!res.ok) return;

            const data = await res.json() as ChatResponse;
            if (data.messages && data.messages.length > 0) {
                setMessages((prev) => {
                    const existingIds = new Set(prev.map((m) => m.id));
                    const olderMessages = data.messages!.filter((m) => !existingIds.has(m.id));
                    return olderMessages.length > 0 ? [...olderMessages, ...prev] : prev;
                });
            }
            setHasOlderMessages(Boolean(data.hasMore));
        } catch (err) {
            console.error("Failed to load older team messages", err);
        } finally {
            setIsLoadingOlder(false);
        }
    }, [hasOlderMessages, isLoadingOlder, messages]);

    useEffect(() => {
        const fetchUpdates = async () => {
            try {
                const url = lastSeenAt ? `/api/chat?since=${encodeURIComponent(lastSeenAt)}` : "/api/chat";
                const res = await fetch(url);
                if (!res.ok) return;
                const data = await res.json() as ChatResponse;
                if (data.participants) {
                    setParticipants(data.participants);
                }
                const nextMessages = data.messages;
                if (nextMessages && nextMessages.length > 0) {
                    setMessages((prev) => {
                        const existingIds = new Set(prev.map((m) => m.id));
                        const newMessages = nextMessages.filter((m) => !existingIds.has(m.id));
                        if (newMessages.length === 0) return prev;
                        return [...prev, ...newMessages];
                    });
                    const latest = nextMessages[nextMessages.length - 1];
                    setLastSeenAt((prevLast) => {
                        const latestCreatedAt = messageCursor(latest.createdAt);
                        return new Date(latestCreatedAt).getTime() > new Date(prevLast || 0).getTime()
                            ? latestCreatedAt
                            : prevLast;
                    });
                    if (!isAtBottom) {
                        setUnreadCount((c) => c + nextMessages.length);
                    }
                }
            } catch (err) {
                console.error("Failed to poll agent chat", err);
            }
        };

        const interval = setInterval(fetchUpdates, 5000);
        return () => clearInterval(interval);
    }, [lastSeenAt, isAtBottom]);

    useEffect(() => {
        if (scrollRef.current) {
            if (preserveScrollHeightRef.current !== null) {
                const previousHeight = preserveScrollHeightRef.current;
                preserveScrollHeightRef.current = null;
                scrollRef.current.scrollTop += scrollRef.current.scrollHeight - previousHeight;
                return;
            }
            if (isAtBottom && messages.length > 0) {
                rowVirtualizer.scrollToIndex(messages.length - 1, { align: "end" });
                setUnreadCount(0);
            }
        }
    }, [messages, isAtBottom, rowVirtualizer]);

    const handleScroll = () => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 10;
        setIsAtBottom(atBottom);
        if (atBottom) setUnreadCount(0);
    };

    // Mark the shared team thread read whenever we're scrolled to the
    // bottom and messages exist — otherwise lastReadAt on this thread never
    // advances and the sidebar unread badge never clears.
    useEffect(() => {
        if (!teamThreadId || !isAtBottom || messages.length === 0) return;
        void fetch("/api/chat/status", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId: teamThreadId, markRead: true }),
        });
    }, [teamThreadId, isAtBottom, messages]);

    const sendMessage = async () => {
        const text = draft.trim();
        if (!text || isSending) return;
        setIsSending(true);
        setDraft("");
        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
            });
            if (!res.ok) throw new Error("Failed to send");
            const data = await res.json() as ChatResponse;
            const sentMessage = data.message;
            if (sentMessage) {
                setMessages((prev) => prev.some((m) => m.id === sentMessage.id) ? prev : [...prev, sentMessage]);
                setLastSeenAt(messageCursor(sentMessage.createdAt));
            }
        } catch (err) {
            console.error("Failed to send team message", err);
            setDraft(text);
        } finally {
            setIsSending(false);
        }
    };

    const handleSend = (e: React.FormEvent) => {
        e.preventDefault();
        void sendMessage();
    };

    const getAgentName = (id: string | null | undefined) => {
        if (!id) return "System";
        const agent = agents.find((a) => a.id === id);
        return agent ? agent.name : "Unknown Agent";
    };

    const now = Date.now();
    const typingAgents = participants
        .filter(p => p.participantType === "agent" && p.typingUntil && new Date(p.typingUntil).getTime() > now)
        .map(p => ({ id: p.participantId, name: getAgentName(p.participantId) }));

    const agentReadTimes: Record<string, number> = {};
    for (const p of participants) {
        if (p.participantType === "agent" && p.participantId && p.lastReadAt) {
            agentReadTimes[p.participantId] = new Date(p.lastReadAt).getTime();
        }
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between border-b border-zinc-800/80 p-4">
                <div className="flex items-center space-x-3">
                    <h2 className="text-lg font-medium text-zinc-200">Agent Team Chat</h2>
                    {unreadCount > 0 && (
                        <span className="rounded-full border border-rose-500/30 bg-rose-500/20 px-2 py-0.5 text-[10px] text-rose-300">
                            {unreadCount} new
                        </span>
                    )}
                </div>
                <div className="flex items-center space-x-2">
                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-500" />
                    <span className="text-xs font-medium uppercase tracking-tight text-zinc-500">Live Feed</span>
                </div>
            </div>

            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto px-4 py-3">
                {messages.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm italic text-zinc-600">No communications yet.</div>
                ) : (
                    <div>
                        {hasOlderMessages && (
                            <div className="mb-4 flex justify-center">
                                <button
                                    type="button"
                                    onClick={loadOlderMessages}
                                    disabled={isLoadingOlder}
                                    className="rounded-full border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-50"
                                >
                                    {isLoadingOlder ? "Loading..." : "Load older messages"}
                                </button>
                            </div>
                        )}
                        <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}>
                        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                            const i = virtualRow.index;
                            const msg = messages[i];
                            const prev = messages[i - 1] ?? null;
                            const next = messages[i + 1] ?? null;
                            const isHuman = msg.senderType === "human";

                            const showDaySep = !prev || !isSameDay(prev.createdAt, msg.createdAt);
                            const isContinuation = !!prev && isGroupContinuation(msg, prev);
                            const isLastInGroup = !next || !isGroupContinuation(next, msg);

                            const msgTime = new Date(msg.createdAt).getTime();
                            const readByAgents = isHuman
                                ? Object.entries(agentReadTimes)
                                    .filter(([, t]) => t >= msgTime)
                                    .map(([id]) => ({ id, name: getAgentName(id) }))
                                : [];

                            const senderId = msg.fromUserId || msg.senderId || null;
                            const agentObj = !isHuman ? agents.find((a) => a.id === senderId) : null;
                            const avatarSrc = agentObj?.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(senderId || "agent")}`;

                            return (
                                <div
                                    key={msg.id}
                                    ref={rowVirtualizer.measureElement}
                                    data-index={i}
                                    style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}
                                >
                                    {showDaySep && (
                                        <div className="flex items-center gap-2 my-4">
                                            <div className="flex-1 border-t border-zinc-800" />
                                            <span className="text-[10px] uppercase tracking-widest text-zinc-600">{dateSeparatorLabel(msg.createdAt)}</span>
                                            <div className="flex-1 border-t border-zinc-800" />
                                        </div>
                                    )}

                                    <div className={cn(
                                        `flex`,
                                        isHuman ? "flex-row-reverse" : "flex-row",
                                        isContinuation ? "mt-0.5" : "mt-3"
                                    )}>
                                        {/* Avatar — only on group-start, always occupies 44px (w-8 + gap) for alignment */}
                                        <div className={cn("shrink-0 flex flex-col justify-end", isHuman ? "ml-2" : "mr-2", "w-8")}>
                                            {!isContinuation && (
                                                isHuman ? (
                                                    <div className="h-8 w-8 flex items-center justify-center overflow-hidden rounded-full border border-zinc-700 bg-zinc-800/80">
                                                        <User className="h-4 w-4 text-zinc-400" />
                                                    </div>
                                                ) : (
                                                    <div className="h-8 w-8 overflow-hidden rounded-full border border-cyan-500/20 bg-cyan-500/10">
                                                        <img src={avatarSrc} className="h-full w-full object-cover" alt="" />
                                                    </div>
                                                )
                                            )}
                                        </div>

                                        {/* Bubble + read receipts */}
                                        <div className={cn("flex min-w-0 max-w-[75%] flex-col", isHuman ? "items-end" : "items-start")}>
                                            {/* Sender name — group-start only, agents only */}
                                            {!isContinuation && !isHuman && (
                                                <span className="text-[10px] font-medium text-cyan-400 mb-1 ml-1">{getAgentName(senderId)}</span>
                                            )}

                                            <div className={cn(
                                                "min-w-0 max-w-full rounded-2xl border px-4 py-2.5 text-sm",
                                                isHuman
                                                    ? "border-zinc-700/50 bg-zinc-800/50 text-zinc-200"
                                                    : "border-zinc-800/50 bg-zinc-800/30 text-zinc-300",
                                                isLastInGroup && isHuman && "rounded-tr-none",
                                                isLastInGroup && !isHuman && "rounded-tl-none"
                                            )}>
                                                <ParsedMessage text={msg.text} />
                                                {/* Timestamp bottom-right */}
                                                <div className={cn(
                                                    "text-[10px] mt-1.5 text-right opacity-50",
                                                    isHuman ? "text-zinc-400" : "text-zinc-500"
                                                )}>
                                                    {new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                                </div>
                                            </div>

                                            {/* Read receipts — only on last message of group */}
                                            {readByAgents.length > 0 && isLastInGroup && (
                                                <div className="mt-1 flex items-center gap-1 px-1">
                                                    <div className="flex -space-x-1">
                                                        {readByAgents.slice(0, 3).map(a => (
                                                            <img
                                                                key={a.id}
                                                                src={agents.find((ag) => ag.id === a.id)?.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(a.id)}`}
                                                                title={a.name}
                                                                className="h-3.5 w-3.5 rounded-full border border-zinc-900 object-cover"
                                                                alt={a.name}
                                                            />
                                                        ))}
                                                    </div>
                                                    <span className="text-[10px] font-medium text-cyan-500">
                                                        {readByAgents.length === 1 ? `Read by ${readByAgents[0].name}` : `Read by ${readByAgents.length} agents`}
                                                    </span>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                        </div>
                    </div>
                )}
            </div>

            {typingAgents.length > 0 && (
                <div className="flex items-center gap-2 border-t border-zinc-800/60 px-4 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
                    <div className="flex gap-1">
                        <div className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-bounce [animation-delay:-0.3s]" />
                        <div className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-bounce [animation-delay:-0.15s]" />
                        <div className="h-1.5 w-1.5 rounded-full bg-cyan-500 animate-bounce" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                        {typingAgents.length === 1
                            ? `${typingAgents[0].name} is typing`
                            : `${typingAgents.slice(0, -1).map((a: { name: string }) => a.name).join(", ")} and ${typingAgents[typingAgents.length - 1].name} are typing`}
                    </span>
                </div>
            )}

            {sendable ? (
                <form onSubmit={handleSend} className="border-t border-zinc-800/80 bg-zinc-900/30 p-3">
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            onClick={() => {
                                setDraft((prev) => (prev.trimEnd() ? `${prev.trimEnd()} @` : "@"));
                                requestAnimationFrame(() => teamTextareaRef.current?.focus());
                            }}
                            title="Mention an agent"
                            className="h-10 w-10 shrink-0 flex items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700 hover:border-cyan-500/50 hover:text-cyan-400 text-zinc-500 transition-colors"
                        >
                            <AtSign className="h-4 w-4" />
                        </button>

                        <MentionTextarea
                            ref={teamTextareaRef}
                            value={draft}
                            onValueChange={setDraft}
                            agents={agents}
                            onSubmit={sendMessage}
                            placeholder="Message the team… (@ to mention)"
                            rows={1}
                            className="w-full resize-none bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2 text-sm leading-5 text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-cyan-500 max-h-32 overflow-y-auto"
                        />
                        <button
                            type="submit"
                            disabled={!draft.trim() || isSending}
                            className="h-10 w-10 flex-shrink-0 flex items-center justify-center rounded-xl bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        >
                            <Send className="h-4 w-4 text-white" />
                        </button>
                    </div>
                </form>
            ) : (
                <div className="flex items-center justify-center space-x-2 border-t border-zinc-800/80 bg-zinc-900/30 p-3">
                    <span className="text-xs font-medium text-zinc-500">Read-only preview — open Team Channel to participate</span>
                </div>
            )}
        </div>
    );
}

function ParsedMessage({ text }: { text: string }) {
    if (!text) return null;

    // Only treat a message as a structured Update/Evidence/Next status report
    // when it actually opens with one of those markers — otherwise a diff or
    // code dump that happens to contain the word "Next:" mid-content (e.g. a
    // "### Next:" markdown heading being added to a file) gets misparsed,
    // silently discarding everything before the false match.
    const looksStructured = /^(update|evidence|next):/i.test(text.trimStart());

    const sections = looksStructured ? {
        update: text.match(/^Update:([\s\S]*?)(?=^Evidence:|^Next:|$)/im),
        evidence: text.match(/^Evidence:([\s\S]*?)(?=^Update:|^Next:|$)/im),
        next: text.match(/^Next:([\s\S]*?)(?=^Update:|^Evidence:|$)/im),
    } : { update: null, evidence: null, next: null };

    if (!sections.update && !sections.evidence && !sections.next) {
        return <ChatMarkdown content={text} accent="cyan" />;
    }

    return (
        <div className="my-2 space-y-4">
            {sections.update && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold uppercase tracking-tighter text-zinc-500">Update</div>
                    <ChatMarkdown content={sections.update[1].trim()} accent="cyan" />
                </div>
            )}
            {sections.evidence && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold uppercase tracking-tighter text-zinc-500">Evidence</div>
                    <div className="rounded border border-zinc-800/50 bg-zinc-950/50 p-3">
                        <ChatMarkdown content={sections.evidence[1].trim()} accent="cyan" compact />
                    </div>
                </div>
            )}
            {sections.next && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold uppercase tracking-tighter text-zinc-500">Next</div>
                    <ChatMarkdown content={sections.next[1].trim()} accent="cyan" />
                </div>
            )}
        </div>
    );
}

function ChatMarkdown({
    content,
    accent,
    compact = false,
}: {
    content: string;
    accent: "cyan" | "emerald";
    compact?: boolean;
}) {
    const accentText = accent === "emerald" ? "[&_.prose_code]:text-emerald-200 [&_.prose_a]:text-emerald-300" : "[&_.prose_code]:text-cyan-300 [&_.prose_a]:text-cyan-300";
    const sizing = compact
        ? "[&_.prose]:text-xs [&_.prose_p]:mb-2 [&_.prose_ul]:mb-2 [&_.prose_ol]:mb-2 [&_.prose_pre]:mb-2"
        : "[&_.prose]:text-sm [&_.prose_p]:mb-3 [&_.prose_ul]:mb-3 [&_.prose_ol]:mb-3 [&_.prose_pre]:mb-3";

    return (
        <MarkdownRenderer
            content={content}
            className={`break-words [&_.prose]:max-w-prose [&_.prose]:leading-relaxed [&_.prose_p:first-child]:mt-0 [&_.prose_p:last-child]:mb-0 [&_.prose_pre]:bg-zinc-950/70 [&_.prose_pre]:border-zinc-800/80 ${sizing} ${accentText}`}
        />
    );
}
