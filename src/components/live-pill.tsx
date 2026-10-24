"use client";

import { cn } from "@/lib/utils";
import { livePillCopy } from "@/lib/agent-visibility";
import { useRealtimeStatus } from "@/lib/use-realtime";

/**
 * A small "● Live" pill that replaces the polling countdown now that the UI is
 * live over WebSockets. While the socket is open it shows a steady "Live"; once
 * it is connecting or closed it shows the reconnecting fallback ("refreshing
 * every N s", the real fallback interval of the surface).
 */
export function LivePill({ fallbackSeconds = 15, className }: { fallbackSeconds?: number; className?: string }) {
    const { status } = useRealtimeStatus();
    const copy = livePillCopy(status, fallbackSeconds);
    return (
        <span className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium tabular-nums ring-1 ring-inset",
            copy.live ? "bg-emerald-500/10 text-emerald-700 ring-emerald-500/25 dark:text-emerald-300" : "bg-amber-500/10 text-amber-700 ring-amber-500/25 dark:text-amber-300",
            className,
        )}>
            <span className={cn("h-1.5 w-1.5 rounded-full", copy.live ? "bg-emerald-500" : "bg-amber-500")} aria-hidden="true" />
            <span aria-hidden="true">{copy.label}</span>
            <span role="status" className="sr-only">{copy.live ? "Live" : "Reconnecting"}</span>
        </span>
    );
}
