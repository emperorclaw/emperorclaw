"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { IconMessageCircle } from "@tabler/icons-react";
import { timeAgo } from "@/lib/team-scene";
import { AgentAvatar } from "./agent-character";

type Conversation = {
    threadId: string;
    counterpart: { id: string; name: string; avatarUrl: string | null } | null;
    lastMessageText: string | null;
    lastMessageAt: string | null;
    relatedTaskId: string | null;
};

/**
 * The selected agent's active pair threads, owners/admins only. Lazily fetched
 * from the role-checked /api/agents/[id]/conversations endpoint; each row opens
 * the read-only pair thread in Messages.
 */
export function AgentConversations({ agentId }: { agentId: string }) {
    const [conversations, setConversations] = useState<Conversation[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/agents/${agentId}/conversations`)
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((data: { conversations?: Conversation[] }) => {
                if (!cancelled) setConversations(data.conversations ?? []);
            })
            .catch(() => {
                if (!cancelled) setConversations([]);
            });
        return () => {
            cancelled = true;
        };
    }, [agentId]);

    if (conversations === null) {
        return <div className="mt-3 rounded-xl border border-border/80 bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground animate-pulse dark:bg-white/[0.02]">Loading conversations…</div>;
    }
    if (conversations.length === 0) return null;

    return (
        <div className="mt-3">
            <div className="mb-1.5 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                <IconMessageCircle className="h-3.5 w-3.5" /> Conversations
            </div>
            <ul className="space-y-1">
                {conversations.map((c) => (
                    <li key={c.threadId}>
                        <Link href={`/messages?group=${c.threadId}`} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition hover:bg-muted/60">
                            {c.counterpart ? (
                                <AgentAvatar id={c.counterpart.id} kind="agent" name={c.counterpart.name} avatarUrl={c.counterpart.avatarUrl} status="idle" size={28} />
                            ) : (
                                <span className="grid h-7 w-7 place-items-center rounded-md bg-muted text-muted-foreground" />
                            )}
                            <span className="min-w-0 flex-1">
                                <span className="block truncate text-xs font-medium text-foreground">{c.counterpart?.name ?? "Agent"}</span>
                                <span className="block truncate text-[11px] text-muted-foreground">{c.lastMessageText ?? "No messages yet"}</span>
                            </span>
                            {c.lastMessageAt && <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{timeAgo(c.lastMessageAt, new Date())}</span>}
                        </Link>
                    </li>
                ))}
            </ul>
        </div>
    );
}
