import { NextRequest } from "next/server";
import { exchangeMobileCode, refreshMobileToken } from "@/lib/mobile-auth";
import { mobileJson, mobileError } from "@/lib/mobile-response";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

export async function POST(request: NextRequest) {
    const rate = consumeRateLimit({ key: `mobile:token:${getClientIp(request)}`, limit: 30, windowMs: 60_000 });
    if (!rate.allowed) return mobileJson({ error: "Too many requests" }, 429);
    try {
        const body = await request.json();
        if (!body || typeof body !== "object") return mobileJson({ error: "Invalid request" }, 400);
        if (body.grantType === "authorization_code" && typeof body.code === "string" && body.code.length <= 128 && typeof body.verifier === "string") {
            return mobileJson(await exchangeMobileCode(body.code, body.verifier));
        }
        if (body.grantType === "refresh_token" && typeof body.refreshToken === "string" && /^emr_[A-Za-z0-9_-]{43}$/.test(body.refreshToken)) {
            return mobileJson(await refreshMobileToken(body.refreshToken));
        }
        return mobileJson({ error: "Invalid grant request" }, 400);
    } catch (error) { return mobileError(error); }
}
