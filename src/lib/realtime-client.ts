// Pure, framework-free parts of the browser realtime client, unit-tested
// without React or a WebSocket. The stateful singleton and React hook live in
// lib/use-realtime.ts.

/** Base delay for the first reconnect attempt. */
export const RECONNECT_BASE_MS = 1_000;
/** Upper bound for reconnect backoff. */
export const RECONNECT_MAX_MS = 30_000;
/** Heartbeat interval: a plain "ping" frame keeps proxies from idling the socket. */
export const HEARTBEAT_INTERVAL_MS = 20_000;
/**
 * No inbound frame for this long (two heartbeats plus slack: the server answers
 * every "ping" with {"type":"pong"}) means the socket is dead even though the
 * browser still reports it open, e.g. after a laptop sleep or a dropped NAT.
 */
export const HEARTBEAT_STALE_MS = HEARTBEAT_INTERVAL_MS * 2 + 5_000;
/** While the socket is connected, pollers fall back to this slow interval. */
export const REALTIME_FALLBACK_POLL_MS = 30_000;
/** Invalidation-triggered loads run at most once per this window (trailing). */
export const INVALIDATE_THROTTLE_MS = 1_000;

/** Close code the server uses when the session or membership is gone. */
export const CLOSE_SESSION_INVALID = 4401;
/** Close code the server uses when this socket was evicted by the per-user cap. */
export const CLOSE_TOO_MANY_SOCKETS = 4409;

/**
 * Exponential backoff with full jitter, capped at `maxMs`. `attempt` is the
 * number of failed reconnects so far (0 = first retry).
 */
export function nextReconnectDelay(
    attempt: number,
    baseMs: number = RECONNECT_BASE_MS,
    maxMs: number = RECONNECT_MAX_MS,
    random: () => number = Math.random,
): number {
    const exp = Math.min(maxMs, baseMs * 2 ** Math.max(0, Math.floor(attempt)));
    const min = exp / 2;
    return Math.floor(min + random() * (exp - min));
}

/** The WebSocket URL for a path on the current origin (ws: for http:, wss: for https:). */
export function wsUrlFor(location: { protocol: string; host: string }, path: string = "/api/ws"): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}${path}`;
}

/** Whether an incoming invalidation touches any topic the subscriber cares about. */
export function topicsIntersect(subscribed: ReadonlySet<string>, incoming: readonly string[]): boolean {
    return incoming.some((topic) => subscribed.has(topic));
}

/** Whether a socket that last received a frame at `lastInboundAt` should be treated as dead. */
export function isSocketStale(lastInboundAt: number, now: number, staleMs: number = HEARTBEAT_STALE_MS): boolean {
    return now - lastInboundAt >= staleMs;
}

/** Server message types the browser client understands. */
export type RealtimeServerMessage =
    | { type: "invalidate"; topics: string[] }
    | { type: "resync" }
    | { type: "pong" }
    | { type: "connected" };

/** Parse one server frame; null for anything unknown or malformed. */
export function parseServerMessage(data: unknown): RealtimeServerMessage | null {
    let message: unknown;
    try { message = JSON.parse(String(data)); } catch { return null; }
    if (!message || typeof message !== "object") return null;
    const parsed = message as { type?: unknown; topics?: unknown };
    if (parsed.type === "invalidate" && Array.isArray(parsed.topics)) {
        const topics = parsed.topics.filter((t): t is string => typeof t === "string");
        return topics.length > 0 ? { type: "invalidate", topics } : null;
    }
    if (parsed.type === "resync" || parsed.type === "pong" || parsed.type === "connected") return { type: parsed.type };
    return null;
}

// ── Live poll scheduler ──────────────────────────────────────────────────────

export type LivePollerClock = {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (handle: unknown) => void;
    now: () => number;
};

const defaultClock: LivePollerClock = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
};

export type LivePollerOptions = {
    /** One load. Errors are swallowed here; loads handle their own. */
    run: () => unknown;
    /** The fallback timer delay for the current connection state. */
    delayMs: (connected: boolean) => number;
    /** Trailing throttle for invalidation-triggered loads. */
    throttleMs?: number;
    /** While hidden no timer is armed and no load starts; the owner calls pollNow() on return. */
    isHidden?: () => boolean;
    clock?: LivePollerClock;
};

export type LivePoller = {
    /** Start: run `first` (or `run`) now when `immediate`, otherwise arm the fallback timer. */
    start(options?: { immediate?: boolean; first?: () => unknown }): void;
    /** Stop for good: clears the timer; a load in flight lands but schedules nothing. */
    stop(): void;
    /** Load now (tab shown again, navigation). A load already in flight serves it. */
    pollNow(): void;
    /** A realtime invalidation: load now, or once at the end of the throttle window. */
    invalidate(): void;
    /** Socket opened or dropped: re-arm the timer from now with the new delay. */
    setConnected(connected: boolean): void;
    /** Hidden tab: drop the pending timer (pollNow() resumes). */
    pause(): void;
};

/**
 * A single-timer poller. It owns exactly one timeout, never runs two loads at
 * once (a trigger during a load schedules exactly one trailing run), throttles
 * invalidation bursts, and re-arms at once when the connection state changes,
 * so a 30 s "socket is up" timer never outlives the socket.
 */
export function createLivePoller(options: LivePollerOptions): LivePoller {
    const clock = options.clock ?? defaultClock;
    const throttleMs = options.throttleMs ?? INVALIDATE_THROTTLE_MS;
    const isHidden = options.isHidden ?? (() => false);
    let timer: unknown = null;
    let dueAt = Infinity;
    /** "trailing" = the pending timer is an owed invalidation load, not the fallback. */
    let timerKind: "fallback" | "trailing" = "fallback";
    let inFlight = false;
    let trailing = false;
    let stopped = true;
    let connected = false;
    let lastStartAt = -Infinity;

    const clear = () => {
        if (timer !== null) clock.clearTimeout(timer);
        timer = null;
        dueAt = Infinity;
    };
    const arm = (ms: number, kind: "fallback" | "trailing" = "fallback") => {
        clear();
        if (stopped || isHidden()) return;
        const delay = Math.max(0, ms);
        timerKind = kind;
        dueAt = clock.now() + delay;
        timer = clock.setTimeout(() => {
            timer = null;
            dueAt = Infinity;
            execute(options.run);
        }, delay);
    };
    /** Arm unless the pending timer already fires at least as soon. */
    const armSooner = (ms: number) => {
        if (timer !== null && dueAt <= clock.now() + ms) return;
        arm(ms, "trailing");
    };
    const throttleWait = () => Math.max(0, lastStartAt + throttleMs - clock.now());
    /** `force`: the start load runs even in a hidden tab (the page still needs its first data). */
    const execute = (fn: () => unknown, force = false) => {
        if (stopped || (!force && isHidden())) return;
        if (inFlight) { trailing = true; return; }
        clear();
        inFlight = true;
        lastStartAt = clock.now();
        let result: Promise<unknown>;
        try { result = Promise.resolve(fn()); } catch (error) { result = Promise.reject(error); }
        void result.catch(() => {}).then(() => {
            inFlight = false;
            if (stopped) return;
            if (trailing) {
                trailing = false;
                arm(throttleWait(), "trailing");
            } else {
                arm(options.delayMs(connected));
            }
        });
    };

    return {
        start(startOptions) {
            stopped = false;
            if (startOptions?.immediate ?? true) execute(startOptions?.first ?? options.run, true);
            else arm(options.delayMs(connected));
        },
        stop() {
            stopped = true;
            trailing = false;
            clear();
        },
        pollNow() {
            if (inFlight) return;
            execute(options.run);
        },
        invalidate() {
            if (stopped) return;
            if (inFlight) { trailing = true; return; }
            const wait = throttleWait();
            if (wait === 0) execute(options.run);
            else armSooner(wait);
        },
        setConnected(next) {
            if (next === connected) return;
            connected = next;
            // A load in flight arms with the new state when it lands; an owed
            // invalidation load still runs first.
            if (stopped || inFlight || (timer !== null && timerKind === "trailing")) return;
            arm(options.delayMs(connected));
        },
        pause() {
            clear();
        },
    };
}
