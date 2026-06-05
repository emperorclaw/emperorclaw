"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, Send, User } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "@/components/markdown-renderer";

type DirectThread = {
    id: string;
    type: string;
    title: string | null;
    createdAt: string;
};

type DirectMessage = {
    id: string;
    senderType: "human" | "agent" | "system";
    senderId?: string | null;
    fromUserId?: string | null;
    text: string;
    createdAt: string;
};

type DirectParticipant = {
    participantType: "human" | "agent" | "system" | string;
    typingUntil?: string | null;
    lastReadAt?: string | null;
};

export function AgentDirectChat({
    agentId,
    agentName,
    hideHeader = false,
}: {
    agentId: string;
    agentName: string;
    hideHeader?: boolean;
}) {
    const [thread, setThread] = useState<DirectThread | null>(null);
    const [messages, setMessages] = useState<DirectMessage[]>([]);
    const [participants, setParticipants] = useState<DirectParticipant[]>([]);
    const [draft, setDraft] = useState("");
    const [isLoading, setIsLoading] = useState(true);
    const [isSending, setIsSending] = useState(false);
    const [isTyping, setIsTyping] = useState(false);
    const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastSeenAtRef = useRef<string | null>(null);

    const loadMessages = useCallback(async (since?: string | null) => {
        const params = new URLSearchParams({ targetAgentId: agentId });
        if (since) params.set("since", since);

        const res = await fetch(`/api/chat?${params.toString()}`);
        if (!res.ok) {
            throw new Error("Failed to load direct thread");
        }

        const data = await res.json() as { 
            thread?: DirectThread; 
            messages?: DirectMessage[];
            participants?: DirectParticipant[];
        };

        if (data.thread) {
            setThread(data.thread);
            // Mark as read whenever we successfully poll and have a thread
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
            const nextMessages = data.messages;
            setMessages((prev) => {
                if (!since) return nextMessages;
                const existingIds = new Set(prev.map((message) => message.id));
                const appended = nextMessages.filter((message) => !existingIds.has(message.id));
                return appended.length > 0 ? [...prev, ...appended] : prev;
            });

            lastSeenAtRef.current = nextMessages[nextMessages.length - 1].createdAt;
        }
    }, [agentId]);

    const handleTyping = (text: string) => {
        setDraft(text);
        
        if (!isTyping && text.trim().length > 0) {
            setIsTyping(true);
            if (thread?.id) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId: thread.id, typing: true }),
                });
            }
        }

        if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        
        typingTimeoutRef.current = setTimeout(() => {
            setIsTyping(false);
            if (thread?.id) {
                void fetch("/api/chat/status", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ threadId: thread.id, typing: false }),
                });
            }
        }, 3000);
    };

    useEffect(() => {
        let active = true;

        const initialize = async () => {
            setIsLoading(true);
            setMessages([]);
            setThread(null);
            setParticipants([]);
            lastSeenAtRef.current = null;

            try {
                await loadMessages();
            } catch (error) {
                if (active) {
                    console.error("Failed to initialize direct chat", error);
                }
            } finally {
                if (active) {
                    setIsLoading(false);
                }
            }
        };

        void initialize();

        const interval = setInterval(() => {
            void loadMessages(lastSeenAtRef.current).catch((error) => {
                if (active) {
                    console.error("Failed to poll direct chat", error);
                }
            });
        }, 5000);

        return () => {
            active = false;
            clearInterval(interval);
            if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
        };
    }, [loadMessages]);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSend = async (event: React.FormEvent) => {
        event.preventDefault();
        const text = draft.trim();
        if (!text || isSending) return;

        setIsSending(true);
        setDraft("");

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, targetAgentId: agentId }),
            });

            if (!res.ok) {
                throw new Error("Failed to send direct message");
            }

            const data = await res.json() as { thread?: DirectThread; message?: DirectMessage };
            if (data.thread) {
                setThread(data.thread);
            }
            if (data.message) {
                setMessages((prev) => prev.some((message) => message.id === data.message!.id) ? prev : [...prev, data.message!]);
                lastSeenAtRef.current = data.message.createdAt;
            }
        } catch (error) {
            console.error("Failed to send direct message", error);
            setDraft(text);
        } finally {
            setIsSending(false);
        }
    };

    const isAgentTyping = participants.some(p => 
        p.participantType === 'agent' && 
        p.typingUntil && 
        new Date(p.typingUntil).getTime() > Date.now()
    );

    const agentLastReadAt = participants.find(p => p.participantType === 'agent')?.lastReadAt;

    return (
        <div className={cn("bg-zinc-900/50 border border-zinc-800 rounded-xl overflow-hidden h-full flex flex-col", hideHeader && "bg-transparent border-none rounded-none shadow-none")}>
            {!hideHeader && (
                <div className="flex items-center justify-between gap-4 p-5 border-b border-zinc-800 bg-zinc-900/40">
                    <div>
                        <div className="flex items-center gap-2">
                            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <Bot className="w-4 h-4 text-emerald-400" />
                            </div>
                            <div>
                                <h2 className="text-lg font-medium text-zinc-100">Direct Chat</h2>
                                <p className="text-xs text-zinc-500">
                                    Dedicated human-to-agent thread for {agentName}. Team, task, and attention threads stay under `Threads`.
                                </p>
                            </div>
                        </div>
                    </div>
                    <div className="text-right">
                        <div className="text-[10px] uppercase tracking-wider font-semibold text-zinc-500">Thread</div>
                        <div className="text-xs font-mono text-zinc-400">{thread?.id || "provisioning"}</div>
                    </div>
                </div>
            )}

            <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4 bg-[radial-gradient(circle_at_top,_rgba(16,185,129,0.08),_transparent_35%),linear-gradient(180deg,rgba(24,24,27,0.55),rgba(9,9,11,0.95))]">
                {isLoading ? (
                    <div className="h-full flex items-center justify-center text-sm text-zinc-500 animate-pulse">
                        Loading direct thread...
                    </div>
                ) : messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center">
                        <div className="max-w-sm rounded-2xl border border-dashed border-zinc-800 bg-zinc-950/50 p-6 text-center">
                            <div className="text-sm text-zinc-300 mb-2">No direct messages yet.</div>
                            <div className="text-xs text-zinc-500 leading-relaxed">
                                Send an instruction here and OpenClaw should answer inside this agent’s private thread.
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-4">
                        {messages.map((message) => {
                            const isHuman = message.senderType === "human";
                            const isRead = isHuman && agentLastReadAt && new Date(agentLastReadAt).getTime() >= new Date(message.createdAt).getTime();

                            return (
                                <div key={message.id} className={`flex ${isHuman ? "justify-end" : "justify-start"}`}>
                                    <div className="flex flex-col items-end max-w-[80%]">
                                        <div className={`rounded-2xl border px-4 py-3 shadow-sm ${isHuman ? "bg-emerald-500 text-emerald-950 border-emerald-400/40 rounded-br-sm" : "bg-zinc-950/85 text-zinc-200 border-zinc-800 rounded-bl-sm"}`}>
                                            <div className="flex items-center justify-between gap-3 mb-2">
                                                <div className="flex items-center gap-2">
                                                    <div className={`w-5 h-5 rounded-full flex items-center justify-center ${isHuman ? "bg-emerald-950/15" : "bg-zinc-800"}`}>
                                                        {isHuman ? <User className="w-3 h-3" /> : <Bot className="w-3 h-3 text-emerald-400" />}
                                                    </div>
                                                    <span className={`text-[10px] uppercase tracking-wider font-bold ${isHuman ? "text-emerald-950/70" : "text-zinc-500"}`}>
                                                        {isHuman ? "You" : agentName}
                                                    </span>
                                                </div>
                                                <span className={`text-[10px] ${isHuman ? "text-emerald-950/70" : "text-zinc-600"}`}>
                                                    {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                                                </span>
                                            </div>
                                            <MarkdownRenderer
                                                content={message.text}
                                                className="[&_.prose]:max-w-none [&_.prose]:text-sm [&_.prose]:leading-relaxed [&_.prose_p:first-child]:mt-0 [&_.prose_p:last-child]:mb-0 [&_.prose_p]:mb-3 [&_.prose_ul]:mb-3 [&_.prose_ol]:mb-3 [&_.prose_pre]:mb-3 [&_.prose_pre]:bg-zinc-950/70 [&_.prose_pre]:border-zinc-800/80 [&_.prose_code]:text-emerald-200 [&_.prose_a]:text-emerald-300"
                                            />
                                        </div>
                                        {isHuman && (
                                            <div className="mt-1 flex items-center gap-1 px-1">
                                                <span className={cn("text-[10px] font-medium transition-colors", isRead ? "text-emerald-500" : "text-zinc-600")}>
                                                    {isRead ? "Read" : "Sent"}
                                                </span>
                                                {isRead && <div className="w-1 h-1 rounded-full bg-emerald-500" />}
                                            </div>
                                        )}
                                    </div>
                                </div>
                            );
                        })}
                        {isAgentTyping && (
                            <div className="flex justify-start animate-in fade-in slide-in-from-left-2 duration-300">
                                <div className="bg-zinc-900 border border-zinc-800 rounded-2xl px-4 py-3 flex items-center gap-2">
                                    <div className="flex gap-1">
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce [animation-delay:-0.3s]" />
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce [animation-delay:-0.15s]" />
                                        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-bounce" />
                                    </div>
                                    <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">
                                        {agentName} is typing
                                    </span>
                                </div>
                            </div>
                        )}
                    </div>
                )}
            </div>

            <form onSubmit={handleSend} className="border-t border-zinc-800 bg-zinc-950/80 p-4">
                <div className="flex items-center gap-3">
                    <input
                        type="text"
                        value={draft}
                        onChange={(event) => handleTyping(event.target.value)}
                        placeholder={`Message ${agentName} directly...`}
                        className="flex-1 bg-zinc-900 border border-zinc-800 rounded-full px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                    <button
                        type="submit"
                        disabled={!draft.trim() || isSending}
                        className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        <Send className="w-4 h-4" />
                        {isSending ? "Sending" : "Send"}
                    </button>
                </div>
            </form>
        </div>
    );
}
