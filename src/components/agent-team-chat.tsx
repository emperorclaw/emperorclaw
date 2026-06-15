"use client";

import { useEffect, useRef, useState } from "react";
import { User, Send, AtSign } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";

export function AgentTeamChat({ initialMessages = [], agents = [], sendable = false }: { initialMessages: any[]; agents: any[]; sendable?: boolean }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [messages, setMessages] = useState<any[]>(initialMessages);
    const [participants, setParticipants] = useState<any[]>([]);
    const [draft, setDraft] = useState("");
    const [isSending, setIsSending] = useState(false);
    const [mentionOpen, setMentionOpen] = useState(false);
    const mentionRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (mentionRef.current && !mentionRef.current.contains(e.target as Node)) {
                setMentionOpen(false);
            }
        };
        document.addEventListener("mousedown", handler);
        return () => document.removeEventListener("mousedown", handler);
    }, []);
    const [unreadCount, setUnreadCount] = useState(0);
    const [lastSeenAt, setLastSeenAt] = useState<string | null>(
        initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].createdAt : null
    );
    const [isAtBottom, setIsAtBottom] = useState(true);

    useEffect(() => {
        setMessages(initialMessages);
        setLastSeenAt(initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].createdAt : null);
    }, [initialMessages]);

    useEffect(() => {
        const fetchUpdates = async () => {
            try {
                const url = lastSeenAt ? `/api/chat?since=${encodeURIComponent(lastSeenAt)}` : "/api/chat";
                const res = await fetch(url);
                if (!res.ok) return;
                const data = await res.json();
                if (data.participants) {
                    setParticipants(data.participants);
                }
                if (data.messages && data.messages.length > 0) {
                    setMessages((prev) => {
                        const existingIds = new Set(prev.map((m) => m.id));
                        const newMessages = data.messages.filter((m: any) => !existingIds.has(m.id));
                        if (newMessages.length === 0) return prev;
                        return [...prev, ...newMessages];
                    });
                    const latest = data.messages[data.messages.length - 1];
                    setLastSeenAt((prevLast) => {
                        return new Date(latest.createdAt).getTime() > new Date(prevLast || 0).getTime()
                            ? latest.createdAt
                            : prevLast;
                    });
                    if (!isAtBottom) {
                        setUnreadCount((c) => c + data.messages.length);
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
        if (scrollRef.current && isAtBottom) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            setUnreadCount(0);
        }
    }, [messages, isAtBottom]);

    const handleScroll = () => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
        const atBottom = scrollTop + clientHeight >= scrollHeight - 10;
        setIsAtBottom(atBottom);
        if (atBottom) setUnreadCount(0);
    };

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
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
            const data = await res.json();
            if (data.message) {
                setMessages((prev) => prev.some((m) => m.id === data.message.id) ? prev : [...prev, data.message]);
                setLastSeenAt(data.message.createdAt);
            }
        } catch (err) {
            console.error("Failed to send team message", err);
            setDraft(text);
        } finally {
            setIsSending(false);
        }
    };

    const getAgentName = (id: string | null) => {
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
        if (p.participantType === "agent" && p.lastReadAt) {
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
                    <div className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500" />
                    <span className="text-xs font-medium uppercase tracking-tight text-zinc-500">Live Feed</span>
                </div>
            </div>

            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 space-y-4 overflow-y-auto p-4">
                {messages.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm italic text-zinc-600">No communications yet.</div>
                ) : (
                    messages.map((msg) => {
                        const msgTime = new Date(msg.createdAt).getTime();
                        const readByAgents = msg.senderType === "human"
                            ? Object.entries(agentReadTimes)
                                .filter(([, t]) => t >= msgTime)
                                .map(([id]) => ({ id, name: getAgentName(id) }))
                            : [];

                        return (
                            <div key={msg.id} className={`flex space-x-3 ${msg.senderType === "human" ? "flex-row-reverse space-x-reverse" : ""}`}>
                                <div className={`flex h-8 w-8 flex-shrink-0 items-center justify-center overflow-hidden rounded-full border ${msg.senderType === "human" ? "border-zinc-700 bg-zinc-800/80" : "border-indigo-500/20 bg-indigo-500/10"}`}>
                                    {msg.senderType === "human" ? (
                                        <User className="h-4 w-4 text-zinc-400" />
                                    ) : (
                                        <img
                                            src={agents.find((a) => a.id === (msg.fromUserId || msg.senderId))?.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(msg.fromUserId || msg.senderId || "agent")}`}
                                            className="h-full w-full object-cover"
                                            alt=""
                                        />
                                    )}
                                </div>
                                <div className="flex flex-col items-end max-w-[85%]">
                                    <div className={`w-full rounded-2xl border px-4 py-2.5 text-sm ${msg.senderType === "human" ? "rounded-tr-none border-zinc-700/50 bg-zinc-800/50 text-zinc-200" : "rounded-tl-none border-zinc-800/50 bg-zinc-800/30 text-zinc-300"}`}>
                                        <div className={`mb-1 flex justify-between text-[10px] font-medium uppercase tracking-wider ${msg.senderType === "human" ? "text-zinc-500" : "text-indigo-400"}`}>
                                            <span>{msg.senderType === "human" ? "Human Manager" : getAgentName(msg.fromUserId || msg.senderId)}</span>
                                            <span className="px-2 text-zinc-600">{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                                        </div>
                                        <ParsedMessage text={msg.text} />
                                    </div>
                                    {readByAgents.length > 0 && (
                                        <div className="mt-1 flex items-center gap-1 px-1">
                                            <div className="flex -space-x-1">
                                                {readByAgents.slice(0, 3).map(a => (
                                                    <img
                                                        key={a.id}
                                                        src={agents.find(ag => ag.id === a.id)?.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(a.id)}`}
                                                        title={a.name}
                                                        className="h-3.5 w-3.5 rounded-full border border-zinc-900 object-cover"
                                                        alt={a.name}
                                                    />
                                                ))}
                                            </div>
                                            <span className="text-[10px] font-medium text-indigo-500">
                                                {readByAgents.length === 1 ? `Read by ${readByAgents[0].name}` : `Read by ${readByAgents.length} agents`}
                                            </span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {typingAgents.length > 0 && (
                <div className="flex items-center gap-2 border-t border-zinc-800/60 px-4 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
                    <div className="flex gap-1">
                        <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.3s]" />
                        <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-bounce [animation-delay:-0.15s]" />
                        <div className="h-1.5 w-1.5 rounded-full bg-indigo-500 animate-bounce" />
                    </div>
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                        {typingAgents.length === 1
                            ? `${typingAgents[0].name} is typing`
                            : `${typingAgents.slice(0, -1).map(a => a.name).join(", ")} and ${typingAgents[typingAgents.length - 1].name} are typing`}
                    </span>
                </div>
            )}

            {sendable ? (
                <form onSubmit={handleSend} className="border-t border-zinc-800/80 bg-zinc-900/30 p-3">
                    <div className="flex items-end gap-2">
                        {/* @ mention picker */}
                        <div className="relative shrink-0" ref={mentionRef}>
                            <button
                                type="button"
                                onClick={() => setMentionOpen(v => !v)}
                                title="Mention an agent"
                                className="h-10 w-10 flex items-center justify-center rounded-xl bg-zinc-800 border border-zinc-700 hover:border-indigo-500/50 hover:text-indigo-400 text-zinc-500 transition-colors"
                            >
                                <AtSign className="h-4 w-4" />
                            </button>
                            {mentionOpen && agents.length > 0 && (
                                <div className="absolute bottom-full left-0 mb-2 w-48 bg-zinc-900 border border-zinc-700 rounded-xl shadow-2xl overflow-hidden z-20">
                                    <div className="px-3 py-2 border-b border-zinc-800">
                                        <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Mention agent</span>
                                    </div>
                                    <div className="max-h-48 overflow-y-auto p-1">
                                        {agents.map((agent: any) => (
                                            <button
                                                key={agent.id}
                                                type="button"
                                                onClick={() => {
                                                    setDraft(prev => {
                                                        const trimmed = prev.trimEnd();
                                                        return trimmed ? `${trimmed} @${agent.name} ` : `@${agent.name} `;
                                                    });
                                                    setMentionOpen(false);
                                                }}
                                                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-zinc-800 text-left transition-colors"
                                            >
                                                <div className="relative shrink-0">
                                                    <img
                                                        src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id)}`}
                                                        className="w-6 h-6 rounded-full object-cover"
                                                        alt=""
                                                    />
                                                    <div className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-zinc-900 ${agent.status === "online" ? "bg-emerald-500" : "bg-zinc-600"}`} />
                                                </div>
                                                <span className="text-sm text-zinc-300 truncate">{agent.name}</span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            )}
                        </div>

                        <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                    e.preventDefault();
                                    void handleSend(e as any);
                                }
                            }}
                            placeholder="Message the team… (@ to mention)"
                            rows={1}
                            className="flex-1 resize-none bg-zinc-800 border border-zinc-700 rounded-xl px-4 py-2.5 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:ring-1 focus:ring-indigo-500 max-h-32 overflow-y-auto"
                            style={{ minHeight: "2.5rem" }}
                        />
                        <button
                            type="submit"
                            disabled={!draft.trim() || isSending}
                            className="h-10 w-10 flex-shrink-0 flex items-center justify-center rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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

    const sections = {
        update: text.match(/Update:([\s\S]*?)(?=Evidence:|Next:|$)/i),
        evidence: text.match(/Evidence:([\s\S]*?)(?=Update:|Next:|$)/i),
        next: text.match(/Next:([\s\S]*?)(?=Update:|Evidence:|$)/i),
    };

    if (!sections.update && !sections.evidence && !sections.next) {
        return <ChatMarkdown content={text} accent="indigo" />;
    }

    return (
        <div className="my-2 space-y-4">
            {sections.update && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold uppercase tracking-tighter text-zinc-500">Update</div>
                    <ChatMarkdown content={sections.update[1].trim()} accent="indigo" />
                </div>
            )}
            {sections.evidence && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold uppercase tracking-tighter text-zinc-500">Evidence</div>
                    <div className="rounded border border-zinc-800/50 bg-zinc-950/50 p-3">
                        <ChatMarkdown content={sections.evidence[1].trim()} accent="indigo" compact />
                    </div>
                </div>
            )}
            {sections.next && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold uppercase tracking-tighter text-zinc-500">Next</div>
                    <ChatMarkdown content={sections.next[1].trim()} accent="indigo" />
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
    accent: "indigo" | "emerald";
    compact?: boolean;
}) {
    const accentText = accent === "emerald" ? "[&_.prose_code]:text-emerald-200 [&_.prose_a]:text-emerald-300" : "[&_.prose_code]:text-indigo-300 [&_.prose_a]:text-indigo-300";
    const sizing = compact
        ? "[&_.prose]:text-xs [&_.prose_p]:mb-2 [&_.prose_ul]:mb-2 [&_.prose_ol]:mb-2 [&_.prose_pre]:mb-2"
        : "[&_.prose]:text-sm [&_.prose_p]:mb-3 [&_.prose_ul]:mb-3 [&_.prose_ol]:mb-3 [&_.prose_pre]:mb-3";

    return (
        <MarkdownRenderer
            content={content}
            className={`[&_.prose]:max-w-none [&_.prose]:leading-relaxed [&_.prose_p:first-child]:mt-0 [&_.prose_p:last-child]:mb-0 [&_.prose_pre]:bg-zinc-950/70 [&_.prose_pre]:border-zinc-800/80 ${sizing} ${accentText}`}
        />
    );
}
