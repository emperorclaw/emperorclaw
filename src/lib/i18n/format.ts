import { useCallback } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { ageParts, compactAgoParts, timeAgoParts } from "./relative-time";

/**
 * Locale-aware formatting for the UI, built on next-intl. Works in client
 * components and in non-async server components. Agent-facing code must not
 * import this (tests/architecture-i18n.test.cjs): agents always read English.
 */

/** "5m ago" / "5 分钟前". */
export function useTimeAgo() {
    const t = useTranslations("time");
    return useCallback((iso: string | Date, now: Date) => {
        const { key, count } = timeAgoParts(iso, now);
        return t(key, { count });
    }, [t]);
}

/** "5m" / "5 分钟" for tight lists; measured against the current clock unless given one. */
export function useCompactAgo() {
    const t = useTranslations("time");
    return useCallback((iso: string | Date, nowMs: number = Date.now()) => {
        const { key, count } = compactAgoParts(iso, nowMs);
        return t(key, { count });
    }, [t]);
}

/** A card's age ("3d", "2w"); empty when there is no start. */
export function useAge() {
    const t = useTranslations("time");
    return useCallback((from: string | Date | null | undefined, nowMs: number) => {
        const parts = ageParts(from, nowMs);
        return parts ? t(parts.key, { count: parts.count }) : "";
    }, [t]);
}

/**
 * "Oct 29, 2026" / "2026年10月29日", in the provider's time zone (the browser's,
 * via EC_TZ). Client-only UI (rendered after mount, never server-rendered) can
 * pass `inBrowserZone` to use the browser's zone even before EC_TZ exists.
 */
export function useFormatDate({ inBrowserZone = false }: { inBrowserZone?: boolean } = {}) {
    const format = useFormatter();
    return useCallback((value: string | Date) => format.dateTime(new Date(value), {
        year: "numeric", month: "short", day: "numeric",
        ...(inBrowserZone ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : {}),
    }), [format, inBrowserZone]);
}
