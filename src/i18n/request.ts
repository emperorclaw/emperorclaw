import { cache } from "react";
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE, LOCALE_SYNC_COOKIE, localeSyncDue, resolveLocale, resolveTimeZone, TIME_ZONE_COOKIE } from "./config";
import { handleIntlError, intlMessageFallback } from "./fallback";
import { loadMessages } from "./load-messages";

/**
 * The person's saved language, read from the database only when the mirrored
 * cookie is missing or older than LOCALE_SYNC_INTERVAL_MS (so a change made on
 * another device shows up within minutes). undefined = not read / signed out.
 */
const savedLocaleWhenDue = cache(async (syncedAt: string | undefined): Promise<string | null | undefined> => {
    if (!localeSyncDue(syncedAt, Date.now())) return undefined;
    try {
        const { getValidatedServerSession } = await import("@/lib/auth");
        const session = await getValidatedServerSession();
        if (!session?.user?.id) return undefined;
        const { readUserLocale } = await import("./user-locale");
        return await readUserLocale({ userId: session.user.id });
    } catch {
        return undefined;
    }
});

/** Whether this request re-read users.locale, so the app shell mirrors it back into the cookie. */
export const localeNeedsSync = cache(async () => {
    const store = await cookies();
    return (await savedLocaleWhenDue(store.get(LOCALE_SYNC_COOKIE)?.value)) !== undefined;
});

/**
 * The server-side locale and time zone. Only the signed-in app (and pages that
 * translate on the server) call this: the root layout and public pages never
 * read cookies, so they stay statically rendered.
 */
export default getRequestConfig(async () => {
    const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
    const userLocale = await savedLocaleWhenDue(cookieStore.get(LOCALE_SYNC_COOKIE)?.value);
    const locale = resolveLocale({
        userLocale,
        cookie: cookieStore.get(LOCALE_COOKIE)?.value,
        acceptLanguage: headerStore.get("accept-language"),
    });
    return {
        locale,
        messages: await loadMessages(locale),
        // The browser's zone (EC_TZ, written by the client); UTC until it is known.
        timeZone: resolveTimeZone(cookieStore.get(TIME_ZONE_COOKIE)?.value),
        now: new Date(),
        onError: handleIntlError,
        getMessageFallback: intlMessageFallback,
    };
});
