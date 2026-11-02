import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
    companyTimezoneFrom, computeNextRunAt, cronExpression, describeCron, emperorScheduleProblem, nextCronRun, scheduleTimezone, shortestCronGapMinutes,
} from "../../src/lib/pipeline-schedule";
import { schedulerDisabledInThisProcess } from "../../src/lib/pipeline-runs";
import {
    isPipelineScheduler, pipelineRunDurationMs, pipelineRunOrigin, runStatusForTaskState, PIPELINE_RUN_STATUSES,
} from "../../src/lib/pipelines";
import { MODULE_TOOLS, moduleForTool } from "../../src/lib/modules";

const active = (triggerConfig: unknown) => ({ status: "active", trigger: "cron", triggerConfig });

test("next run: the first slot strictly after now, in UTC by default", () => {
    const now = new Date("2026-11-02T08:59:30Z"); // a Monday
    assert.equal(computeNextRunAt(active({ cron: "0 9 * * 1" }), null, now)?.toISOString(), "2026-11-02T09:00:00.000Z");
    const atSlot = new Date("2026-11-02T09:00:00Z");
    assert.equal(computeNextRunAt(active({ cron: "0 9 * * 1" }), null, atSlot)?.toISOString(), "2026-11-09T09:00:00.000Z");
});

test("next run: the automation's own timezone wins over the company's, which wins over UTC", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    // 09:00 Madrid is 08:00 UTC in November (CET).
    assert.equal(computeNextRunAt(active({ cron: "0 9 * * *", timezone: "Europe/Madrid" }), "America/New_York", now)?.toISOString(), "2026-11-01T08:00:00.000Z");
    // 09:00 New York (EST from Nov 1) is 14:00 UTC.
    assert.equal(computeNextRunAt(active({ cron: "0 9 * * *" }), "America/New_York", now)?.toISOString(), "2026-11-01T14:00:00.000Z");
    assert.equal(scheduleTimezone({ timezone: "Not/AZone" }, "Also/Bad"), "UTC");
    assert.equal(scheduleTimezone({}, "Europe/Bratislava"), "Europe/Bratislava");
});

test("next run: across a DST change the wall-clock time is kept", () => {
    // Madrid leaves summer time on 2026-10-25: 09:00 local is 07:00 UTC before, 08:00 after.
    const before = nextCronRun("0 9 * * *", "Europe/Madrid", new Date("2026-10-24T00:00:00Z"));
    const after = nextCronRun("0 9 * * *", "Europe/Madrid", new Date("2026-10-26T00:00:00Z"));
    assert.equal(before?.toISOString(), "2026-10-24T07:00:00.000Z");
    assert.equal(after?.toISOString(), "2026-10-26T08:00:00.000Z");
});

test("next run: a slot that does not exist on the spring-forward day runs once, an hour later", () => {
    // Madrid skips 02:00-03:00 on 2027-03-28: 02:30 local becomes 03:30 local (01:30 UTC), once.
    const slot = nextCronRun("30 2 * * *", "Europe/Madrid", new Date("2027-03-27T12:00:00Z"));
    assert.equal(slot?.toISOString(), "2027-03-28T01:30:00.000Z");
    const following = nextCronRun("30 2 * * *", "Europe/Madrid", slot!);
    assert.equal(following?.toISOString(), "2027-03-29T00:30:00.000Z");
    // A normal slot keeps its wall-clock time: 09:00 is 08:00 UTC before, 07:00 UTC after.
    assert.equal(nextCronRun("0 9 * * *", "Europe/Madrid", new Date("2027-03-27T00:00:00Z"))?.toISOString(), "2027-03-27T08:00:00.000Z");
    assert.equal(nextCronRun("0 9 * * *", "Europe/Madrid", new Date("2027-03-28T00:00:00Z"))?.toISOString(), "2027-03-28T07:00:00.000Z");
});

test("Emperor keeps only readable schedules at most every 15 minutes", () => {
    assert.equal(emperorScheduleProblem({ cron: "0 9 * * 1" }), null);
    assert.equal(emperorScheduleProblem({ cron: "*/15 * * * *" }), null);
    assert.match(emperorScheduleProblem({ cron: "*/5 * * * *" }) ?? "", /at most every 15 minutes.*every 5 minutes/);
    // A burst hidden in an otherwise rare schedule is caught too.
    assert.match(emperorScheduleProblem({ cron: "0,5 9 * * 1" }) ?? "", /every 5 minutes/);
    assert.match(emperorScheduleProblem({ cron: "whenever" }) ?? "", /^Invalid schedule/);
    assert.match(emperorScheduleProblem({}) ?? "", /^Invalid schedule/);
    assert.equal(shortestCronGapMinutes("0 9 * * *", "UTC"), 1440);
});

test("the scheduler is off under tests and next dev unless turned on, and can be turned off", () => {
    assert.equal(schedulerDisabledInThisProcess({ NODE_ENV: "production" }), false);
    assert.equal(schedulerDisabledInThisProcess({}), false);
    assert.equal(schedulerDisabledInThisProcess({ NODE_ENV: "development" }), true);
    assert.equal(schedulerDisabledInThisProcess({ NODE_ENV: "test" }), true);
    assert.equal(schedulerDisabledInThisProcess({ NODE_ENV: "development", EMPEROR_PIPELINE_SCHEDULER: "on" }), false);
    assert.equal(schedulerDisabledInThisProcess({ NODE_ENV: "production", EMPEROR_PIPELINE_SCHEDULER: "off" }), true);
});

test("next run: none when paused, not a cron trigger, or unreadable", () => {
    const now = new Date("2026-11-01T00:00:00Z");
    assert.equal(computeNextRunAt({ status: "paused", trigger: "cron", triggerConfig: { cron: "0 9 * * *" } }, null, now), null);
    assert.equal(computeNextRunAt({ status: "active", trigger: "manual", triggerConfig: { cron: "0 9 * * *" } }, null, now), null);
    assert.equal(computeNextRunAt(active({ cron: "every day at nine" }), null, now), null);
    assert.equal(computeNextRunAt(active({}), null, now), null);
    assert.equal(cronExpression({ cron: "  0 9 * * *  " }), "0 9 * * *");
    assert.equal(cronExpression(null), null);
});

test("schedule in plain words, English and Chinese", () => {
    assert.equal(describeCron("0 9 * * 1"), "At 09:00, only on Monday");
    assert.match(describeCron("0 9 * * 1", "zh-CN") ?? "", /星期一/);
    assert.equal(describeCron("not a cron"), null);
});

test("company timezone comes from the daily routine settings", () => {
    assert.equal(companyTimezoneFrom({ timezone: "Europe/Madrid" }), "Europe/Madrid");
    assert.equal(companyTimezoneFrom({ timezone: "Mars/Olympus" }), null);
    assert.equal(companyTimezoneFrom(null), null);
});

test("run origin: Run now by a person, agent-reported, schedule, API, legacy", () => {
    assert.deepEqual(pipelineRunOrigin({ source: "manual", triggeredByType: "user", triggeredById: "u1", agentId: "a1" }), { kind: "manual", who: { type: "user", id: "u1" } });
    assert.deepEqual(pipelineRunOrigin({ source: "agent", triggeredByType: null, triggeredById: null, agentId: "a1" }), { kind: "agent", who: { type: "agent", id: "a1" } });
    assert.deepEqual(pipelineRunOrigin({ source: "schedule", agentId: "a1" }), { kind: "schedule", who: null });
    assert.deepEqual(pipelineRunOrigin({ source: "api", triggeredByType: null, triggeredById: null, agentId: "a1" }), { kind: "api", who: null });
    assert.deepEqual(pipelineRunOrigin({ source: null, agentId: "a1" }), { kind: "legacy", agentId: "a1" });
    assert.deepEqual(pipelineRunOrigin({ source: "teleport", agentId: null }), { kind: "legacy", agentId: null });
});

test("run status from a linked task, durations, schedulers and the skipped status", () => {
    assert.equal(runStatusForTaskState("done"), "succeeded");
    assert.equal(runStatusForTaskState("failed"), "failed");
    assert.equal(runStatusForTaskState("dead_letter"), "failed");
    assert.equal(runStatusForTaskState("in_progress"), null);
    assert.equal(pipelineRunDurationMs({ startedAt: "2026-11-01T10:00:00Z", endedAt: "2026-11-01T10:03:00Z" }), 180_000);
    assert.equal(pipelineRunDurationMs({ startedAt: "2026-11-01T10:00:00Z", endedAt: null }, new Date("2026-11-01T10:01:00Z")), 60_000);
    assert.ok(isPipelineScheduler("emperor") && isPipelineScheduler("agent") && !isPipelineScheduler("cron"));
    assert.ok((PIPELINE_RUN_STATUSES as readonly string[]).includes("skipped"));
});

test("agent tools: automation tools belong to the Automations module", () => {
    const source = readFileSync(path.join(__dirname, "..", "..", "src", "lib", "mcp-server", "tools", "automations.ts"), "utf8");
    const registered = [...source.matchAll(/registerTool\("([a-z_]+)"/g)].map((m) => m[1]).sort();
    assert.deepEqual([...(MODULE_TOOLS.automations ?? [])].sort(), registered);
    for (const tool of registered) assert.equal(moduleForTool(tool), "automations");
});
