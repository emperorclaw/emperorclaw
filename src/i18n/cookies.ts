import { LOCALE_COOKIE, LOCALE_SYNC_COOKIE, PREFERENCE_COOKIE_MAX_AGE, type Locale } from "./config";

/**
 * Set-Cookie values for the mirrored language preference. Not HttpOnly: the
 * value is not sensitive and the public pages read it in the browser. Secure
 * whenever the request arrived over HTTPS (directly or behind a proxy); a
 * plain-HTTP self-hosted install still gets a working cookie.
 */
export function isSecureRequest(req: { url: string; headers: Headers }): boolean {
    const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    if (forwarded) return forwarded === "https";
    try {
        return new URL(req.url).protocol === "https:";
    } catch {
        return false;
    }
}

function serialize(name: string, value: string, maxAge: number, secure: boolean): string {
    return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** The cookies that mirror a saved preference (null = Automatic: NEXT_LOCALE is cleared), stamped as synced now. */
export function localeCookieHeaders(locale: Locale | null, secure: boolean, nowMs = Date.now()): string[] {
    return [
        locale ? serialize(LOCALE_COOKIE, locale, PREFERENCE_COOKIE_MAX_AGE, secure) : serialize(LOCALE_COOKIE, "", 0, secure),
        serialize(LOCALE_SYNC_COOKIE, String(nowMs), PREFERENCE_COOKIE_MAX_AGE, secure),
    ];
}

/** Sign-out: forget the mirrored preference on this browser. */
export function clearedLocaleCookieHeaders(secure: boolean): string[] {
    return [serialize(LOCALE_COOKIE, "", 0, secure), serialize(LOCALE_SYNC_COOKIE, "", 0, secure)];
}

/** Append Set-Cookie headers to a response (a fresh copy when its headers are immutable). */
export function withCookies(response: Response, cookies: string[]): Response {
    try {
        for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
        return response;
    } catch {
        const headers = new Headers(response.headers);
        for (const cookie of cookies) headers.append("Set-Cookie", cookie);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
}
