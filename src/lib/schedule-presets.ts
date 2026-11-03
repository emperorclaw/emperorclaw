// The schedule builder of the automation editor: simple presets ↔ cron.
//
// A person picks "every hour at :15", "every day at 09:00" or "on Mon, Wed at
// 09:00" (or writes a custom cron); this turns it into the cron Emperor
// stores, reads an existing cron back into the matching preset (else Custom),
// and lists the next runs in a time zone. Pure and browser-safe (croner), so
// the dialog previews exactly what the server will compute.
//
// Unit-tested in tests/unit/schedule-presets.test.ts.

import { Cron } from "croner";

export type SchedulePreset =
    | { kind: "hourly"; minute: number }
    | { kind: "daily"; hour: number; minute: number }
    | { kind: "weekdays"; days: number[]; hour: number; minute: number }
    | { kind: "custom"; cron: string };

export type SchedulePresetKind = SchedulePreset["kind"];

/** Days of the week as cron numbers: 0 = Sunday … 6 = Saturday. */
export const WEEK_DAYS = [1, 2, 3, 4, 5, 6, 0] as const;

const clampInt = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.trunc(Number.isFinite(value) ? value : min)));

/** The cron expression of a preset (5 fields). */
export function presetToCron(preset: SchedulePreset): string {
    switch (preset.kind) {
        case "hourly":
            return `${clampInt(preset.minute, 0, 59)} * * * *`;
        case "daily":
            return `${clampInt(preset.minute, 0, 59)} ${clampInt(preset.hour, 0, 23)} * * *`;
        case "weekdays": {
            const days = [...new Set(preset.days.map((day) => clampInt(day, 0, 6)))].sort((a, b) => a - b);
            return `${clampInt(preset.minute, 0, 59)} ${clampInt(preset.hour, 0, 23)} * * ${days.length > 0 ? days.join(",") : "*"}`;
        }
        case "custom":
            return preset.cron.trim();
    }
}

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function plainNumber(field: string, min: number, max: number): number | null {
    if (!/^\d{1,2}$/.test(field)) return null;
    const value = Number(field);
    return value >= min && value <= max ? value : null;
}

function dayNumber(token: string): number | null {
    const named = DAY_NAMES[token.toLowerCase()];
    if (named !== undefined) return named;
    const value = plainNumber(token, 0, 7);
    return value === null ? null : value % 7;
}

/** "1-5", "MON,WED", "1,3-5" → [1,3,4,5]; null for steps or anything else. */
function parseDays(field: string): number[] | null {
    const days = new Set<number>();
    for (const part of field.split(",")) {
        const range = part.split("-");
        if (range.length === 1) {
            const day = dayNumber(range[0]);
            if (day === null) return null;
            days.add(day);
        } else if (range.length === 2) {
            const from = dayNumber(range[0]);
            const to = dayNumber(range[1]);
            if (from === null || to === null || from > to) return null;
            for (let day = from; day <= to; day++) days.add(day);
        } else {
            return null;
        }
    }
    return [...days].sort((a, b) => a - b);
}

/**
 * Whether a cron steps through the days of the month ("*\/2", "1/3",
 * "1-31/2"). Such a step restarts on the 1st of each month, so "every 2 days"
 * runs on the 31st and again on the 1st: the editor warns about it and offers
 * no preset for it.
 */
export function hasDayOfMonthStep(cron: string): boolean {
    const fields = cron.trim().split(/\s+/);
    const dom = fields.length === 6 ? fields[3] : fields.length === 5 ? fields[2] : null;
    return dom !== null && dom.includes("/") && dom !== "*/1";
}

/**
 * The preset a cron expression matches, else Custom with the expression as
 * written. Only plain 5-field forms are recognized: a fixed minute (and hour),
 * every day of the month, every month, and every day of the week or a
 * list/range of days. A day-of-month step is always Custom (see hasDayOfMonthStep).
 */
export function cronToPreset(cron: string): SchedulePreset {
    const text = cron.trim().replace(/\s+/g, " ");
    const custom: SchedulePreset = { kind: "custom", cron: text };
    const fields = text.split(" ");
    if (fields.length !== 5) return custom;
    const [minuteField, hourField, domField, monthField, dowField] = fields;
    const minute = plainNumber(minuteField, 0, 59);
    if (minute === null || monthField !== "*") return custom;

    if (hourField === "*") {
        return domField === "*" && dowField === "*" ? { kind: "hourly", minute } : custom;
    }
    const hour = plainNumber(hourField, 0, 23);
    if (hour === null) return custom;

    if (domField === "*/1" && dowField === "*") return { kind: "daily", hour, minute };
    if (domField !== "*") return custom;
    if (dowField === "*" || dowField === "?") return { kind: "daily", hour, minute };
    const days = parseDays(dowField);
    if (!days || days.length === 0) return custom;
    if (days.length === 7) return { kind: "daily", hour, minute };
    return { kind: "weekdays", days, hour, minute };
}

/** The next `count` runs of a cron in a time zone, after `from`; [] for an unreadable expression or zone. */
export function nextCronRuns(cron: string, timezone: string, count = 3, from = new Date()): Date[] {
    try {
        return new Cron(cron, { timezone, paused: true, mode: "5-or-6-parts" }).nextRuns(count, from);
    } catch {
        return [];
    }
}

/** "09:05" from an hour and minute. */
export function formatTimeOfDay(hour: number, minute: number): string {
    return `${String(clampInt(hour, 0, 23)).padStart(2, "0")}:${String(clampInt(minute, 0, 59)).padStart(2, "0")}`;
}

/** An "HH:MM" input value → hour and minute; null when it is not a time. */
export function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** IANA zones the browser knows (with UTC first), plus `extra` zones in use that it may not list. */
export function timeZoneOptions(extra: readonly (string | null | undefined)[] = []): string[] {
    let zones: string[] = [];
    try {
        const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
        zones = supported ? supported("timeZone") : [];
    } catch {
        zones = [];
    }
    const all = new Set(["UTC", ...extra.filter((zone): zone is string => typeof zone === "string" && zone.length > 0), ...zones]);
    return [...all];
}
