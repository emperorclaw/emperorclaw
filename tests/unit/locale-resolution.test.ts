import { test } from "node:test";
import assert from "node:assert/strict";
import { isLocale, isValidTimeZone, localeFromAcceptLanguage, localeSyncDue, LOCALE_SYNC_INTERVAL_MS, parseLocalePreference, resolveLocale, resolveTimeZone } from "../../src/i18n/config";
import { clearedLocaleCookieHeaders, isSecureRequest, localeCookieHeaders } from "../../src/i18n/cookies";
import { withEnglishFallback } from "../../src/i18n/fallback";
import { ageParts, compactAgoParts, timeAgoParts } from "../../src/lib/i18n/relative-time";
import { timeAgo } from "../../src/lib/team-scene";
import { formatAge } from "../../src/lib/project-board-model";

test("locale order: saved preference, then the NEXT_LOCALE cookie, then Accept-Language, then English", () => {
    assert.equal(resolveLocale({ userLocale: "zh-CN", cookie: "en", acceptLanguage: "en-US" }), "zh-CN");
    // A freshly read "Automatic" beats a stale cookie from before the change (other device).
    assert.equal(resolveLocale({ userLocale: null, cookie: "zh-CN", acceptLanguage: "en-US" }), "en");
    // Not read (undefined): the cookie mirror decides.
    assert.equal(resolveLocale({ userLocale: undefined, cookie: "zh-CN", acceptLanguage: "en-US" }), "zh-CN");
    assert.equal(resolveLocale({ cookie: "en", acceptLanguage: "zh-CN,zh;q=0.9" }), "en");
    assert.equal(resolveLocale({ cookie: undefined, acceptLanguage: "zh-TW,zh;q=0.9,en;q=0.8" }), "zh-CN");
    assert.equal(resolveLocale({ acceptLanguage: "fr-FR,fr;q=0.9" }), "en");
    assert.equal(resolveLocale({}), "en");
});

test("an unsupported or tampered cookie falls through instead of breaking the page", () => {
    assert.equal(resolveLocale({ cookie: "de", acceptLanguage: "zh" }), "zh-CN");
    assert.equal(resolveLocale({ cookie: "auto", acceptLanguage: "en-GB" }), "en");
    assert.equal(resolveLocale({ cookie: "<script>", acceptLanguage: null }), "en");
    assert.equal(resolveLocale({ userLocale: "zh-TW", cookie: null, acceptLanguage: null }), "en");
});

test("Accept-Language honours q-values and maps every Chinese variant to zh-CN", () => {
    assert.equal(localeFromAcceptLanguage("fr;q=1, zh-Hans-CN;q=0.8, en;q=0.5"), "zh-CN");
    assert.equal(localeFromAcceptLanguage("en;q=0.4, zh-HK;q=0.9"), "zh-CN");
    assert.equal(localeFromAcceptLanguage("zh;q=0.2, en-US"), "en");
    assert.equal(localeFromAcceptLanguage("zh;q=0"), null);
    assert.equal(localeFromAcceptLanguage("*"), null);
    assert.equal(localeFromAcceptLanguage(""), null);
});

test("a saved preference is a supported locale or null (Automatic); anything else is rejected", () => {
    assert.equal(parseLocalePreference("zh-CN"), "zh-CN");
    assert.equal(parseLocalePreference("en"), "en");
    assert.equal(parseLocalePreference(null), null);
    assert.equal(parseLocalePreference("auto"), null);
    assert.equal(parseLocalePreference("de"), undefined);
    assert.equal(parseLocalePreference(42), undefined);
    assert.equal(isLocale("zh-cn"), false);
});

test("the mirrored preference is re-read from the database at most every sync interval", () => {
    const now = 1_800_000_000_000;
    assert.equal(localeSyncDue(undefined, now), true);
    assert.equal(localeSyncDue("garbage", now), true);
    assert.equal(localeSyncDue(String(now - 1000), now), false);
    assert.equal(localeSyncDue(String(now - LOCALE_SYNC_INTERVAL_MS - 1), now), true);
    assert.equal(localeSyncDue(String(now + 10 * 60_000), now), true, "a stamp from the future is not trusted");
});

test("dates use the browser's zone from EC_TZ, UTC until it is known or when it is invalid", () => {
    assert.equal(resolveTimeZone("Asia/Shanghai"), "Asia/Shanghai");
    assert.equal(resolveTimeZone(undefined), "UTC");
    assert.equal(resolveTimeZone("Mars/Base"), "UTC");
    assert.equal(resolveTimeZone("x".repeat(100)), "UTC");
    assert.equal(isValidTimeZone("America/New_York"), true);
});

test("preference cookies: Secure only over HTTPS, readable by the page, cleared on Automatic and sign-out", () => {
    const req = (url: string, proto?: string) => ({ url, headers: new Headers(proto ? { "x-forwarded-proto": proto } : {}) });
    assert.equal(isSecureRequest(req("https://emperor.example/api")), true);
    assert.equal(isSecureRequest(req("http://10.0.0.5:3000/api")), false);
    assert.equal(isSecureRequest(req("http://app:3000/api", "https")), true, "behind a TLS-terminating proxy");
    const [locale, stamp] = localeCookieHeaders("zh-CN", true, 1234);
    assert.match(locale, /^NEXT_LOCALE=zh-CN; Path=\/; Max-Age=\d+; SameSite=Lax; Secure$/);
    assert.match(stamp, /^EC_LOCALE_AT=1234; /);
    assert.doesNotMatch(locale, /HttpOnly/);
    assert.match(localeCookieHeaders(null, false)[0], /^NEXT_LOCALE=; Path=\/; Max-Age=0; SameSite=Lax$/);
    assert.ok(clearedLocaleCookieHeaders(false).every((cookie) => /Max-Age=0/.test(cookie)));
});

test("a missing translation renders the English message", () => {
    const english = { a: { b: "Hello", c: "World" }, d: "Done" };
    assert.deepEqual(withEnglishFallback(english, { a: { b: "你好", c: "" } }), { a: { b: "你好", c: "World" }, d: "Done" });
});

test("locale-aware relative time keeps the English helpers' exact thresholds", () => {
    const now = new Date("2026-10-29T12:00:00Z");
    const words = { justNow: () => "just now", minutesAgo: (n: number) => `${n}m ago`, hoursAgo: (n: number) => `${n}h ago`, daysAgo: (n: number) => `${n}d ago` };
    for (const minutes of [0, 0.5, 1, 59, 60, 61, 1439, 1440, 4000]) {
        const iso = new Date(now.getTime() - minutes * 60_000).toISOString();
        const { key, count } = timeAgoParts(iso, now);
        assert.equal(words[key](count), timeAgo(iso, now), `${minutes} minutes`);
    }
    const age = { ageNow: () => "now", minutesShort: (n: number) => `${n}m`, hoursShort: (n: number) => `${n}h`, daysShort: (n: number) => `${n}d`, weeksShort: (n: number) => `${n}w`, monthsShort: (n: number) => `${n}mo` };
    for (const minutes of [0, 1, 59, 60, 1439, 1440, 13 * 1440, 14 * 1440, 59 * 1440, 60 * 1440, 400 * 1440]) {
        const from = new Date(now.getTime() - minutes * 60_000);
        const parts = ageParts(from, now.getTime());
        assert.ok(parts);
        assert.equal(age[parts.key](parts.count), formatAge(from, now.getTime()), `${minutes} minutes`);
    }
    assert.equal(ageParts(null, now.getTime()), null);
    assert.deepEqual(compactAgoParts(new Date(now.getTime() - 90 * 60_000), now.getTime()), { key: "hoursShort", count: 2 });
    assert.deepEqual(compactAgoParts("not a date", now.getTime()), { key: "justNow", count: 0 });
});
