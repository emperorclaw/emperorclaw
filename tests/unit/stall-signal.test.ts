import { test } from "node:test";
import assert from "node:assert/strict";
import {
    formatIdle,
    isUsefulRunEventKind,
    lastUsefulAt,
    stallLabel,
    stallSignal,
    STALL_THRESHOLD_MS,
} from "../../src/lib/stall-signal";

const T0 = Date.parse("2026-10-23T10:00:00Z");
const min = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

test("only finished actions count as useful, not thinking or heartbeats", () => {
    for (const kind of ["tool.end", "subagent.end", "approval.auto", "clarify.auto"]) assert.equal(isUsefulRunEventKind(kind), true, kind);
    for (const kind of ["reasoning", "usage", "notice", "status", "tool.start", "tool.progress", "turn.started"]) assert.equal(isUsefulRunEventKind(kind), false, kind);
});

test("lastUsefulAt is the run start when nothing useful happened since", () => {
    const at = lastUsefulAt({
        startedAt: iso(T0),
        runEvents: [
            { kind: "reasoning", ts: iso(T0 + 5 * min) },
            { kind: "usage", ts: iso(T0 + 6 * min) },
            { kind: "tool.start", ts: iso(T0 + 7 * min) },
        ],
    });
    assert.equal(at.getTime(), T0);
});

test("lastUsefulAt takes the newest of tool ends, task changes, messages and approvals", () => {
    const at = lastUsefulAt({
        startedAt: iso(T0),
        runEvents: [{ kind: "tool.end", ts: iso(T0 + 2 * min) }, { kind: "reasoning", ts: iso(T0 + 20 * min) }],
        taskEventsAt: [iso(T0 + 4 * min)],
        messagesAt: [iso(T0 + 3 * min)],
        approvalsAt: [iso(T0 + 9 * min)],
    });
    assert.equal(at.getTime(), T0 + 9 * min);
});

test("signals from before the run started are ignored", () => {
    const at = lastUsefulAt({ startedAt: iso(T0), taskEventsAt: [iso(T0 - 60 * min)], messagesAt: [new Date(T0 - min)] });
    assert.equal(at.getTime(), T0);
});

test("stallSignal flags running work at the threshold, never finished work", () => {
    const fresh = stallSignal({ status: "running", lastUsefulAt: T0, now: T0 + 40_000 });
    assert.deepEqual(fresh && { stalled: fresh.stalled, idleMs: fresh.idleMs }, { stalled: false, idleMs: 40_000 });
    const edge = stallSignal({ status: "running", lastUsefulAt: T0, now: T0 + STALL_THRESHOLD_MS });
    assert.equal(edge?.stalled, true);
    const custom = stallSignal({ status: "running", lastUsefulAt: T0, now: T0 + 6 * min, thresholdMs: 6 * min });
    assert.equal(custom?.stalled, true);
    assert.equal(stallSignal({ status: "succeeded", lastUsefulAt: T0, now: T0 + 60 * min }), null);
    // Clock skew never yields a negative idle time.
    assert.equal(stallSignal({ status: "running", lastUsefulAt: T0 + min, now: T0 })?.idleMs, 0);
    assert.equal(stallSignal({ status: "running", lastUsefulAt: "garbage", now: T0 }), null);
});

test("stall copy reads at a glance", () => {
    assert.equal(formatIdle(40_000), "40s");
    assert.equal(formatIdle(14 * min + 59_000), "14 min");
    assert.equal(formatIdle(125 * min), "2 h 05 min");
    assert.equal(stallLabel({ stalled: true, idleMs: 14 * min }), "No progress for 14 min");
    assert.equal(stallLabel({ stalled: false, idleMs: 40_000 }), "Last useful action 40s ago");
});
