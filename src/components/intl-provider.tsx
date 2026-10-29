"use client";

import { useEffect, useState, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { DEFAULT_LOCALE, DEFAULT_TIME_ZONE, isValidTimeZone, LOCALE_COOKIE, PREFERENCE_COOKIE_MAX_AGE, resolveLocale, TIME_ZONE_COOKIE, type Locale } from "@/i18n/config";
import { handleIntlError, intlMessageFallback } from "@/i18n/fallback";
import { englishMessages, loadMessages, type Messages } from "@/i18n/load-messages";

function readCookie(name: string): string | null {
    const match = document.cookie.split("; ").find((part) => part.startsWith(`${name}=`));
    return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

function browserTimeZone(): string {
    try {
        const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        return isValidTimeZone(zone) ? zone : DEFAULT_TIME_ZONE;
    } catch {
        return DEFAULT_TIME_ZONE;
    }
}

/** Remember the browser's time zone so server-rendered dates use it from the next request on. */
function rememberTimeZone(zone: string) {
    if (readCookie(TIME_ZONE_COOKIE) === zone) return;
    const secure = location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${TIME_ZONE_COOKIE}=${encodeURIComponent(zone)}; Path=/; Max-Age=${PREFERENCE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`;
}

/**
 * The root provider for public pages (sign-in, docs, error and 404 pages),
 * which are static and never read cookies on the server. They render English;
 * after mount the shared bits (dialogs, the update toast) switch to the
 * person's language from the NEXT_LOCALE cookie or the browser's languages,
 * and the browser's time zone is stored for the server.
 */
export function PublicIntlProvider({ children }: { children: ReactNode }) {
    const [detected, setDetected] = useState<{ locale: Locale; timeZone: string; messages: Messages } | null>(null);
    useEffect(() => {
        const timeZone = browserTimeZone();
        rememberTimeZone(timeZone);
        const locale = resolveLocale({ cookie: readCookie(LOCALE_COOKIE), acceptLanguage: navigator.languages?.join(",") || navigator.language });
        // Browser-only state, applied after hydration so the static HTML stays English;
        // the messages load first, so the switch is a single render.
        void loadMessages(locale).then((messages) => setDetected({ locale, timeZone, messages }));
    }, []);
    const locale = detected?.locale ?? DEFAULT_LOCALE;
    const messages = detected?.messages ?? englishMessages;
    const timeZone = detected?.timeZone ?? DEFAULT_TIME_ZONE;
    return (
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone} onError={handleIntlError} getMessageFallback={intlMessageFallback}>
            {children}
        </NextIntlClientProvider>
    );
}
