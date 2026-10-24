"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
    CLOSE_TOO_MANY_SOCKETS, HEARTBEAT_INTERVAL_MS, INVALIDATE_THROTTLE_MS, REALTIME_FALLBACK_POLL_MS,
    createLivePoller, isSocketStale, nextReconnectDelay, parseServerMessage, topicsIntersect, wsUrlFor,
    type LivePoller,
} from "@/lib/realtime-client";

export type RealtimeStatus = "connecting" | "open" | "closed";

type StatusListener = (status: RealtimeStatus) => void;
/** "all" = every subscriber refetches (reconnect, or the server lost its event feed). */
type InvalidateListener = (topics: readonly string[] | "all") => void;

/** How often the watchdog checks the socket (and sends a "ping" when one is due). */
const WATCHDOG_TICK_MS = 5_000;

// One socket per tab, shared by every subscriber. Module singletons so any
// component (chat, dashboard, badges) reuses the same connection.
let socket: WebSocket | null = null;
let status: RealtimeStatus = "closed";
let attempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let lastInboundAt = 0;
let lastPingAt = 0;
let hasOpened = false;
let paused = false;
/** Evicted by the server's per-user socket cap: wait for the tab to be shown again. */
let evicted = false;
let visibilityAttached = false;
const statusListeners = new Set<StatusListener>();
const invalidateListeners = new Set<InvalidateListener>();

function setStatus(next: RealtimeStatus) {
    if (status === next) return;
    status = next;
    for (const listener of statusListeners) listener(next);
}

function emitInvalidate(topics: readonly string[] | "all") {
    for (const listener of invalidateListeners) listener(topics);
}

function clearReconnect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
}

function stopWatchdog() {
    if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
}

function startWatchdog(ws: WebSocket) {
    stopWatchdog();
    lastPingAt = Date.now();
    watchdogTimer = setInterval(() => {
        if (socket !== ws) { stopWatchdog(); return; }
        const now = Date.now();
        if (isSocketStale(lastInboundAt, now)) {
            // The browser can keep a dead TCP connection "open" for minutes:
            // drop it now and reconnect.
            dropSocket(ws);
            return;
        }
        if (ws.readyState === WebSocket.OPEN && now - lastPingAt >= HEARTBEAT_INTERVAL_MS) {
            lastPingAt = now;
            try { ws.send("ping"); } catch { /* onclose follows */ }
        }
    }, WATCHDOG_TICK_MS);
}

/** Forget `ws` at once (its late events are ignored) and reconnect. */
function dropSocket(ws: WebSocket) {
    if (socket !== ws) return;
    socket = null;
    stopWatchdog();
    try { ws.close(); } catch { /* noop */ }
    setStatus("closed");
    scheduleReconnect();
}

function scheduleReconnect() {
    clearReconnect();
    if (paused || evicted || typeof document !== "undefined" && document.visibilityState === "hidden") return;
    reconnectTimer = setTimeout(connect, nextReconnectDelay(attempt++));
}

function connect() {
    if (typeof window === "undefined") return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    clearReconnect();
    setStatus("connecting");
    let ws: WebSocket;
    try {
        ws = new WebSocket(wsUrlFor(window.location));
    } catch {
        scheduleReconnect();
        return;
    }
    socket = ws;
    // Every handler ignores a socket that is no longer the current one, so a
    // late event from a replaced socket never clobbers the live connection.
    ws.onopen = () => {
        if (socket !== ws) return;
        attempt = 0;
        lastInboundAt = Date.now();
        setStatus("open");
        startWatchdog(ws);
        // Events published while we were disconnected are gone: every
        // subscriber refetches once on each reconnect.
        if (hasOpened) emitInvalidate("all");
        hasOpened = true;
    };
    ws.onmessage = (event) => {
        if (socket !== ws) return;
        lastInboundAt = Date.now();
        const message = parseServerMessage(event.data);
        if (!message) return;
        if (message.type === "invalidate") emitInvalidate(message.topics);
        else if (message.type === "resync") emitInvalidate("all");
    };
    ws.onclose = (event) => {
        if (socket !== ws) return;
        socket = null;
        stopWatchdog();
        if (event.code === CLOSE_TOO_MANY_SOCKETS) evicted = true;
        setStatus("closed");
        scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
}

function ensureStarted() {
    if (typeof document !== "undefined" && !visibilityAttached) {
        visibilityAttached = true;
        document.addEventListener("visibilitychange", onVisibility);
    }
    connect();
}

function onVisibility() {
    if (document.visibilityState === "hidden") {
        // Free the server connection while the tab is hidden; reconnect on return.
        paused = true;
        clearReconnect();
        stopWatchdog();
        const ws = socket;
        socket = null;
        if (ws) { try { ws.close(); } catch { /* noop */ } }
        setStatus("closed");
    } else {
        paused = false;
        evicted = false;
        attempt = 0;
        connect();
    }
}

export function getRealtimeStatus(): RealtimeStatus {
    return status;
}

function subscribeStatus(listener: StatusListener): () => void {
    statusListeners.add(listener);
    listener(status);
    return () => statusListeners.delete(listener);
}

function subscribeInvalidate(listener: InvalidateListener): () => void {
    invalidateListeners.add(listener);
    return () => invalidateListeners.delete(listener);
}

/**
 * Non-React subscription for module-level stores (nav badges): starts the
 * shared socket and calls `onInvalidate` for any listed topic (or a resync).
 */
export function subscribeRealtimeTopics(topics: readonly string[], onInvalidate: () => void): () => void {
    ensureStarted();
    const topicSet = new Set(topics);
    return subscribeInvalidate((incoming) => {
        if (topicSet.size === 0) return;
        if (incoming === "all" || topicsIntersect(topicSet, incoming)) onInvalidate();
    });
}

/** Non-React status subscription; the listener is called at once with the current status. */
export function subscribeRealtimeStatus(listener: (status: RealtimeStatus) => void): () => void {
    ensureStarted();
    return subscribeStatus(listener);
}

/**
 * Subscribe to a set of realtime topics and run `onInvalidate` whenever an
 * invalidation mentions one of them. Returns the connection status so pollers
 * can switch between fast (socket down) and slow fallback (socket up) timers.
 */
export function useRealtimeTopics(topics: readonly string[], onInvalidate: () => void): { status: RealtimeStatus } {
    const topicKey = useMemo(() => [...new Set(topics)].sort().join("\u0000"), [topics]);
    const topicSet = useMemo(() => new Set(topicKey ? topicKey.split("\u0000") : []), [topicKey]);
    const onInvalidateRef = useRef(onInvalidate);
    useEffect(() => { onInvalidateRef.current = onInvalidate; }, [onInvalidate]);

    const [state, setState] = useState<RealtimeStatus>(() => getRealtimeStatus());

    useEffect(() => {
        ensureStarted();
        const unsubStatus = subscribeStatus(setState);
        const unsubInvalidate = subscribeInvalidate((incoming) => {
            if (topicSet.size === 0) return;
            if (incoming === "all" || topicsIntersect(topicSet, incoming)) onInvalidateRef.current();
        });
        return () => { unsubStatus(); unsubInvalidate(); };
    }, [topicSet]);

    return { status: state };
}

/** Connection status only, for surfaces that just need to slow their fallback timer. */
export function useRealtimeStatus(): { status: RealtimeStatus } {
    const [state, setState] = useState<RealtimeStatus>(() => getRealtimeStatus());
    useEffect(() => {
        ensureStarted();
        return subscribeStatus(setState);
    }, []);
    return { status: state };
}

/**
 * A server-component surface: `router.refresh()` whenever a listed topic is
 * invalidated, at most once per `intervalMs` (trailing).
 */
export function RealtimeRefresh({ topics, intervalMs = INVALIDATE_THROTTLE_MS }: { topics: readonly string[]; intervalMs?: number }) {
    const router = useRouter();
    const lastRef = useRef(0);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);
    const refresh = useCallback(() => {
        const now = Date.now();
        if (now - lastRef.current >= intervalMs) {
            lastRef.current = now;
            router.refresh();
            return;
        }
        // Coalesce a burst into one trailing refresh.
        if (timerRef.current) return;
        timerRef.current = setTimeout(() => {
            timerRef.current = null;
            lastRef.current = Date.now();
            router.refresh();
        }, intervalMs - (now - lastRef.current));
    }, [router, intervalMs]);
    useRealtimeTopics(topics, refresh);
    return null;
}

/** Passed to every load: `active` turns false once the poll is stopped (unmount or reset). */
export type LivePollRun = { readonly active: boolean };

export type LivePollOptions = {
    /** Timer delay while the socket is down; a function is read on every schedule. */
    fastMs: number | (() => number);
    /** Timer delay while the socket is up (never below fastMs). */
    slowMs?: number;
    /** Invalidation topics that trigger a (throttled) load. */
    topics?: readonly string[];
    /** false = no timer, no subscription. */
    enabled?: boolean;
    /** Load at start (default true); read once per start. */
    immediate?: boolean | (() => boolean);
    /** The load run at start instead of `load` (e.g. a reset + first page); implies immediate. */
    first?: (run: LivePollRun) => unknown;
    /** The poll restarts (and `first` runs again) whenever this changes. */
    resetKey?: unknown;
    /** Trailing throttle for invalidation-triggered loads. */
    throttleMs?: number;
};

const NO_TOPICS: readonly string[] = [];

/**
 * A live poll that owns one timer: fast while the realtime socket is down,
 * slow while it is up (re-armed the moment that changes), a load at once on an
 * invalidation of `topics` (throttled, trailing), never two loads in flight,
 * paused while the tab is hidden and run at once when it is shown again.
 * `load` and the options may change every render; the latest are used.
 */
export function useLivePoll(load: (run: LivePollRun) => unknown, options: LivePollOptions): { status: RealtimeStatus; pollNow: () => void } {
    const loadRef = useRef(load);
    const optionsRef = useRef(options);
    useEffect(() => {
        loadRef.current = load;
        optionsRef.current = options;
    });
    const pollerRef = useRef<LivePoller | null>(null);
    const enabled = options.enabled ?? true;
    const throttleMs = options.throttleMs ?? INVALIDATE_THROTTLE_MS;
    const { status } = useRealtimeTopics(enabled ? options.topics ?? NO_TOPICS : NO_TOPICS, () => pollerRef.current?.invalidate());

    useEffect(() => {
        if (!enabled) return;
        const run = { active: true };
        const poller = createLivePoller({
            run: () => loadRef.current(run),
            delayMs: (connected) => {
                const current = optionsRef.current;
                const fast = typeof current.fastMs === "function" ? current.fastMs() : current.fastMs;
                return connected ? Math.max(fast, current.slowMs ?? REALTIME_FALLBACK_POLL_MS) : fast;
            },
            throttleMs,
            isHidden: () => document.visibilityState === "hidden",
        });
        poller.setConnected(getRealtimeStatus() === "open");
        pollerRef.current = poller;
        const current = optionsRef.current;
        const first = current.first;
        const immediate = first ? true : typeof current.immediate === "function" ? current.immediate() : current.immediate ?? true;
        poller.start({ immediate, first: first ? () => first(run) : undefined });
        const onVisibility = () => {
            if (document.visibilityState === "hidden") poller.pause();
            else poller.pollNow();
        };
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            run.active = false;
            poller.stop();
            if (pollerRef.current === poller) pollerRef.current = null;
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [enabled, options.resetKey, throttleMs]);

    useEffect(() => {
        pollerRef.current?.setConnected(status === "open");
    }, [status]);

    const pollNow = useCallback(() => pollerRef.current?.pollNow(), []);
    return { status, pollNow };
}
