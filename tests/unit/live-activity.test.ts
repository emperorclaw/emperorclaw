import assert from "node:assert/strict";
import test from "node:test";
import {
    clipActivity, formatElapsed, holdActivity, LIVE_ACTIVITY_HOLD_MS, nextTurnStart, visibleActivity,
} from "../../src/lib/live-activity";

test("formatElapsed renders seconds, minutes and hours compactly", () => {
    assert.equal(formatElapsed(0), "0s");
    assert.equal(formatElapsed(-500), "0s");
    assert.equal(formatElapsed(Number.NaN), "0s");
    assert.equal(formatElapsed(4_999), "4s");
    assert.equal(formatElapsed(65_000), "1m 05s");
    assert.equal(formatElapsed(3_600_000 + 2 * 60_000 + 30_000), "1h 02m");
});

test("clipActivity keeps case, collapses whitespace and clips long text", () => {
    assert.equal(clipActivity("  Running  Terminal:\n npm test "), "Running Terminal: npm test");
    assert.equal(clipActivity("   "), null);
    assert.equal(clipActivity(null), null);
    const clipped = clipActivity("x".repeat(300), 10);
    assert.equal(clipped, `${"x".repeat(9)}…`);
});

test("a missed refresh keeps the last activity until the hold expires", () => {
    const t0 = 1_000_000;
    let held = holdActivity(null, "Reading the brief", t0);
    assert.equal(visibleActivity(held, t0), "Reading the brief");

    // Refresh arrives with no activity (server cleared it): keep the old line.
    held = holdActivity(held, null, t0 + 3_000);
    assert.equal(visibleActivity(held, t0 + 3_000), "Reading the brief");
    assert.equal(visibleActivity(held, t0 + LIVE_ACTIVITY_HOLD_MS), "Reading the brief");
    assert.equal(visibleActivity(held, t0 + LIVE_ACTIVITY_HOLD_MS + 1), null);

    // A fresh line replaces it and restarts the hold.
    held = holdActivity(held, "Calling web_search", t0 + 25_000);
    assert.equal(visibleActivity(held, t0 + 40_000), "Calling web_search");
});

test("the turn timer survives refreshes and restarts only for new work", () => {
    let state = nextTurnStart({ startedAt: null, key: null }, { active: true, key: null, now: 100 });
    assert.deepEqual(state, { startedAt: 100, key: null });

    // Typing first, then the prompt flips to acting: same turn, same start.
    state = nextTurnStart(state, { active: true, key: "m1", now: 2_000 });
    assert.deepEqual(state, { startedAt: 100, key: "m1" });

    // A refresh with no key keeps the known prompt.
    state = nextTurnStart(state, { active: true, key: null, now: 3_000 });
    assert.deepEqual(state, { startedAt: 100, key: "m1" });

    // The next queued prompt becomes active: restart.
    state = nextTurnStart(state, { active: true, key: "m2", now: 9_000 });
    assert.deepEqual(state, { startedAt: 9_000, key: "m2" });

    // Work ends: reset, and the next turn starts fresh.
    state = nextTurnStart(state, { active: false, key: null, now: 10_000 });
    assert.deepEqual(state, { startedAt: null, key: null });
    state = nextTurnStart(state, { active: true, key: "m3", now: 12_000 });
    assert.deepEqual(state, { startedAt: 12_000, key: "m3" });
});
