import { NextRequest, NextResponse } from "next/server";
import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";

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

    return handler(req, context);
}
