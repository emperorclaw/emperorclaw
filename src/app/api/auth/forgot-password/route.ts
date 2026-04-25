import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, passwordResets } from "@/db/schema";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { hash } from "argon2";
import { sendEmail, getPasswordResetEmailHtml } from "@/lib/email";
import { getAppUrl } from "@/lib/env";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { recordOpsError } from "@/lib/ops-events";

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

export async function POST(req: NextRequest) {
    try {
        const { email: rawEmail } = await req.json();
        const email = normalizeEmail(rawEmail);

        const rateLimit = consumeRateLimit({
            key: `auth:forgot:${getClientIp(req)}:${email || "unknown"}`,
            limit: 5,
            windowMs: 15 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many reset requests. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                },
            );
        }

        if (!email) {
            return NextResponse.json({ error: "Email is required" }, { status: 400 });
        }

        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

        // Security best practice: Don't reveal whether an email exists or not
        if (!user) {
            return NextResponse.json({ message: "If an account with that email exists, a reset link has been sent." }, { status: 200 });
        }

        // Generate a secure random token
        const rawToken = crypto.randomBytes(32).toString('hex');
        const tokenHash = await hash(rawToken);

        // Set expiration (e.g., 2 hours)
        const expiresAt = new Date();
        expiresAt.setHours(expiresAt.getHours() + 2);

        await db.transaction(async (tx) => {
            await tx.delete(passwordResets).where(eq(passwordResets.userId, user.id));
            await tx.insert(passwordResets).values({
                userId: user.id,
                tokenHash,
                expiresAt,
            });
        });

        // Construct reset link
        const resetUrl = `${getAppUrl(req)}/reset-password?token=${rawToken}&email=${encodeURIComponent(email)}`;

        // Dispatch Email
        await sendEmail({
            to: email,
            subject: "Reset your Emperor Claw Password",
            html: getPasswordResetEmailHtml(email, resetUrl)
        });

        return NextResponse.json({ message: "If an account with that email exists, a reset link has been sent." }, { status: 200 });

    } catch (err) {
        console.error("Forgot password error:", err);
        void recordOpsError({
            category: "auth",
            source: "auth.forgot-password",
            fallbackMessage: "Forgot password flow failed",
            error: err,
            route: "/api/auth/forgot-password",
            method: "POST",
        });
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
