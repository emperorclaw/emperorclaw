import { test } from "node:test";
import assert from "node:assert/strict";
import {
    DEFAULT_STALL_SWEEP_HOURS,
    escalationText,
    groupStallTasks,
    MAX_STALL_TASK_LINES,
    nudgeText,
    stallMaxAgeDays,
    stallStage,
    stallSweepHours,
} from "../../src/lib/stall-sweep";

const H = 3_600_000; // one hour in ms

test("stallSweepHours reads the environment safely", () => {
    assert.equal(stallSweepHours({}), DEFAULT_STALL_SWEEP_HOURS);
    assert.equal(stallSweepHours({ EMPEROR_STALL_SWEEP_HOURS: "2" }), 2);
    assert.equal(stallSweepHours({ EMPEROR_STALL_SWEEP_HOURS: "0" }), DEFAULT_STALL_SWEEP_HOURS);
    assert.equal(stallSweepHours({ EMPEROR_STALL_SWEEP_HOURS: "999" }), DEFAULT_STALL_SWEEP_HOURS);
    assert.equal(stallSweepHours({ EMPEROR_STALL_SWEEP_HOURS: "nope" }), DEFAULT_STALL_SWEEP_HOURS);
});

test("stallStage: fresh tasks get nothing, stale tasks get nudged once", () => {
    const now = 10 * H;
    assert.equal(stallStage(now, now - 1 * H, 4, null, null), "none", "fresh task is not stale");
    assert.equal(stallStage(now, now - 5 * H, 4, null, null), "nudge", "stale, never nudged");
    assert.equal(stallStage(now, now - 5 * H, 4, now - 1 * H, null), "none", "recently nudged, wait");
});

test("stallStage: a still-stale task escalates after another window, then goes quiet", () => {
    const now = 20 * H;
    assert.equal(stallStage(now, now - 10 * H, 4, now - 5 * H, null), "escalate", "nudged, still stale another window later");
    assert.equal(stallStage(now, now - 10 * H, 4, now - 5 * H, now - 1 * H), "none", "already escalated once, never spam");
    assert.equal(stallStage(now, now - 10 * H, 4, now - 5 * H, now - 9 * H), "none", "escalation is one-shot");
});

test("stallMaxAgeDays defaults to 7 and clamps to 1..365", () => {
    assert.equal(stallMaxAgeDays({}), 7);
    assert.equal(stallMaxAgeDays({ EMPEROR_STALL_MAX_AGE_DAYS: "14" }), 14);
    assert.equal(stallMaxAgeDays({ EMPEROR_STALL_MAX_AGE_DAYS: "0" }), 1);
    assert.equal(stallMaxAgeDays({ EMPEROR_STALL_MAX_AGE_DAYS: "-5" }), 1);
    assert.equal(stallMaxAgeDays({ EMPEROR_STALL_MAX_AGE_DAYS: "99999" }), 365);
    assert.equal(stallMaxAgeDays({ EMPEROR_STALL_MAX_AGE_DAYS: "nope" }), 7);
});

test("nudgeText: one task is a single line", () => {
    const text = nudgeText([{ id: "t1", title: "Ship it" }]);
    assert.equal(text, "Your task [Ship it](emperor://task/t1) has not moved in a while. Update it (a note with progress or the blocker), and if you're stuck say so on the task and ask the specific person.");
});

test("nudgeText: many tasks are listed with a follow-up", () => {
    const text = nudgeText([{ id: "a", title: "One" }, { id: "b", title: "Two" }]);
    assert.ok(text.startsWith("These tasks have not moved in a while:\n\n 1. [One](emperor://task/a)\n 2. [Two](emperor://task/b)"));
    assert.ok(text.includes("Update each"));
});

test("nudgeText: more than the cap is truncated with a …and N more line", () => {
    const tasks = Array.from({ length: MAX_STALL_TASK_LINES + 5 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` }));
    const text = nudgeText(tasks);
    const lines = text.split("\n");
    assert.ok(lines.includes("…and 5 more"));
    // 8 numbered rows + the "…and N more" line, never 13 rows.
    assert.ok(lines.filter((l) => /^\s*\d+\.\s/.test(l)).length === MAX_STALL_TASK_LINES);
});

test("escalationText: single and multiple tasks", () => {
    assert.equal(escalationText([{ id: "t1", title: "Ship it" }]), "Escalation: the task [Ship it](emperor://task/t1) is still stale after a nudge. Check on it and reassign or unblock it.");
    const text = escalationText([{ id: "a", title: "One" }, { id: "b", title: "Two" }]);
    assert.ok(text.startsWith("Escalation: these tasks are still stale after a nudge:"));
    assert.ok(text.includes(" 1. [One](emperor://task/a)"));
});

test("groupStallTasks groups by (company, target) and preserves order", () => {
    const groups = groupStallTasks([
        { companyId: "c1", targetKey: "a1", id: "1", title: "One" },
        { companyId: "c1", targetKey: "a1", id: "2", title: "Two" },
        { companyId: "c1", targetKey: "a2", id: "3", title: "Three" },
        { companyId: "c2", targetKey: "a1", id: "4", title: "Four" },
    ]);
    assert.equal(groups.size, 3);
    const same = [...groups.values()].find((g) => g.companyId === "c1" && g.targetKey === "a1")!;
    assert.deepEqual(same.tasks.map((t) => t.id), ["1", "2"]);
});
