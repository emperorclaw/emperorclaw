import { NextRequest, NextResponse } from "next/server";
import { getValidatedServerSession } from "@/lib/auth";
import { isSecureRequest, localeCookieHeaders, withCookies } from "@/i18n/cookies";
import { readUserLocale } from "@/i18n/user-locale";

/**
 * POST /api/i18n/sync — mirror the signed-in person's saved UI language
 * (users.locale) into the NEXT_LOCALE cookie and stamp EC_LOCALE_AT. The app
 * shell calls it after a render that had to re-read the preference (missing
 * or stale mirror, e.g. it was changed on another device).
 */
export async function POST(req: NextRequest) {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const locale = await readUserLocale({ userId: session.user.id });
    if (locale === undefined) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return withCookies(NextResponse.json({ locale }), localeCookieHeaders(locale, isSecureRequest(req)));
}
