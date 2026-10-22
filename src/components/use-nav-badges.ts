"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

const POLL_MS = 20000;

interface NavBadges {
    unreadMessages: number;
    pendingApprovals: number;
}

const INITIAL: NavBadges = { unreadMessages: 0, pendingApprovals: 0 };

/**
 * One poller shared by every badge consumer (sidebar and mobile tab bar):
 * started by the first subscriber, stopped by the last, paused while the tab
 * is hidden and refreshed as soon as it becomes visible again.
 */
let snapshot: NavBadges = INITIAL;
const listeners = new Set<() => void>();
let interval: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

function emit(next: NavBadges) {
    if (next.unreadMessages === snapshot.unreadMessages && next.pendingApprovals === snapshot.pendingApprovals) return;
    snapshot = next;
    for (const listener of listeners) listener();
}

function isHidden() {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Fetch both counts; concurrent callers share the request in flight. A failed poll keeps the last value. */
function refresh(): Promise<void> {
    if (isHidden()) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const [res, approvalsRes] = await Promise.all([fetch("/api/chat/unread-count"), fetch("/api/approvals/pending-count")]);
            const next = { ...snapshot };
            if (res.ok) next.unreadMessages = (await res.json()).count || 0;
            if (approvalsRes.ok) next.pendingApprovals = (await approvalsRes.json()).count || 0;
            emit(next);
        } catch {
            // Non-critical — badge just stays at its last known value.
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

function onVisibilityChange() {
    if (!isHidden()) void refresh();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        void refresh();
        interval = setInterval(() => void refresh(), POLL_MS);
        document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            if (interval) clearInterval(interval);
            interval = null;
            document.removeEventListener("visibilitychange", onVisibilityChange);
        }
    };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => INITIAL;

/** Unread messages and pending approvals for the navigation badges, polled every 20s and on navigation. */
export function useNavBadges(): NavBadges {
    const pathname = usePathname();
    const badges = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    useEffect(() => {
        void refresh();
    }, [pathname]);

    return badges;
}
