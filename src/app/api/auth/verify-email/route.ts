import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { verifyEmailVerificationToken } from "@/lib/email-verification";

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

export async function POST(req: NextRequest) {
    try {
        const { email: rawEmail, token } = await req.json();
        const email = normalizeEmail(rawEmail);
        const normalizedToken = String(token ?? "").trim();

        const rateLimit = consumeRateLimit({
            key: `auth:verify-email:${getClientIp(req)}:${email || "unknown"}`,
            limit: 15,
            windowMs: 15 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many verification attempts. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                },
            );
        }

        if (!email || !normalizedToken) {
            return NextResponse.json({ error: "Missing verification details." }, { status: 400 });
        }

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user) {
            return NextResponse.json({ error: "This verification link is invalid or expired." }, { status: 400 });
        }

        if (user.emailVerifiedAt) {
            return NextResponse.json({
                message: "Your email is already verified. You can log in.",
                alreadyVerified: true,
            }, { status: 200 });
        }

        const isValid = await verifyEmailVerificationToken(user.id, normalizedToken);
        if (!isValid) {
            return NextResponse.json({ error: "This verification link is invalid or expired." }, { status: 400 });
        }

        return NextResponse.json({
            message: "Email verified. You can now log in to Emperor Claw.",
        }, { status: 200 });
    } catch (err) {
        console.error("Verify email error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
