// When a cron automation runs next, and its schedule in plain words.
//
// Pure (no DB): the run service, the scheduler tick, the pages and the MCP
// tools all compute the next slot here, so they never disagree. The cron text
// comes from the agent (pipelines.trigger_config.cron); the timezone is
// trigger_config.timezone, else the company's timezone, else UTC.
//
// Unit-tested in tests/unit/pipeline-schedule.test.ts.

import { Cron } from "croner";
import cronstrue from "cronstrue";
import "cronstrue/locales/zh_CN";

export const DEFAULT_SCHEDULE_TIMEZONE = "UTC";

export function isValidTimezone(tz: unknown): tz is string {
    if (typeof tz !== "string" || !tz.trim()) return false;
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: tz });
        return true;
    } catch {
        return false;
    }
}

function configRecord(triggerConfig: unknown): Record<string, unknown> {
    return typeof triggerConfig === "object" && triggerConfig !== null && !Array.isArray(triggerConfig)
        ? triggerConfig as Record<string, unknown>
        : {};
}

/** The cron expression of a trigger config, trimmed; null when there is none. */
export function cronExpression(triggerConfig: unknown): string | null {
    const cron = configRecord(triggerConfig).cron;
    return typeof cron === "string" && cron.trim() ? cron.trim() : null;
}

/** The zone a schedule is read in: the automation's own, else the company's, else UTC. */
export function scheduleTimezone(triggerConfig: unknown, companyTimezone?: string | null): string {
    const own = configRecord(triggerConfig).timezone;
    if (isValidTimezone(own)) return own;
    if (isValidTimezone(companyTimezone)) return companyTimezone;
    return DEFAULT_SCHEDULE_TIMEZONE;
}

/** The first slot strictly after `after`; null for an expression croner cannot read. */
export function nextCronRun(cron: string, timezone: string, after: Date): Date | null {
    try {
        const job = new Cron(cron, { timezone, paused: true, mode: "5-or-6-parts" });
        return job.nextRun(after);
    } catch {
        return null;
    }
}

export function isValidCron(cron: string): boolean {
    try {
        new Cron(cron, { paused: true, mode: "5-or-6-parts" });
        return true;
    } catch {
        return false;
    }
}

/**
 * When a cron automation is next due, from `now`: null when it is not active,
 * not a cron trigger, or its expression does not parse.
 */
export function computeNextRunAt(pipeline: { status: string; trigger: string; triggerConfig: unknown }, companyTimezone: string | null | undefined, now: Date): Date | null {
    if (pipeline.status !== "active" || pipeline.trigger !== "cron") return null;
    const cron = cronExpression(pipeline.triggerConfig);
    if (!cron) return null;
    return nextCronRun(cron, scheduleTimezone(pipeline.triggerConfig, companyTimezone), now);
}

/** Emperor never starts runs of one automation closer together than this. */
export const MIN_EMPEROR_INTERVAL_MINUTES = 15;

/**
 * The shortest gap between two of the next slots, in minutes (sampled over the
 * next 60 slots, which catches "*\/5" and "0,5 9 * * *" alike); null when
 * the expression does not parse.
 */
export function shortestCronGapMinutes(cron: string, timezone: string, from = new Date()): number | null {
    let slots: Date[];
    try {
        slots = new Cron(cron, { timezone, paused: true, mode: "5-or-6-parts" }).nextRuns(60, from);
    } catch {
        return null;
    }
    if (slots.length < 2) return Number.POSITIVE_INFINITY;
    let shortest = Number.POSITIVE_INFINITY;
    for (let i = 1; i < slots.length; i++) shortest = Math.min(shortest, (slots[i].getTime() - slots[i - 1].getTime()) / 60_000);
    return shortest;
}

/**
 * Why Emperor cannot keep this schedule (null when it can): an expression it
 * cannot read, or one that fires more often than every 15 minutes. Agents that
 * keep their own schedule may use any cron; this only gates scheduledBy 'emperor'.
 */
export function emperorScheduleProblem(triggerConfig: unknown, companyTimezone?: string | null, from = new Date()): string | null {
    const cron = cronExpression(triggerConfig);
    if (!cron) return "Invalid schedule: the automation has no cron expression.";
    const gap = shortestCronGapMinutes(cron, scheduleTimezone(triggerConfig, companyTimezone), from);
    if (gap === null) return `Invalid schedule: "${cron}" is not a cron expression Emperor can read.`;
    if (gap < MIN_EMPEROR_INTERVAL_MINUTES) {
        return `Emperor runs an automation at most every ${MIN_EMPEROR_INTERVAL_MINUTES} minutes; "${cron}" fires every ${Math.max(1, Math.round(gap))} minutes. Use a slower schedule, or let the agent run it from its runtime.`;
    }
    return null;
}

const CRONSTRUE_LOCALES: Record<string, string> = { "zh-CN": "zh_CN" };

/** "At 09:00, only on Monday" (or its translation); null for an unreadable expression. */
export function describeCron(cron: string, locale = "en"): string | null {
    try {
        return cronstrue.toString(cron, {
            locale: CRONSTRUE_LOCALES[locale] ?? "en",
            use24HourTimeFormat: true,
            throwExceptionOnParseError: true,
        });
    } catch {
        return null;
    }
}

/** The company's timezone, as the daily agent routine stores it (companies.agent_routine_json). */
export function companyTimezoneFrom(agentRoutineJson: unknown): string | null {
    const tz = configRecord(agentRoutineJson).timezone;
    return isValidTimezone(tz) ? tz : null;
}
