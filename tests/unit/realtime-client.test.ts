import test from "node:test";
import assert from "node:assert/strict";
import {
    createLivePoller, HEARTBEAT_INTERVAL_MS, HEARTBEAT_STALE_MS, isSocketStale, nextReconnectDelay, parseServerMessage,
    RECONNECT_BASE_MS, RECONNECT_MAX_MS, topicsIntersect, wsUrlFor, type LivePollerClock,
} from "../../src/lib/realtime-client";

test("nextReconnectDelay: first attempt stays within [base/2, base]", () => {
    for (const random of [() => 0, () => 0.5, () => 1]) {
        const delay = nextReconnectDelay(0, RECONNECT_BASE_MS, RECONNECT_MAX_MS, random);
        assert.ok(delay >= RECONNECT_BASE_MS / 2, `delay ${delay} below lower bound`);
        assert.ok(delay <= RECONNECT_BASE_MS, `delay ${delay} above upper bound`);
    }
});

test("nextReconnectDelay: grows exponentially and never exceeds the cap", () => {
    let attempt = 0;
    let delay = nextReconnectDelay(attempt, 1000, 30_000, () => 0);
    // With random() === 0 the delay is exactly floor(exp / 2), monotonic in attempt.
    let prev = delay;
    for (attempt = 1; attempt <= 10; attempt++) {
        delay = nextReconnectDelay(attempt, 1000, 30_000, () => 0);
        assert.ok(delay >= prev, `attempt ${attempt} shrank (${prev} -> ${delay})`);
        assert.ok(delay <= RECONNECT_MAX_MS, `attempt ${attempt} exceeded the cap`);
        prev = delay;
    }
    assert.equal(delay, RECONNECT_MAX_MS / 2, "the cap flattens the backoff");
});

test("nextReconnectDelay: jitter spans the full half-open window", () => {
    assert.equal(nextReconnectDelay(2, 1000, 30_000, () => 0), 2000);
    assert.equal(nextReconnectDelay(2, 1000, 30_000, () => 1), 4000);
});

test("wsUrlFor: https becomes wss and http becomes ws", () => {
    assert.equal(wsUrlFor({ protocol: "https:", host: "emp.example.com" }), "wss://emp.example.com/api/ws");
    assert.equal(wsUrlFor({ protocol: "http:", host: "localhost:3000" }), "ws://localhost:3000/api/ws");
});

test("topicsIntersect: any overlap is a hit", () => {
    assert.equal(topicsIntersect(new Set(["inbox"]), ["dashboard", "inbox"]), true);
    assert.equal(topicsIntersect(new Set(["thread:t1"]), ["thread:t1"]), true);
    assert.equal(topicsIntersect(new Set(["thread:t1"]), ["thread:t2", "agents"]), false);
    assert.equal(topicsIntersect(new Set(), ["inbox"]), false);
    assert.equal(topicsIntersect(new Set(["inbox"]), []), false);
});

// ── Dead-socket detection and server frames ──────────────────────────────────

test("isSocketStale: alive within two heartbeats, dead after", () => {
    assert.ok(HEARTBEAT_STALE_MS > HEARTBEAT_INTERVAL_MS * 2, "allows one missed pong plus slack");
    assert.equal(isSocketStale(1_000, 1_000 + HEARTBEAT_INTERVAL_MS), false);
    assert.equal(isSocketStale(1_000, 1_000 + HEARTBEAT_STALE_MS - 1), false);
    assert.equal(isSocketStale(1_000, 1_000 + HEARTBEAT_STALE_MS), true);
    assert.equal(isSocketStale(0, 10_000, 5_000), true);
});

test("parseServerMessage: invalidate, resync, pong; junk is null", () => {
    assert.deepEqual(parseServerMessage(JSON.stringify({ type: "invalidate", topics: ["inbox", 3, "thread:t1"] })), { type: "invalidate", topics: ["inbox", "thread:t1"] });
    assert.equal(parseServerMessage(JSON.stringify({ type: "invalidate", topics: [] })), null);
    assert.deepEqual(parseServerMessage(JSON.stringify({ type: "resync" })), { type: "resync" });
    assert.deepEqual(parseServerMessage(JSON.stringify({ type: "pong" })), { type: "pong" });
    assert.equal(parseServerMessage("pong"), null);
    assert.equal(parseServerMessage("{not json"), null);
    assert.equal(parseServerMessage(JSON.stringify({ type: "other" })), null);
});

// ── Live poller ──────────────────────────────────────────────────────────────

/** A manual clock: timers fire only on advance(); pending promises settle between steps. */
function fakeClock() {
    let now = 0;
    let nextId = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const clock: LivePollerClock = {
        setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
        clearTimeout: (handle) => { timers.delete(handle as number); },
        now: () => now,
    };
    const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
    return {
        clock,
        get pending() { return timers.size; },
        get nextDue() { return Math.min(...[...timers.values()].map((t) => t.at)); },
        async advance(ms: number) {
            const until = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                now = due[1].at;
                timers.delete(due[0]);
                due[1].fn();
                await flush();
            }
            now = until;
            await flush();
        },
        flush,
    };
}

/** A load whose completion the test controls. */
function controlledLoad() {
    let calls = 0;
    const resolvers: (() => void)[] = [];
    return {
        get calls() { return calls; },
        run: () => { calls++; return new Promise<void>((resolve) => resolvers.push(resolve)); },
        finish() { resolvers.shift()?.(); },
    };
}

test("live poller: owns exactly one timer however often it is triggered", async () => {
    const t = fakeClock();
    let calls = 0;
    const poller = createLivePoller({ run: () => { calls++; }, delayMs: (c) => (c ? 30_000 : 3_000), throttleMs: 1_000, clock: t.clock });
    poller.start({ immediate: false });
    assert.equal(t.pending, 1);
    for (let i = 0; i < 20; i++) poller.invalidate();
    await t.flush();
    assert.ok(t.pending <= 1, "invalidations never add timers");
    await t.advance(60_000);
    assert.ok(t.pending <= 1);
    // 20 invalidations collapse into one load, then the 3 s cadence: ~20 loads in 60 s, not 20 parallel chains.
    assert.ok(calls <= 22, `expected one chain, got ${calls} loads`);
    poller.stop();
    assert.equal(t.pending, 0, "stop clears the timer");
    const before = calls;
    await t.advance(60_000);
    assert.equal(calls, before, "a stopped poller never loads again");
});

test("live poller: triggers during a load share it and leave exactly one trailing run", async () => {
    const t = fakeClock();
    const load = controlledLoad();
    const poller = createLivePoller({ run: load.run, delayMs: () => 3_000, throttleMs: 1_000, clock: t.clock });
    poller.start();
    assert.equal(load.calls, 1, "immediate start loads at once");
    poller.invalidate();
    poller.invalidate();
    poller.pollNow();
    await t.flush();
    assert.equal(load.calls, 1, "no second load while one is in flight");
    assert.equal(t.pending, 0);
    await t.advance(500);
    load.finish();
    await t.flush();
    assert.equal(t.pending, 1, "one trailing run is owed");
    await t.advance(500);
    assert.equal(load.calls, 2, "the trailing run fires at the end of the throttle window");
    load.finish();
    await t.flush();
    assert.equal(t.pending, 1);
    assert.equal(t.nextDue, 1_000 + 3_000, "then back to the regular cadence");
});

test("live poller: invalidations are throttled (trailing), not dropped", async () => {
    const t = fakeClock();
    let calls = 0;
    const poller = createLivePoller({ run: () => { calls++; }, delayMs: () => 30_000, throttleMs: 1_000, clock: t.clock });
    poller.start({ immediate: false });
    poller.invalidate();
    await t.flush();
    assert.equal(calls, 1, "the first invalidation loads at once");
    await t.advance(200);
    poller.invalidate();
    poller.invalidate();
    await t.flush();
    assert.equal(calls, 1, "a burst inside the window waits");
    await t.advance(800);
    assert.equal(calls, 2, "one trailing load at the end of the window");
    await t.advance(5_000);
    assert.equal(calls, 2, "nothing more until the fallback timer");
});

test("live poller: a socket status change re-arms the timer at once", async () => {
    const t = fakeClock();
    let calls = 0;
    const poller = createLivePoller({ run: () => { calls++; }, delayMs: (c) => (c ? 30_000 : 3_000), throttleMs: 1_000, clock: t.clock });
    poller.setConnected(true);
    poller.start({ immediate: false });
    assert.equal(t.nextDue, 30_000, "slow while connected");
    await t.advance(10_000);
    poller.setConnected(false);
    assert.equal(t.pending, 1);
    assert.equal(t.nextDue, 10_000 + 3_000, "the stale 30 s timer is replaced by the fast one");
    await t.advance(3_000);
    assert.equal(calls, 1);
    poller.setConnected(true);
    assert.equal(t.nextDue, 13_000 + 30_000, "back to slow once the socket is up");
    poller.setConnected(true);
    assert.equal(t.pending, 1, "an unchanged status does nothing");
});

test("live poller: a status change does not cancel an owed invalidation load", async () => {
    const t = fakeClock();
    let calls = 0;
    const poller = createLivePoller({ run: () => { calls++; }, delayMs: (c) => (c ? 30_000 : 3_000), throttleMs: 1_000, clock: t.clock });
    poller.start({ immediate: false });
    poller.invalidate();
    await t.flush();
    poller.invalidate();
    poller.setConnected(true);
    assert.equal(t.nextDue, 1_000, "the trailing load stays first");
    await t.advance(1_000);
    assert.equal(calls, 2);
    assert.equal(t.nextDue, 1_000 + 30_000);
});

test("live poller: hidden tabs arm nothing; the start load still runs", async () => {
    const t = fakeClock();
    let hidden = true;
    let calls = 0;
    let firstCalls = 0;
    const poller = createLivePoller({ run: () => { calls++; }, delayMs: () => 3_000, clock: t.clock, isHidden: () => hidden });
    poller.start({ first: () => { firstCalls++; } });
    await t.flush();
    assert.equal(firstCalls, 1, "the first load runs even in a background tab");
    assert.equal(t.pending, 0, "but no timer while hidden");
    poller.invalidate();
    await t.flush();
    assert.equal(calls, 0);
    hidden = false;
    poller.pollNow();
    await t.flush();
    assert.equal(calls, 1);
    assert.equal(t.pending, 1);
    hidden = true;
    poller.pause();
    assert.equal(t.pending, 0);
});

test("live poller: a load that lands after stop schedules nothing; errors keep the chain", async () => {
    const t = fakeClock();
    const load = controlledLoad();
    const poller = createLivePoller({ run: load.run, delayMs: () => 3_000, clock: t.clock });
    poller.start();
    poller.stop();
    load.finish();
    await t.flush();
    assert.equal(t.pending, 0);

    let calls = 0;
    const failing = createLivePoller({ run: () => { calls++; throw new Error("offline"); }, delayMs: () => 3_000, clock: t.clock });
    failing.start();
    await t.flush();
    assert.equal(t.pending, 1, "a failed load still re-arms");
    await t.advance(3_000);
    assert.equal(calls, 2);
    failing.stop();
});
