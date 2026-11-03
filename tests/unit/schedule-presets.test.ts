import { test } from "node:test";
import assert from "node:assert/strict";
import {
    cronToPreset, formatTimeOfDay, hasDayOfMonthStep, nextCronRuns, parseTimeOfDay, presetToCron, timeZoneOptions, type SchedulePreset,
} from "../../src/lib/schedule-presets";

test("presets turn into the cron Emperor stores", () => {
    assert.equal(presetToCron({ kind: "hourly", minute: 15 }), "15 * * * *");
    assert.equal(presetToCron({ kind: "daily", hour: 9, minute: 5 }), "5 9 * * *");
    assert.equal(presetToCron({ kind: "weekdays", days: [5, 1, 3, 1], hour: 18, minute: 30 }), "30 18 * * 1,3,5");
    assert.equal(presetToCron({ kind: "custom", cron: "  0 6 1 * *  " }), "0 6 1 * *");
    // Out-of-range values are clamped, never written as an unreadable cron.
    assert.equal(presetToCron({ kind: "daily", hour: 27, minute: -4 }), "0 23 * * *");
});

test("a day-of-month step opens as Custom with a warning: it restarts on the 1st", () => {
    for (const cron of ["0 9 */2 * *", "0 6 */3 * *", "0 9 1/2 * *", "0 9 1-31/2 * *", "0 0 9 */2 * *"]) {
        assert.equal(hasDayOfMonthStep(cron), true, cron);
        assert.equal(cronToPreset(cron).kind, "custom", cron);
    }
    for (const cron of ["0 9 * * *", "*/15 * * * *", "0 */2 * * *", "0 9 * * 1/2", "0 9 */1 * *", "0 9 1,15 * *"]) {
        assert.equal(hasDayOfMonthStep(cron), false, cron);
    }
    // Why: "every 2 days" fires on Jan 31 and again on Feb 1.
    const runs = nextCronRuns("0 9 */2 * *", "UTC", 3, new Date("2026-01-30T12:00:00Z")).map((date) => date.toISOString().slice(0, 10));
    assert.deepEqual(runs, ["2026-01-31", "2026-02-01", "2026-02-03"]);
});

test("a cron is read back into the matching preset, else Custom", () => {
    assert.deepEqual(cronToPreset("15 * * * *"), { kind: "hourly", minute: 15 });
    assert.deepEqual(cronToPreset("0 9 * * *"), { kind: "daily", hour: 9, minute: 0 });
    assert.deepEqual(cronToPreset("0 9 */1 * *"), { kind: "daily", hour: 9, minute: 0 });
    assert.deepEqual(cronToPreset("0 9 * * 1"), { kind: "weekdays", days: [1], hour: 9, minute: 0 });
    assert.deepEqual(cronToPreset("30 8 * * 1-5"), { kind: "weekdays", days: [1, 2, 3, 4, 5], hour: 8, minute: 30 });
    assert.deepEqual(cronToPreset("0 9 * * MON,wed,7"), { kind: "weekdays", days: [0, 1, 3], hour: 9, minute: 0 });
    assert.deepEqual(cronToPreset("0 9 * * 0-6"), { kind: "daily", hour: 9, minute: 0 });
    assert.deepEqual(cronToPreset("0  9 *  * *"), { kind: "daily", hour: 9, minute: 0 }, "extra spaces");

    for (const cron of ["*/15 * * * *", "0 9 1 * *", "0 9 * 1 *", "0 9,17 * * *", "0 0 9 * * *", "0 6 */3 * *", "0 9 * * 1/2", "0 9 */3 * 1", "nonsense"]) {
        assert.deepEqual(cronToPreset(cron), { kind: "custom", cron: cron.trim().replace(/\s+/g, " ") }, cron);
    }
});

test("every preset survives a round trip through cron", () => {
    const presets: SchedulePreset[] = [
        { kind: "hourly", minute: 0 },
        { kind: "hourly", minute: 45 },
        { kind: "daily", hour: 0, minute: 0 },
        { kind: "daily", hour: 23, minute: 59 },
        { kind: "weekdays", days: [0, 6], hour: 10, minute: 0 },
        { kind: "weekdays", days: [1, 2, 3, 4, 5], hour: 9, minute: 30 },
        { kind: "custom", cron: "0 9 1,15 * *" },
    ];
    for (const preset of presets) assert.deepEqual(cronToPreset(presetToCron(preset)), preset, JSON.stringify(preset));
});

test("next runs preview: in the chosen time zone, strictly after now", () => {
    const from = new Date("2026-11-02T06:30:00Z"); // Monday, 07:30 in Madrid (CET)
    const madrid = nextCronRuns("0 9 * * 1,3", "Europe/Madrid", 3, from).map((date) => date.toISOString());
    assert.deepEqual(madrid, ["2026-11-02T08:00:00.000Z", "2026-11-04T08:00:00.000Z", "2026-11-09T08:00:00.000Z"]);
    const tokyo = nextCronRuns("0 9 * * *", "Asia/Tokyo", 2, from).map((date) => date.toISOString());
    assert.deepEqual(tokyo, ["2026-11-03T00:00:00.000Z", "2026-11-04T00:00:00.000Z"]);
    // Across the end of daylight saving time the wall-clock hour is kept.
    const nyc = nextCronRuns("0 9 * * *", "America/New_York", 2, new Date("2026-10-31T14:00:00Z")).map((date) => date.toISOString());
    assert.deepEqual(nyc, ["2026-11-01T14:00:00.000Z", "2026-11-02T14:00:00.000Z"]);
    assert.deepEqual(nextCronRuns("not a cron", "UTC"), []);
    assert.deepEqual(nextCronRuns("0 9 * * *", "Not/AZone"), []);
});

test("time of day helpers and the time zone list", () => {
    assert.equal(formatTimeOfDay(9, 5), "09:05");
    assert.deepEqual(parseTimeOfDay("07:45"), { hour: 7, minute: 45 });
    assert.equal(parseTimeOfDay("24:00"), null);
    assert.equal(parseTimeOfDay("9am"), null);
    const zones = timeZoneOptions(["Europe/Madrid", null, ""]);
    assert.equal(zones[0], "UTC");
    assert.ok(zones.includes("Europe/Madrid"));
    assert.equal(new Set(zones).size, zones.length, "no duplicates");
});
