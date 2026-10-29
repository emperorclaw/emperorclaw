import en from "../../messages/en.json";
import type { Locale } from "./config";
import { withEnglishFallback } from "./fallback";

export type Messages = typeof en;

/** English, the source of truth and the fallback for every other locale (bundled: public pages render it). */
export const englishMessages: Messages = en;

const cache = new Map<Locale, Promise<Messages>>([["en", Promise.resolve(en)]]);

/**
 * The messages for a locale, loaded once per process (server) or page session
 * (browser) from their own content-hashed, immutably cached chunk, so they
 * never ride along in the RSC payload that every router.refresh() re-sends.
 * Translations are merged over English, so a missing key renders in English.
 */
export function loadMessages(locale: Locale): Promise<Messages> {
    let pending = cache.get(locale);
    if (!pending) {
        pending = import("../../messages/zh-CN.json").then((zh) => withEnglishFallback(en, zh.default));
        cache.set(locale, pending);
    }
    return pending;
}
