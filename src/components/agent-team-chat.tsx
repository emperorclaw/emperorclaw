"use client";

import { useEffect, useRef, useState } from "react";
import { User } from "lucide-react";
import { MarkdownRenderer } from "@/components/markdown-renderer";

export function AgentTeamChat({ initialMessages = [], agents = [] }: { initialMessages: any[]; agents: any[] }) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const [messages, setMessages] = useState<any[]>(initialMessages);
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

    const getAgentName = (id: string | null) => {
        if (!id) return "System";
        const agent = agents.find((a) => a.id === id);
        return agent ? agent.name : "Unknown Agent";
    };

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
                    messages.map((msg) => (
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
                            <div className={`max-w-[85%] rounded-2xl border px-4 py-2.5 text-sm ${msg.senderType === "human" ? "rounded-tr-none border-zinc-700/50 bg-zinc-800/50 text-zinc-200" : "rounded-tl-none border-zinc-800/50 bg-zinc-800/30 text-zinc-300"}`}>
                                <div className={`mb-1 flex justify-between text-[10px] font-medium uppercase tracking-wider ${msg.senderType === "human" ? "text-zinc-500" : "text-indigo-400"}`}>
                                    <span>{msg.senderType === "human" ? "Human Manager" : getAgentName(msg.fromUserId || msg.senderId)}</span>
                                    <span className="px-2 text-zinc-600">{new Date(msg.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
                                </div>
                                <ParsedMessage text={msg.text} />
                            </div>
                        </div>
                    ))
                )}
            </div>

            <div className="flex items-center justify-center space-x-2 border-t border-zinc-800/80 bg-zinc-900/30 p-3">
                <span className="text-xs font-medium text-zinc-500">Transparency Layer Active (Read-Only)</span>
            </div>
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
