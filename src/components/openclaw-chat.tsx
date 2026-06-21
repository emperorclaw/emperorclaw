"use client";

import { useState, useEffect, useRef } from "react";
import { MessageSquare, Send, AtSign } from "lucide-react";
import { MarkdownRenderer } from "./markdown-renderer";
import { cn } from "@/lib/utils";

const CHAT_PAGE_SIZE = 25;

type AgentSummary = {
    id: string;
    name: string;
    avatarUrl?: string | null;
};

type TeamMessage = {
    id: string;
    senderType: string;
    senderId?: string | null;
    fromUserId?: string | null;
    text: string;
    createdAt: string;
};

type ThreadParticipant = {
    participantType: string;
    userId?: string | null;
    agentId?: string | null;
    typingUntil?: string | null;
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

export function OpenClawChat() {
    const [isOpen, setIsOpen] = useState(false);
    const [message, setMessage] = useState("");
    const [history, setHistory] = useState<TeamMessage[]>([]);
    const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
    const [agents, setAgents] = useState<AgentSummary[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
    const [initialized, setInitialized] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const baseTitleRef = useRef<string | null>(null);
    const [participants, setParticipants] = useState<ThreadParticipant[]>([]);
    const [threadId, setThreadId] = useState<string | null>(null);
    const [isTyping, setIsTyping] = useState(false);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const [mentionOpen, setMentionOpen] = useState(false);
    const mentionRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Click-outside for mention popover
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
                setMentionOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);

    const mentionAlias = (name: string) => {
        const clean = name.replace(/\([^)]*\)/g, "").split(/\s+-\s+|\s+—\s+|\s+\|\s+/)[0].trim();
        return clean.split(/\s+/)[0] || name;
    };

    const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const removeLeadingMentions = (text: string) => {
        let next = text.trimStart();
        let changed = true;
        while (changed) {
            changed = false;
            for (const agent of agents) {
                const aliases = [agent.name, mentionAlias(agent.name || "")].filter(Boolean);
                for (const alias of aliases) {
                    const pattern = new RegExp(`^@${escapeRegex(alias)}(?:\\s+|$)`, "i");
                    const replaced = next.replace(pattern, "");
                    if (replaced !== next) {
                        next = replaced.trimStart();
                        changed = true;
                    }
                }
            }
            const fallback = next.replace(/^@\S+\s*/, "");
            if (fallback !== next) {
                next = fallback.trimStart();
                changed = true;
            }
        }
        return next;
    };

    const setSelectedAgentMention = (agent: AgentSummary | null) => {
        setSelectedAgentId(agent?.id || null);
        if (!agent?.name) {
            setMessage((prev) => removeLeadingMentions(prev));
            return;
        }
        setMessage((prev) => {
            const rest = removeLeadingMentions(prev);
            return `@${mentionAlias(agent.name)}${rest ? ` ${rest}` : " "}`;
        });
    };

    const buildChatUrl = (since?: string | null) => {
        const params = new URLSearchParams();
        params.set("limit", String(CHAT_PAGE_SIZE));
        if (since) params.set("since", since);
        const query = params.toString();
        return query ? `/api/chat?${query}` : "/api/chat";
    };

    // Fetch history and poll
    useEffect(() => {
        const initFetch = async () => {
            try {
                // Fetch chat history
                const res = await fetch(buildChatUrl());
                if (res.ok) {
                    const data = await res.json();
                    if (data.thread && data.thread.id) {
                        setThreadId(data.thread.id);
                        void fetch("/api/chat/status", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ threadId: data.thread.id, markRead: true }),
                        });
                    }
                    if (data.participants) {
                        setParticipants(data.participants);
                    }
                    if (data.messages && data.messages.length > 0) {
                        setHistory(data.messages);
                        setLastSeenAt(data.messages[data.messages.length - 1].createdAt);
                    }
                }

                // Fetch agents map for mapping IDs to names
                const agentRes = await fetch('/api/agents');
                if (agentRes.ok) {
                    const agentData = await agentRes.json();
                    if (agentData.agents) {
                        setAgents(agentData.agents);
                    }
                }
            } catch (err) {
                console.error("Failed to fetch initial data", err);
            } finally {
                setInitialized(true);
            }
        };

        const pollHistory = async () => {
            if (!initialized) return; // Only poll after initial fetch
            try {
                const url = buildChatUrl(lastSeenAt);
                const res = await fetch(url);
                if (!res.ok) return;
                const data = await res.json();
                if (data.participants) {
                    setParticipants(data.participants);
                }
                if (data.messages && data.messages.length > 0) {
                    setHistory((prev) => {
                        const existingIds = new Set(prev.map(m => m.id));
                        const newMessages = (data.messages as TeamMessage[]).filter((m) => !existingIds.has(m.id));

                        if (newMessages.length > 0 && !isOpen) {
                            const newAgentMessages = newMessages.filter((m) => m.senderType === 'agent').length;
                            if (newAgentMessages > 0) {
                                setUnreadCount((c) => c + newAgentMessages);
                            }
                        }

                        return newMessages.length > 0 ? [...prev, ...newMessages].slice(-100) : prev;
                    });

                    const latest = data.messages[data.messages.length - 1];
                    setLastSeenAt((prevLast) => {
                        return new Date(latest.createdAt).getTime() > new Date(prevLast || 0).getTime()
                            ? latest.createdAt : prevLast;
                    });
                }
            } catch (err) {
                console.error("Failed to load chat history", err);
            }
        };

        if (!initialized) {
            initFetch();
        }

        const interval = setInterval(pollHistory, 5000); // Poll every 5 seconds
        return () => clearInterval(interval);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen, initialized, selectedAgentId, lastSeenAt]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [history, isOpen]);

    useEffect(() => {
        if (typeof document === "undefined") return;
        if (!baseTitleRef.current) baseTitleRef.current = document.title;
        if (unreadCount > 0) {
            document.title = `(${unreadCount}) ${baseTitleRef.current}`;
        } else if (baseTitleRef.current) {
            document.title = baseTitleRef.current;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [unreadCount]);

    useEffect(() => {
        if (isOpen) {
            setUnreadCount(0);
        }
    }, [isOpen]);

    const handleTyping = (text: string) => {
        setMessage(text);
        if (!isTyping && text.trim().length > 0) {
            setIsTyping(true);
            if (threadId) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId, typing: true }),
                });
            }
        }
        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        typingTimeoutRef.current = setTimeout(() => {
            setIsTyping(false);
            if (threadId) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId, typing: false }),
                });
            }
        }, 3000);
    };

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        const textToSend = message;

        setMessage("");
        setSelectedAgentId(null);

        try {
            const res = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textToSend })
            });
            if (res.ok) {
                const data = await res.json();
                setHistory(prev => {
                    if (prev.some(p => p.id === data.message.id)) return prev;
                    return [...prev, data.message];
                });
                setLastSeenAt((prevLast) => {
                    return new Date(data.message.createdAt).getTime() > new Date(prevLast || 0).getTime()
                        ? data.message.createdAt : prevLast;
                });
            }
        } catch (err) {
            console.error("Failed to send message", err);
        }
    };

    const getAgentName = (id?: string | null) => {
        if (!id) return "OpenClaw System";
        const agent = agents.find(a => a.id === id);
        return agent ? agent.name : "Unknown Agent";
    };

    // Compute typing agents
    const typingAgents = participants.filter(
        p => p.participantType === 'agent' && p.typingUntil && new Date(p.typingUntil).getTime() > Date.now()
    );
    const typingNames = typingAgents.map(p => {
        const agent = agents.find(a => a.id === (p.userId || p.agentId));
        return agent ? agent.name : 'Unknown';
    });

    const onlineAgentCount = agents.length;

    return (
        <>
            <button
                onClick={() => setIsOpen(true)}
                className={cn(
                    "fixed bottom-6 right-6 p-4 rounded-full shadow-2xl bg-indigo-600 hover:bg-indigo-500 text-white transition-all transform hover:scale-105 z-50",
                    isOpen && "opacity-0 pointer-events-none scale-90"
                )}
            >
                <MessageSquare className="w-6 h-6" />
                {unreadCount > 0 && (
                    <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-rose-500 text-[10px] text-white flex items-center justify-center font-semibold shadow">
                        {unreadCount > 9 ? "9+" : unreadCount}
                    </span>
                )}
            </button>

            {isOpen && (
                <div className="fixed bottom-6 right-6 w-[420px] h-[580px] bg-zinc-950 border border-zinc-800 shadow-2xl rounded-2xl flex flex-col z-50 animate-in slide-in-from-bottom-5 fade-in duration-200 overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
                        <div className="flex flex-col">
                            <span className="text-sm font-semibold text-zinc-100 leading-tight">Team Channel</span>
                            {typingNames.length > 0 ? (
                                <span className="text-[10px] text-indigo-400 flex items-center gap-1">
                                    <span className="flex gap-0.5">
                                        <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce [animation-delay:-0.3s]" />
                                        <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce [animation-delay:-0.15s]" />
                                        <span className="w-1 h-1 rounded-full bg-indigo-400 animate-bounce" />
                                    </span>
                                    {typingNames[0]} is typing…
                                </span>
                            ) : (
                                <span className="text-[10px] text-zinc-500 flex items-center gap-1.5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                    {onlineAgentCount > 0 ? `${onlineAgentCount} agent${onlineAgentCount !== 1 ? "s" : ""} online` : "Team Thread"}
                                </span>
                            )}
                        </div>
                        <button
                            onClick={() => setIsOpen(false)}
                            className="w-7 h-7 flex items-center justify-center rounded-lg hover:bg-zinc-800 text-zinc-500 hover:text-zinc-300 transition-colors text-lg leading-none"
                            aria-label="Close"
                        >
                            ×
                        </button>
                    </div>

                    {/* Chat History */}
                    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3">
                        {history.map((msg, i) => {
                            const prev = history[i - 1] ?? null;
                            const next = history[i + 1] ?? null;
                            const isHuman = msg.senderType === 'human';

                            const showDaySep = !prev || !isSameDay(prev.createdAt, msg.createdAt);
                            const isContinuation = !!prev && isGroupContinuation(msg, prev);
                            const isLastInGroup = !next || !isGroupContinuation(next, msg);

                            const senderId = msg.fromUserId || msg.senderId || null;
                            const agentObj = !isHuman ? agents.find(a => a.id === senderId) : null;
                            const avatarSrc = agentObj?.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(senderId || 'agent')}`;

                            return (
                                <div key={msg.id}>
                                    {showDaySep && (
                                        <div className="flex items-center gap-2 my-3">
                                            <div className="flex-1 border-t border-zinc-800" />
                                            <span className="text-[10px] uppercase tracking-widest text-zinc-600">{dateSeparatorLabel(msg.createdAt)}</span>
                                            <div className="flex-1 border-t border-zinc-800" />
                                        </div>
                                    )}

                                    {isHuman ? (
                                        <div className={cn("flex justify-end", isContinuation ? "mt-0.5" : "mt-3")}>
                                            <div className="flex flex-col items-end max-w-[80%]">
                                                {!isContinuation && (
                                                    <span className="text-[10px] font-medium text-zinc-500 mb-1 mr-1">You</span>
                                                )}
                                                <div className={cn(
                                                    "px-3.5 py-2 text-sm bg-indigo-600 text-white rounded-2xl",
                                                    isLastInGroup && "rounded-br-none"
                                                )}>
                                                    <MarkdownRenderer content={msg.text} className="whitespace-pre-wrap leading-relaxed prose-sm" />
                                                </div>
                                                {isLastInGroup && (
                                                    <span className="text-[10px] text-zinc-600 mt-0.5 mr-1">
                                                        {new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                    ) : (
                                        <div className={cn("flex justify-start", isContinuation ? "mt-0.5" : "mt-3")}>
                                            <div className="flex gap-2 max-w-[80%]">
                                                {/* Avatar column — always 28px wide to keep alignment */}
                                                <div className="w-7 shrink-0 flex flex-col justify-end">
                                                    {!isContinuation && (
                                                        <div className="w-7 h-7 rounded-full overflow-hidden border border-zinc-700/50">
                                                            <img src={avatarSrc} className="w-full h-full object-cover" alt="" />
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="flex flex-col items-start min-w-0">
                                                    {!isContinuation && (
                                                        <span className="text-[10px] font-medium text-zinc-400 mb-1 ml-1">{getAgentName(senderId)}</span>
                                                    )}
                                                    <div className={cn(
                                                        "px-3.5 py-2 text-sm bg-zinc-800/80 text-zinc-200 rounded-2xl",
                                                        isLastInGroup && "rounded-bl-none"
                                                    )}>
                                                        <MarkdownRenderer content={msg.text} className="whitespace-pre-wrap leading-relaxed prose-sm" />
                                                    </div>
                                                    {isLastInGroup && (
                                                        <span className="text-[10px] text-zinc-600 mt-0.5 ml-1">
                                                            {new Date(msg.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                                                        </span>
                                                    )}
                                                </div>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>

                    {/* Typing indicator — between message list and input */}
                    {typingNames.length > 0 && (
                        <div className="flex items-center gap-2 px-4 py-1.5 shrink-0">
                            <div className="flex gap-1">
                                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.3s]" />
                                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.15s]" />
                                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-bounce" />
                            </div>
                            <span className="text-[10px] text-zinc-400 font-bold uppercase tracking-wider">
                                {typingNames.join(', ')} {typingNames.length > 1 ? 'are' : 'is'} typing…
                            </span>
                        </div>
                    )}

                    {/* Input Area */}
                    <form onSubmit={handleSend} className="flex items-end gap-2 p-3 border-t border-zinc-800 shrink-0">
                        {/* @ mention button */}
                        <div className="relative shrink-0" ref={mentionRef}>
                            <button
                                type="button"
                                onClick={() => setMentionOpen(v => !v)}
                                title="Mention an agent"
                                className="w-9 h-9 flex items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700 hover:border-indigo-500/50 hover:text-indigo-400 text-zinc-500 transition-colors"
                            >
                                <AtSign className="w-4 h-4" />
                            </button>
                            {mentionOpen && agents.length > 0 && (
                                <div className="absolute bottom-full left-0 mb-2 w-48 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden z-20">
                                    <div className="px-3 py-2 border-b border-zinc-800">
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Mention agent</span>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto p-1">
                                        {agents.map((agent) => (
                                            <button
                                                key={agent.id}
                                                type="button"
                                                onClick={() => {
                                                    setSelectedAgentMention(agent);
                                                    setMentionOpen(false);
                                                    textareaRef.current?.focus();
                                                }}
                                                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-left transition-colors"
                                            >
                                                <div className="w-6 h-6 rounded-full overflow-hidden border border-zinc-700/50 shrink-0">
                                                    <img
                                                        src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id)}`}
                                                        className="w-full h-full object-cover"
                                                        alt=""
                                                    />
                                                </div>
                                                <span className="text-sm text-zinc-300 truncate">{agent.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <textarea
                            ref={textareaRef}
                            value={message}
                            onChange={(e) => handleTyping(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void handleSend(e as unknown as React.FormEvent);
                                }
                            }}
                            placeholder="Message Team Channel…"
                            rows={1}
                            className="flex-1 resize-none bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 max-h-24 overflow-y-auto"
                            style={{ minHeight: "2.25rem" }}
                        />

                        <button
                            type="submit"
                            disabled={!message.trim()}
                            className="w-9 h-9 flex items-center justify-center rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    </form>
                </div>
            )}
        </>
    );
}
