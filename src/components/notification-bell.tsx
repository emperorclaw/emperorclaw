"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
    IconAlertTriangle,
    IconAt,
    IconBell,
    IconChecklist,
    IconHandStop,
    IconRosetteDiscountCheck,
    IconSettings,
    IconUserCheck,
} from "@tabler/icons-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

type Notification = {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    link: string | null;
    readAt: string | null;
    createdAt: string;
};

const KIND_ICON: Record<string, typeof IconBell> = {
    mention: IconAt,
    decision: IconHandStop,
    approval: IconRosetteDiscountCheck,
    task_assigned: IconUserCheck,
    agent_failed: IconAlertTriangle,
    agent_down: IconAlertTriangle,
    incident: IconChecklist,
};

const POLL_MS = 30_000;

function ago(value: string): string {
    const minutes = Math.round((Date.now() - new Date(value).getTime()) / 60_000);
    if (!Number.isFinite(minutes) || minutes < 1) return "just now";
    if (minutes < 60) return `${minutes}m`;
    if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
    return `${Math.round(minutes / 1440)}d`;
}

/**
 * The in-app inbox: what needs you (mentions, decisions, approvals, tasks
 * assigned to you, agent failures, serious incidents). Polls quietly; the tab
 * title is left alone so the badge is the only signal.
 */
export function NotificationBell({ collapsed }: { collapsed: boolean }) {
    const router = useRouter();
    const [items, setItems] = useState<Notification[]>([]);
    const [unread, setUnread] = useState(0);
    const [open, setOpen] = useState(false);

    const load = useCallback(async () => {
        try {
            const res = await fetch("/api/notifications?limit=30", { cache: "no-store" });
            if (!res.ok) return;
            const data = await res.json() as { notifications: Notification[]; unreadCount: number };
            setItems(data.notifications);
            setUnread(data.unreadCount);
        } catch {
            /* offline or signed out: keep the last state */
        }
    }, []);

    useEffect(() => {
        const first = setTimeout(() => void load(), 0);
        const interval = setInterval(() => {
            if (document.visibilityState === "visible") void load();
        }, POLL_MS);
        return () => {
            clearTimeout(first);
            clearInterval(interval);
        };
    }, [load]);

    const markRead = async (body: { ids?: string[]; all?: boolean }) => {
        await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => {});
        void load();
    };

    const openItem = (item: Notification) => {
        setOpen(false);
        if (!item.readAt) void markRead({ ids: [item.id] });
        if (item.link) router.push(item.link);
    };

    return (
        <DropdownMenu open={open} onOpenChange={(next) => { setOpen(next); if (next) void load(); }}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
                    className={cn(
                        "relative flex w-full cursor-pointer items-center rounded-xl text-sm font-medium text-muted-foreground transition-all duration-200 hover:bg-accent hover:text-foreground",
                        collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
                    )}
                >
                    <IconBell className={cn("h-4 w-4", unread > 0 && "text-cyan-300")} />
                    <span className={cn("flex-1 text-left", collapsed ? "hidden" : "hidden md:inline")}>Notifications</span>
                    {unread > 0 && (
                        <span className={cn(
                            "rounded-full bg-cyan-400 px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-cyan-950",
                            collapsed ? "absolute right-1 top-1" : "min-w-5",
                        )}>
                            {unread > 99 ? "99+" : unread}
                        </span>
                    )}
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent side="right" align="end" sideOffset={12} className="w-[22rem] max-w-[calc(100vw-2rem)] rounded-xl border-zinc-800 bg-zinc-950 p-0 text-zinc-200 shadow-2xl shadow-black/50">
                <div className="flex items-center justify-between border-b border-zinc-800 px-3.5 py-2.5">
                    <span className="text-sm font-semibold text-zinc-100">Notifications</span>
                    <span className="flex items-center gap-1">
                        {unread > 0 && (
                            <button type="button" onClick={() => void markRead({ all: true })} className="rounded-md px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
                                Mark all read
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => { setOpen(false); router.push("/settings?tab=notifications"); }}
                            aria-label="Notification settings"
                            title="Notification settings"
                            className="grid h-7 w-7 place-items-center rounded-md text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                        >
                            <IconSettings className="h-4 w-4" />
                        </button>
                    </span>
                </div>
                <div className="max-h-[60vh] overflow-y-auto p-1">
                    {items.length === 0 && (
                        <div className="px-4 py-10 text-center text-sm text-zinc-500">
                            Nothing needs you right now.
                            <div className="mt-1 text-xs text-zinc-600">Mentions, decisions, approvals, and failures show up here.</div>
                        </div>
                    )}
                    {items.map((item) => {
                        const Icon = KIND_ICON[item.kind] ?? IconBell;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => openItem(item)}
                                className={cn(
                                    "flex w-full items-start gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-zinc-900",
                                    !item.readAt && "bg-cyan-400/[0.04]",
                                )}
                            >
                                <span className={cn(
                                    "mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg",
                                    item.kind === "agent_failed" || item.kind === "agent_down" || item.kind === "incident" ? "bg-rose-500/10 text-rose-300" : "bg-zinc-800 text-zinc-400",
                                )}>
                                    <Icon className="h-4 w-4" />
                                </span>
                                <span className="min-w-0 flex-1">
                                    <span className={cn("line-clamp-2 text-sm leading-snug", item.readAt ? "text-zinc-400" : "font-medium text-zinc-100")}>{item.title}</span>
                                    {item.body && <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-zinc-500">{item.body}</span>}
                                </span>
                                <span className="flex shrink-0 flex-col items-end gap-1.5">
                                    <span className="text-[10px] text-zinc-600">{ago(item.createdAt)}</span>
                                    {!item.readAt && <span className="h-2 w-2 rounded-full bg-cyan-400" aria-label="Unread" />}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
