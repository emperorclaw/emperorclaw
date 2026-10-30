import { createTranslator } from "use-intl/core";
import { appMessages } from "./app-messages";
import { DEFAULT_TIME_ZONE, isLocale, resolveLocale, LOCALE_COOKIE, parseLocalePreference, DEFAULT_LOCALE, type Locale } from "./config";
import { handleIntlError, intlMessageFallback } from "./fallback";

/**
 * A translator outside the React tree (emails sent from API routes and
 * background work): the locale's messages merged over English, so a missing
 * translation reads in English. Only human-facing copy uses it; agents,
 * webhooks and stored rows stay English (tests/architecture-i18n.test.cjs).
 */
export function serverTranslator(locale: Locale | string | null | undefined) {
    const resolved: Locale = isLocale(locale) ? locale : DEFAULT_LOCALE;
    return createTranslator({
        locale: resolved,
        messages: appMessages(resolved),
        timeZone: DEFAULT_TIME_ZONE,
        onError: handleIntlError,
        getMessageFallback: intlMessageFallback,
    });
}

export type ServerTranslator = ReturnType<typeof serverTranslator>;

/** The bits of a request the locale rule reads (NextRequest fits). */
export interface LocaleRequest {
    headers: { get(name: string): string | null };
    cookies?: { get(name: string): { value: string } | undefined };
}

/**
 * The language for an email a request triggers: the person's saved
 * preference when known (`saved`: a locale, null for Automatic, undefined for
 * "not read"), else the browser's (NEXT_LOCALE cookie, Accept-Language),
 * else English. `saved` may be a raw users.locale value.
 */
export function emailLocale(req: LocaleRequest | null, saved?: string | null): Locale {
    const userLocale = saved === undefined ? undefined : parseLocalePreference(saved) ?? null;
    return resolveLocale({
        userLocale,
        cookie: req?.cookies?.get(LOCALE_COOKIE)?.value,
        acceptLanguage: req?.headers.get("accept-language"),
    });
}
