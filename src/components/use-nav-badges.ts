"use client";

import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";
import { createLivePoller, type LivePoller } from "@/lib/realtime-client";
import { subscribeRealtimeStatus, subscribeRealtimeTopics } from "@/lib/use-realtime";

const POLL_MS = 20000;
/** While the realtime socket is up, the poll is only a slow safety net. */
const SLOW_POLL_MS = 30000;

interface NavBadges {
    unreadMessages: number;
    pendingApprovals: number;
    /** Unread items the /inbox page lists as needing you (src/lib/attention.ts); archived ones never count. */
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
let poller: LivePoller | null = null;
let stopRealtime: (() => void) | null = null;
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
    if (isHidden()) poller?.pause();
    else poller?.pollNow();
}

/** Poll now through the shared poller (so its timer restarts), or directly when none is running. */
function pollNow() {
    if (poller) poller.pollNow();
    else void refresh();
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    if (listeners.size === 1) {
        // One timer for every consumer: fast while the socket is down, slow
        // while it is up, an "inbox" invalidation reads the counts at once.
        const current = createLivePoller({ run: refresh, delayMs: (connected) => (connected ? SLOW_POLL_MS : POLL_MS), isHidden });
        poller = current;
        const unsubStatus = subscribeRealtimeStatus((status) => current.setConnected(status === "open"));
        const unsubTopics = subscribeRealtimeTopics(["inbox"], () => current.invalidate());
        stopRealtime = () => { unsubStatus(); unsubTopics(); };
        current.start();
        document.addEventListener("visibilitychange", onVisibilityChange);
    }
    return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
            poller?.stop();
            poller = null;
            stopRealtime?.();
            stopRealtime = null;
            document.removeEventListener("visibilitychange", onVisibilityChange);
        }
    };
}

const getSnapshot = () => snapshot;
const getServerSnapshot = () => INITIAL;

/** Unread messages and the inbox counts for the navigation badges. Invalidation-pushed, with a slow fallback poll. */
export function useNavBadges(): NavBadges {
    const pathname = usePathname();
    const badges = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

    useEffect(() => {
        pollNow();
    }, [pathname]);

    return badges;
}
