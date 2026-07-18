import { NextRequest, NextResponse } from "next/server";
import { validateInviteToken, InvitationError } from "@/lib/invitations";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

export async function GET(req: NextRequest) {
    try {
        const url = new URL(req.url);
        const token = url.searchParams.get("token") || "";
        const email = url.searchParams.get("email") || undefined;

        // Rate limit: 30/hr per IP (NFR-5)
        const rateLimit = consumeRateLimit({
            key: `auth:validate-invite:${getClientIp(req)}`,
            limit: 30,
            windowMs: 60 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many requests. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                }
            );
        }

        if (!token) {
            return NextResponse.json({ valid: false, reason: "not_found" }, { status: 200 });
        }

        const result = await validateInviteToken(token, email);

        if (!result.valid) {
            return NextResponse.json(
                { valid: false, reason: result.reason },
                { status: 200 }
            );
        }

        return NextResponse.json({
            valid: true,
            email: result.email,
            role: result.role,
            companyName: result.companyName,
        }, { status: 200 });
    } catch (err) {
        if (err instanceof InvitationError) {
            return NextResponse.json(
                { error: err.message },
                { status: err.statusCode }
            );
        }
        console.error("Validate-invite error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
