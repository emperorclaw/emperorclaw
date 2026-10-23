"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

const POLL_MS = 20000;

interface NavBadges {
    unreadMessages: number;
    pendingApprovals: number;
    /** What the /inbox page lists as needing you (src/lib/attention.ts). */
    inbox: number;
    /** Something failed: the Inbox badge turns red instead of amber. */
    inboxHasFailures: boolean;
    /** Agents working now (same function as the dashboard's "working now" card). */
    workingNow: number;
}

const INITIAL: NavBadges = { unreadMessages: 0, pendingApprovals: 0, inbox: 0, inboxHasFailures: false, workingNow: 0 };

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
    if ((Object.keys(next) as (keyof NavBadges)[]).every((key) => next[key] === snapshot[key])) return;
    snapshot = next;
    for (const listener of listeners) listener();
}

function isHidden() {
    return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/** Fetch the counts; concurrent callers share the request in flight. A failed poll keeps the last value. */
function refresh(): Promise<void> {
    if (isHidden()) return Promise.resolve();
    if (inFlight) return inFlight;
    inFlight = (async () => {
        try {
            const [res, inboxRes] = await Promise.all([fetch("/api/chat/unread-count"), fetch("/api/inbox/count")]);
            const next = { ...snapshot };
            if (res.ok) next.unreadMessages = (await res.json()).count || 0;
            if (inboxRes.ok) {
                const inbox = await inboxRes.json() as { count?: number; hasFailures?: boolean; approvals?: number; working?: number };
                next.inbox = inbox.count || 0;
                next.inboxHasFailures = inbox.hasFailures === true;
                next.pendingApprovals = inbox.approvals || 0;
                next.workingNow = inbox.working || 0;
            }
            emit(next);
        } catch {
            // Non-critical — badge just stays at its last known value.
        } finally {
            inFlight = null;
        }
    })();
    return inFlight;
}

/** Re-read the badges now, e.g. right after an inline inbox action. */
export async function refreshNavBadges(): Promise<void> {
    // A poll that started before the action may hold the old count: let it
    // land, then read again.
    if (inFlight) await inFlight;
    return refresh();
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

/** Unread messages and the inbox counts for the navigation badges, polled every 20s and on navigation. */
export function useNavBadges(): NavBadges {
    const pathname = usePathname();
    const badges = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    useEffect(() => {
        void refresh();
    }, [pathname]);

    return badges;
}
