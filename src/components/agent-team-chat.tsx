"use client";

import { useEffect, useState, useRef } from "react";
import { Bot, User } from "lucide-react";

export function AgentTeamChat({ initialMessages = [], agents = [] }: { initialMessages: any[], agents: any[] }) {
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
                        const existingIds = new Set(prev.map(m => m.id));
                        const newMessages = data.messages.filter((m: any) => !existingIds.has(m.id));
                        if (newMessages.length === 0) return prev;
                        return [...prev, ...newMessages];
                    });
                    const latest = data.messages[data.messages.length - 1];
                    setLastSeenAt((prevLast) => {
                        // only update lastSeenAt if it's newer to avoid backwards drift
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
        if (scrollRef.current) {
            if (isAtBottom) {
                scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
                setUnreadCount(0);
            }
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
        const agent = agents.find(a => a.id === id);
        return agent ? agent.name : "Unknown Agent";
    };

    return (
        <div className="flex flex-col h-full">
            <div className="p-4 border-b border-zinc-800/80 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                    <h2 className="text-lg font-medium text-zinc-200">Agent Team Chat</h2>
                    {unreadCount > 0 && (
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-500/20 text-rose-300 border border-rose-500/30">
                            {unreadCount} new
                        </span>
                    )}
                </div>
                <div className="flex items-center space-x-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 animate-pulse" />
                    <span className="text-xs text-zinc-500 font-medium tracking-tight uppercase">Live Feed</span>
                </div>
            </div>

            <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-sm text-zinc-600 italic">No communications yet.</div>
                ) : (
                    messages.map((msg) => (
                        <div key={msg.id} className={`flex space-x-3 ${msg.senderType === 'human' ? 'flex-row-reverse space-x-reverse' : ''}`}>
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 border overflow-hidden ${msg.senderType === 'human' ? 'bg-zinc-800/80 border-zinc-700' : 'bg-indigo-500/10 border-indigo-500/20'}`}>
                                {msg.senderType === 'human' ? (
                                    <User className="w-4 h-4 text-zinc-400" />
                                ) : (
                                    <img 
                                        src={agents.find(a => a.id === msg.fromUserId)?.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(msg.fromUserId || 'agent')}`} 
                                        className="w-full h-full object-cover"
                                        alt=""
                                    />
                                )}
                            </div>
                            <div className={`rounded-2xl px-4 py-2.5 max-w-[85%] text-sm ${msg.senderType === 'human' ? 'bg-zinc-800/50 border border-zinc-700/50 rounded-tr-none text-zinc-200' : 'bg-zinc-800/30 border border-zinc-800/50 rounded-tl-none text-zinc-300'}`}>
                                <div className={`text-[10px] font-medium mb-1 tracking-wider uppercase flex justify-between ${msg.senderType === 'human' ? 'text-zinc-500' : 'text-indigo-400'}`}>
                                    <span>{msg.senderType === 'human' ? 'Human Manager' : getAgentName(msg.fromUserId)}</span>
                                    <span className="text-zinc-600 px-2">{new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                </div>
                                <ParsedMessage text={msg.text} />
                            </div>
                        </div>
                    ))
                )}
            </div>

            <div className="p-3 border-t border-zinc-800/80 bg-zinc-900/30 flex items-center justify-center space-x-2">
                <span className="text-xs text-zinc-500 font-medium">Transparency Layer Active (Read-Only)</span>
            </div>
        </div>
    );
}

function ParsedMessage({ text }: { text: string }) {
    if (!text) return null;

    // Detection for structured sections
    const sections = {
        update: text.match(/Update:([\s\S]*?)(?=Evidence:|Next:|$)/i),
        evidence: text.match(/Evidence:([\s\S]*?)(?=Update:|Next:|$)/i),
        next: text.match(/Next:([\s\S]*?)(?=Update:|Evidence:|$)/i)
    };

    if (!sections.update && !sections.evidence && !sections.next) {
        return <div className="whitespace-pre-wrap">{text}</div>;
    }

    return (
        <div className="space-y-4 my-2">
            {sections.update && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Update</div>
                    <div className="text-zinc-200 leading-relaxed">{sections.update[1].trim()}</div>
                </div>
            )}
            {sections.evidence && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Evidence</div>
                    <div className="bg-zinc-950/50 border border-zinc-800/50 rounded p-2 font-mono text-[10px] text-indigo-300 break-all leading-normal group">
                        {sections.evidence[1].trim().split('\n').map((line, i) => {
                            const urlMatch = line.match(/(https?:\/\/[^\s]+)/);
                            if (urlMatch) {
                                return (
                                    <div key={i} className="flex items-center space-x-1">
                                        <span className="text-zinc-600">↳</span>
                                        <a href={urlMatch[1]} target="_blank" rel="noopener noreferrer" className="hover:underline text-indigo-400 truncate">
                                            {urlMatch[1]}
                                        </a>
                                    </div>
                                );
                            }
                            return <div key={i}>{line}</div>;
                        })}
                    </div>
                </div>
            )}
            {sections.next && (
                <div className="space-y-1">
                    <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-tighter">Next</div>
                    <div className="text-zinc-400 italic">
                        {sections.next[1].trim().split('\n').map((line, i) => (
                            <div key={i} className="flex items-start space-x-2">
                                <span className="text-indigo-500 mt-1.5 w-1 h-1 rounded-full bg-indigo-500 shrink-0" />
                                <span>{line.replace(/^[-*]\s*/, '').trim()}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}
