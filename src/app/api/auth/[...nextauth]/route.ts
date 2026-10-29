import { NextRequest, NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { clearedLocaleCookieHeaders, isSecureRequest, localeCookieHeaders, withCookies } from "@/i18n/cookies";
import { readUserLocale } from "@/i18n/user-locale";

const handler = NextAuth(authOptions);

export { handler as GET };

export async function POST(req: NextRequest, context: any) {
    const rateLimit = consumeRateLimit({
        key: `auth:nextauth:${getClientIp(req)}`,
        limit: 20,
        windowMs: 10 * 60 * 1000,
    });
    if (!rateLimit.allowed) {
        return NextResponse.json(
            { error: "Too many authentication requests. Try again later." },
            {
                status: 429,
                headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
            },
        );
    }

    // The credentials form, read before next-auth consumes the body (sign-in only).
    // "callback/credentials", "signout", … (the part after /api/auth/).
    const action = (req.nextUrl.pathname.split("/api/auth/")[1] ?? "").replace(/\/+$/, "");
    const signIn = action === "callback/credentials" ? await req.clone().formData().catch(() => null) : null;

    const response = await handler(req, context);
    return mirrorLocaleCookie(req, response, action, signIn);
}

/** True when next-auth's response starts a session (sets a non-empty session-token cookie). */
function startsSession(response: Response): boolean {
    const cookies = response.headers.getSetCookie?.() ?? [response.headers.get("set-cookie") ?? ""];
    return cookies.some((cookie) => /^(__Secure-)?next-auth\.session-token=[^;]+/.test(cookie));
}

/**
 * Sign-in mirrors the person's saved UI language (users.locale) into the
 * NEXT_LOCALE cookie on the same response, so the first page already renders
 * in it; sign-out forgets it on this browser. Never blocks the auth response.
 */
async function mirrorLocaleCookie(req: NextRequest, response: Response, action: string, signIn: FormData | null): Promise<Response> {
    try {
        const secure = isSecureRequest(req);
        if (action === "signout") return withCookies(response, clearedLocaleCookieHeaders(secure));
        const email = signIn?.get("email");
        if (typeof email !== "string" || !email.trim() || !startsSession(response)) return response;
        const locale = await readUserLocale({ email });
        if (locale === undefined) return response;
        return withCookies(response, localeCookieHeaders(locale, secure));
    } catch (error) {
        console.error("[i18n] locale cookie on sign-in/out failed:", error);
        return response;
    }
}
