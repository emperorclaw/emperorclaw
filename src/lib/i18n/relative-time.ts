/**
 * Locale-neutral relative-time math for the UI. Each function returns a
 * message key under the `time` namespace plus its count; the words come from
 * messages/*.json (src/lib/i18n/format.ts renders them). The English output
 * is identical to the older English-only helpers (timeAgo in team-scene.ts,
 * formatAge in project-board-model.ts), which stay for code outside the
 * translated screens.
 */

export type TimeAgoKey = "justNow" | "minutesAgo" | "hoursAgo" | "daysAgo";
export type CompactAgoKey = "justNow" | "minutesShort" | "hoursShort" | "daysShort";
export type AgeKey = "ageNow" | "minutesShort" | "hoursShort" | "daysShort" | "weeksShort" | "monthsShort";

export interface RelativeParts<K extends string> {
    key: K;
    count: number;
}

/** "just now", "5m ago", "3h ago", "2d ago" (floored), the dashboard and inbox clock. */
export function timeAgoParts(iso: string | Date, now: Date): RelativeParts<TimeAgoKey> {
    const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
    if (minutes < 1) return { key: "justNow", count: 0 };
    if (minutes < 60) return { key: "minutesAgo", count: minutes };
    if (minutes < 60 * 24) return { key: "hoursAgo", count: Math.floor(minutes / 60) };
    return { key: "daysAgo", count: Math.floor(minutes / 1440) };
}

/** "just now", "5m", "3h", "2d" (rounded), the notification list's clock. */
export function compactAgoParts(iso: string | Date, nowMs: number): RelativeParts<CompactAgoKey> {
    const minutes = Math.round((nowMs - new Date(iso).getTime()) / 60_000);
    if (!Number.isFinite(minutes) || minutes < 1) return { key: "justNow", count: 0 };
    if (minutes < 60) return { key: "minutesShort", count: minutes };
    if (minutes < 60 * 24) return { key: "hoursShort", count: Math.round(minutes / 60) };
    return { key: "daysShort", count: Math.round(minutes / 1440) };
}

/** A card's age: "now", "5m", "3h", "4d", "2w", "3mo"; null when there is no start. */
export function ageParts(from: string | Date | null | undefined, nowMs: number): RelativeParts<AgeKey> | null {
    if (!from) return null;
    const start = from instanceof Date ? from.getTime() : Date.parse(from);
    if (!Number.isFinite(start) || !start) return null;
    const minutes = Math.floor(Math.max(0, nowMs - start) / 60_000);
    if (minutes < 1) return { key: "ageNow", count: 0 };
    if (minutes < 60) return { key: "minutesShort", count: minutes };
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return { key: "hoursShort", count: hours };
    const days = Math.floor(hours / 24);
    if (days < 14) return { key: "daysShort", count: days };
    if (days < 60) return { key: "weeksShort", count: Math.floor(days / 7) };
    return { key: "monthsShort", count: Math.floor(days / 30) };
}
