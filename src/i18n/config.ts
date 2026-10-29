/**
 * Locale configuration for the web UI (next-intl, "without i18n routing": the
 * locale never appears in URLs). Pure and dependency-free so the request
 * config, API routes, client providers and unit tests share one rule.
 *
 * Agents never see translated text: MCP, agent instructions, webhooks and
 * stored data stay English (tests/architecture-i18n.test.cjs).
 */

export const LOCALES = ["en", "zh-CN"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/**
 * The person's saved preference, mirrored from users.locale when they save it,
 * when they sign in and on a periodic sync, so a request rarely needs a
 * database query to know it. No cookie means "Automatic": the browser decides.
 */
export const LOCALE_COOKIE = "NEXT_LOCALE";
/** When NEXT_LOCALE was last checked against users.locale (epoch ms). */
export const LOCALE_SYNC_COOKIE = "EC_LOCALE_AT";
/** How stale the mirrored preference may get before the app re-reads users.locale (other devices). */
export const LOCALE_SYNC_INTERVAL_MS = 10 * 60 * 1000;
/** The browser's IANA time zone, written by the client so server-rendered dates use it too. */
export const TIME_ZONE_COOKIE = "EC_TZ";
export const DEFAULT_TIME_ZONE = "UTC";
export const PREFERENCE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export function isLocale(value: unknown): value is Locale {
    return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/** A stored preference: a supported locale, or null for "Automatic". Anything else is invalid. */
export function parseLocalePreference(value: unknown): Locale | null | undefined {
    if (value === null || value === "" || value === "auto") return null;
    return isLocale(value) ? value : undefined;
}

/** Map one language tag to a supported locale: any Chinese variant reads Simplified Chinese. */
function supportedFor(tag: string): Locale | null {
    const lower = tag.trim().toLowerCase();
    if (!lower || lower === "*") return null;
    if (lower === "zh" || lower.startsWith("zh-")) return "zh-CN";
    if (lower === "en" || lower.startsWith("en-")) return "en";
    return null;
}

/** The best supported locale in an Accept-Language header (or navigator.languages joined), honouring q-values. */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale | null {
    if (!header) return null;
    const ranked = header.split(",")
        .map((part, index) => {
            const [tag, ...params] = part.split(";");
            const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
            const quality = q ? Number(q.slice(2)) : 1;
            return { tag: tag.trim(), quality: Number.isFinite(quality) ? quality : 0, index };
        })
        .filter((entry) => entry.tag && entry.quality > 0)
        .sort((a, b) => b.quality - a.quality || a.index - b.index);
    for (const entry of ranked) {
        const locale = supportedFor(entry.tag);
        if (locale) return locale;
    }
    return null;
}

/**
 * Which locale renders: the person's saved preference (users.locale) when the
 * caller has read it — a locale wins, null ("Automatic") skips the cookie —
 * otherwise the NEXT_LOCALE cookie that mirrors it; then the browser's
 * languages; then English. `userLocale: undefined` means "not read".
 */
export function resolveLocale(input: {
    userLocale?: string | null;
    cookie?: string | null;
    acceptLanguage?: string | null;
}): Locale {
    if (input.userLocale !== undefined) {
        if (isLocale(input.userLocale)) return input.userLocale;
    } else if (isLocale(input.cookie)) {
        return input.cookie;
    }
    return localeFromAcceptLanguage(input.acceptLanguage) ?? DEFAULT_LOCALE;
}

/** True when the mirrored preference is missing or older than the sync interval (or from the future). */
export function localeSyncDue(syncedAt: string | null | undefined, nowMs: number): boolean {
    const at = Number(syncedAt);
    return !syncedAt || !Number.isFinite(at) || at > nowMs + 60_000 || nowMs - at > LOCALE_SYNC_INTERVAL_MS;
}

/** A time zone the runtime knows (an IANA name such as "Asia/Shanghai"); anything else is rejected. */
export function isValidTimeZone(value: unknown): value is string {
    if (typeof value !== "string" || !value || value.length > 64) return false;
    try {
        new Intl.DateTimeFormat("en", { timeZone: value });
        return true;
    } catch {
        return false;
    }
}

/** The request's time zone: the browser's (EC_TZ cookie) when valid, else UTC. */
export function resolveTimeZone(cookie: string | null | undefined): string {
    return isValidTimeZone(cookie) ? cookie : DEFAULT_TIME_ZONE;
}
