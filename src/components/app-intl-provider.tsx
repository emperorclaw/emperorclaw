"use client";

import { useEffect, type ReactNode } from "react";
import { NextIntlClientProvider } from "next-intl";
import { appMessages } from "@/i18n/app-messages";
import { DEFAULT_LOCALE, isLocale, type Locale } from "@/i18n/config";
import { handleIntlError, intlMessageFallback } from "@/i18n/fallback";

/**
 * The signed-in app's provider. The server passes only the resolved locale,
 * time zone and clock (a few bytes in every refresh); the messages are in the
 * app's cached JS, so hydration never waits for them. When the server re-read the
 * saved preference (`syncLocale`), the cookie mirror is refreshed in the
 * background.
 */
export function AppIntlProvider({ locale, timeZone, now, syncLocale, children }: {
    locale: Locale;
    timeZone: string;
    now: Date;
    syncLocale: boolean;
    children: ReactNode;
}) {
    const messages = appMessages(isLocale(locale) ? locale : DEFAULT_LOCALE);
    useEffect(() => {
        document.documentElement.lang = locale;
        return () => { document.documentElement.lang = DEFAULT_LOCALE; };
    }, [locale]);
    useEffect(() => {
        if (!syncLocale) return;
        void fetch("/api/i18n/sync", { method: "POST" }).catch(() => { /* next request re-reads it */ });
    }, [syncLocale]);
    return (
        <NextIntlClientProvider locale={locale} messages={messages} timeZone={timeZone} now={now} onError={handleIntlError} getMessageFallback={intlMessageFallback}>
            {children}
        </NextIntlClientProvider>
    );
}
