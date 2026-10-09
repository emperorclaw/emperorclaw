import { test } from "node:test";
import assert from "node:assert/strict";
import { localClock, normalizeRoutine, reviewMessage, routineDue } from "../../src/lib/agent-routines";

test("normalizeRoutine falls back to safe defaults", () => {
    assert.deepEqual(normalizeRoutine(null), { enabled: true, stallRemindersEnabled: true, time: "09:00", timezone: "UTC", weekdaysOnly: true });
    assert.equal(normalizeRoutine({ time: "25:00" }).time, "09:00");
    assert.equal(normalizeRoutine({ timezone: "Mars/Olympus" }).timezone, "UTC");
    assert.deepEqual(normalizeRoutine({ enabled: false, time: "07:30", timezone: "Europe/Madrid", weekdaysOnly: false }), { enabled: false, stallRemindersEnabled: true, time: "07:30", timezone: "Europe/Madrid", weekdaysOnly: false });
});

test("localClock reads the date and time in the company's timezone", () => {
    // 2026-10-05 is a Monday. 07:30 UTC is 09:30 in Madrid (CEST, UTC+2).
    const now = new Date("2026-10-05T07:30:00Z");
    assert.deepEqual(localClock(now, "Europe/Madrid"), { date: "2026-10-05", time: "09:30", weekday: 1 });
    // Still the previous evening in Los Angeles.
    assert.deepEqual(localClock(now, "America/Los_Angeles"), { date: "2026-10-05", time: "00:30", weekday: 1 });
    assert.equal(localClock(new Date("2026-10-05T03:00:00Z"), "America/Los_Angeles").date, "2026-10-04");
});

test("routineDue: once per local day, after the time, weekdays only by default", () => {
    const madrid = normalizeRoutine({ timezone: "Europe/Madrid", time: "09:00" });
    assert.equal(routineDue(madrid, null, new Date("2026-10-05T06:30:00Z")).due, false, "08:30 local: too early");
    assert.deepEqual(routineDue(madrid, null, new Date("2026-10-05T07:30:00Z")), { due: true, localDate: "2026-10-05" });
    assert.equal(routineDue(madrid, "2026-10-05", new Date("2026-10-05T15:00:00Z")).due, false, "already ran today");
    assert.equal(routineDue(madrid, "2026-10-04", new Date("2026-10-04T07:30:00Z")).due, false, "Sunday is skipped");
    assert.equal(routineDue({ ...madrid, weekdaysOnly: false }, null, new Date("2026-10-04T07:30:00Z")).due, true);
    assert.equal(routineDue({ ...madrid, enabled: false }, null, new Date("2026-10-05T07:30:00Z")).due, false);
});

test("reviewMessage lists tasks as live cards with due dates and approval state", () => {
    const now = new Date("2026-10-05T09:00:00Z");
    const text = reviewMessage([
        { id: "11111111-1111-1111-1111-111111111111", state: "in_progress", title: "Fix [signup] form", dueAt: new Date("2026-10-04T09:00:00Z"), pendingApproval: false },
        { id: "22222222-2222-2222-2222-222222222222", state: "review", title: "Send Q4 campaign", dueAt: null, pendingApproval: true },
    ], now);
    assert.match(text, /You have 2 open tasks/);
    assert.match(text, /\[Fix signup form\]\(emperor:\/\/task\/11111111-1111-1111-1111-111111111111\) — in progress, overdue by 1 day/);
    assert.match(text, /Send Q4 campaign\]\(emperor:\/\/task\/2{8}-.*waiting for approval/);
    assert.match(text, /request an approval instead of closing it/);
    assert.match(text, /reply here with a short summary/);
    assert.ok(!text.includes("\n\n\n"), "no stray blank lines");
});

test("stalled reminders can be disabled independently of daily review",()=>{const routine=normalizeRoutine({stallRemindersEnabled:false});assert.equal(routine.enabled,true);assert.equal(routine.stallRemindersEnabled,false);});
