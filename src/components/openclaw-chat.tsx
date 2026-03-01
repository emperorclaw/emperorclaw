"use client";

import { useState, useEffect, useRef } from "react";
import { MessageSquare, X, Send, Bot, User } from "lucide-react";
import { cn } from "@/lib/utils";

export function OpenClawChat() {
    const [isOpen, setIsOpen] = useState(false);
    const [message, setMessage] = useState("");
    const [history, setHistory] = useState<any[]>([]);
    const [unreadCount, setUnreadCount] = useState(0);
    const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);
    const [initialized, setInitialized] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const baseTitleRef = useRef<string | null>(null);

    // Fetch history and poll
    useEffect(() => {
        const fetchHistory = async () => {
            try {
                const url = lastSeenAt ? `/api/chat?since=${encodeURIComponent(lastSeenAt)}` : '/api/chat';
                const res = await fetch(url);
                if (!res.ok) return;
                const data = await res.json();
                if (data.messages && data.messages.length > 0) {
                    setHistory((prev) => (lastSeenAt ? [...prev, ...data.messages] : data.messages));
                    const latest = data.messages[data.messages.length - 1];
                    setLastSeenAt(latest.createdAt);
                    if (initialized && !isOpen) {
                        const newAgentMessages = data.messages.filter((m: any) => m.senderType === 'agent').length;
                        if (newAgentMessages > 0) {
                            setUnreadCount((c) => c + newAgentMessages);
                        }
                    }
                }
                if (!initialized) setInitialized(true);
            } catch (err) {
                console.error("Failed to load chat history", err);
            }
        };
        fetchHistory();

        const interval = setInterval(fetchHistory, 5000); // Poll every 5 seconds
        return () => clearInterval(interval);
    }, [isOpen, lastSeenAt, initialized]);

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
    }, [unreadCount]);

    useEffect(() => {
        if (isOpen) {
            setUnreadCount(0);
        }
    }, [isOpen]);

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!message.trim()) return;

        const optimisticMsg = { id: Date.now(), senderType: 'human', text: message };
        setHistory(prev => [...prev, optimisticMsg]);
        const textToSend = message;
        setMessage("");

        try {
            await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: textToSend })
            });
            // The polling interval will grab the real message from DB shortly.
        } catch (e) {
            console.error("Failed to send message", e);
        }
    };

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
                <div className="fixed bottom-6 right-6 w-96 h-[500px] bg-zinc-950 border border-zinc-800 shadow-2xl rounded-2xl flex flex-col z-50 animate-in slide-in-from-bottom-5 fade-in duration-200 overflow-hidden">
                    {/* Header */}
                    <div className="flex items-center justify-between p-4 border-b border-zinc-800 bg-zinc-900/50">
                        <div className="flex items-center space-x-3">
                            <div className="w-8 h-8 rounded-full bg-indigo-500/20 flex items-center justify-center border border-indigo-500/30">
                                <Bot className="w-4 h-4 text-indigo-400" />
                            </div>
                            <div className="flex flex-col">
                                <span className="text-sm font-semibold text-zinc-100 leading-tight">OpenClaw Base</span>
                                <span className="text-[10px] text-zinc-500 flex items-center space-x-1">
                                    <div className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                                    <span>Online</span>
                                </span>
                            </div>
                        </div>
                        <button
                            onClick={() => setIsOpen(false)}
                            className="p-1.5 rounded-md hover:bg-zinc-800 text-zinc-500 transition-colors"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>

                    {/* Chat History */}
                    <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4">
                        {history.map(msg => (
                            <div key={msg.id} className={cn("flex", msg.senderType === 'human' ? "justify-end" : "justify-start")}>
                                <div
                                    className={cn(
                                        "max-w-[80%] rounded-2xl px-4 py-2 text-sm",
                                        msg.senderType === 'human'
                                            ? "bg-indigo-600 text-white rounded-br-sm"
                                            : "bg-zinc-800 text-zinc-200 rounded-bl-sm"
                                    )}
                                >
                                    {msg.text}
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Input Area */}
                    <form onSubmit={handleSend} className="p-4 border-t border-zinc-800 bg-zinc-900/30 flex items-center space-x-2">
                        <input
                            type="text"
                            value={message}
                            onChange={(e) => setMessage(e.target.value)}
                            placeholder="Message OpenClaw Manager..."
                            className="flex-1 bg-zinc-950 border border-zinc-800 rounded-full px-4 py-2 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
                        />
                        <button
                            type="submit"
                            disabled={!message.trim()}
                            className="p-2 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                            <Send className="w-4 h-4" />
                        </button>
                    </form>
                </div>
            )}
        </>
    );
}
