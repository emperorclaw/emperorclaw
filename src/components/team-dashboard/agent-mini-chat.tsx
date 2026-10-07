"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IconSend } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

type MiniMessage = {
    id: string;
    senderType: "human" | "agent" | "system" | string;
    text: string;
    createdAt: string;
};

const PAGE = 6;
const POLL_MS = 3000;

/**
 * Compact direct chat for the selected-agent card. Reuses the same endpoints
 * as the full direct chat (`GET /api/chat?targetAgentId=…`, `POST /api/chat`)
 * so it never invents an API. Shows the last few messages with a one-line
 * composer and the same 3s polling cadence.
 */
export function AgentMiniChat({ agentId, agentName }: { agentId: string; agentName: string }) {
    const [messages, setMessages] = useState<MiniMessage[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    const [sending, setSending] = useState(false);
    const listRef = useRef<HTMLDivElement>(null);

    // One fetch path for polling and post-send refresh; ignores responses that
    // land after unmount (the card is keyed per agent, so a switch remounts).
    const aliveRef = useRef(true);
    const load = useCallback(async () => {
        try {
            const res = await fetch(`/api/chat?${new URLSearchParams({ targetAgentId: agentId, limit: String(PAGE) })}`);
            if (!res.ok) throw new Error("Failed to load messages");
            const data = (await res.json()) as { messages?: MiniMessage[] };
            if (!aliveRef.current) return;
            if (data.messages) setMessages(data.messages);
            setError(null);
        } catch (err) {
            if (aliveRef.current) setError(err instanceof Error ? err.message : "Failed to load messages");
        } finally {
            if (aliveRef.current) setLoading(false);
        }
    }, [agentId]);

    useEffect(() => {
        aliveRef.current = true;
        void load();
        const interval = setInterval(() => void load(), POLL_MS);
        return () => { aliveRef.current = false; clearInterval(interval); };
    }, [load]);

    useEffect(() => {
        const el = listRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

    const sendingRef = useRef(false);
    const send = async () => {
        const text = draft.trim();
        // The ref blocks a double Enter in the same tick, before state updates land.
        if (!text || sendingRef.current) return;
        sendingRef.current = true;
        setSending(true);
        setDraft("");
        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text, targetAgentId: agentId, attachments: [] }),
            });
            if (!res.ok) {
                const data = (await res.json().catch(() => ({}))) as { error?: string };
                throw new Error(data.error || "Failed to send");
            }
            const data = (await res.json()) as { message?: MiniMessage };
            if (aliveRef.current && data.message) setMessages((prev) => (prev.some((m) => m.id === data.message!.id) ? prev : [...prev, data.message!]));
            void load();
        } catch (err) {
            if (aliveRef.current) {
                setDraft(text);
                setError(err instanceof Error ? err.message : "Failed to send");
            }
        } finally {
            sendingRef.current = false;
            if (aliveRef.current) setSending(false);
        }
    };

    return (
        <div className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-muted/20 dark:bg-white/[0.02]">
            <div className="flex items-center justify-between gap-2 border-b border-border/70 px-3 py-1.5">
                <span className="text-xs font-semibold text-foreground">Chat with {agentName}</span>
                <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Direct</span>
            </div>

            {loading ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground animate-pulse">Loading messages…</div>
            ) : error && messages.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-rose-500">{error}</div>
            ) : messages.length === 0 ? (
                <div className="px-3 py-4 text-center text-xs text-muted-foreground">No messages yet. Say hi.</div>
            ) : (
                <div ref={listRef} className="max-h-44 space-y-2 overflow-y-auto px-3 py-2">
                    {messages.map((m) => {
                        const human = m.senderType === "human";
                        return (
                            <div key={m.id} className={cn("flex", human ? "justify-end" : "justify-start")}>
                                <div className={cn("max-w-[85%] rounded-lg px-2.5 py-1.5 text-xs leading-4", human ? "bg-emerald-500 text-emerald-950" : "bg-zinc-800/90 text-zinc-100")}>
                                    {m.text}
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}

            {error && messages.length > 0 && <div className="px-3 pb-1 text-[10px] text-rose-500">{error}</div>}

            <form className="flex items-center gap-1.5 border-t border-border/70 p-2" onSubmit={(e) => { e.preventDefault(); void send(); }}>
                <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={`Message ${agentName}…`}
                    aria-label={`Message ${agentName}`}
                    className="min-w-0 flex-1 rounded-lg border border-border bg-background/70 px-2.5 py-1.5 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-cyan-400/60 focus:ring-1 focus:ring-cyan-400/30"
                />
                <button type="submit" disabled={sending || !draft.trim()} aria-label="Send"
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-cyan-500/15 text-cyan-700 ring-1 ring-inset ring-cyan-500/40 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-40 dark:text-cyan-200">
                    <IconSend className="h-3.5 w-3.5" />
                </button>
            </form>
        </div>
    );
}
