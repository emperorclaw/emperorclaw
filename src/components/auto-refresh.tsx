"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { REALTIME_FALLBACK_POLL_MS } from "@/lib/realtime-client";
import { useLivePoll } from "@/lib/use-realtime";

/**
 * The app-wide fallback refresh for server-rendered surfaces (dashboard live
 * workspace, inbox page, projects board). While the realtime socket is up this
 * becomes a slow safety net; when the socket is down it returns to the caller's
 * interval. WS invalidations (see RealtimeRefresh) drive the fresh data.
 */
export function AutoRefresh({ intervalMs = 5000 }: { intervalMs?: number }) {
    const router = useRouter();
    const { pollNow } = useLivePoll(() => {
        if (!document.hidden && navigator.onLine) router.refresh();
    }, { fastMs: intervalMs, slowMs: Math.max(intervalMs, REALTIME_FALLBACK_POLL_MS), immediate: false });

    useEffect(() => {
        window.addEventListener("online", pollNow);
        return () => window.removeEventListener("online", pollNow);
    }, [pollNow]);

    return null;
}
