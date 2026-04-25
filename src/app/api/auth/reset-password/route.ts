import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users, passwordResets, sessions } from "@/db/schema";
import { eq, and, gt } from "drizzle-orm";
import { hash } from "argon2";
import { consumeRateLimit, getClientIp } from "@/lib/rate-limit";
import { recordOpsError } from "@/lib/ops-events";

function normalizeEmail(value: unknown): string {
    return String(value ?? "").trim().toLowerCase();
}

export async function POST(req: NextRequest) {
    try {
        const { email: rawEmail, token, newPassword } = await req.json();
        const email = normalizeEmail(rawEmail);

        const rateLimit = consumeRateLimit({
            key: `auth:reset:${getClientIp(req)}:${email || "unknown"}`,
            limit: 10,
            windowMs: 15 * 60 * 1000,
        });
        if (!rateLimit.allowed) {
            return NextResponse.json(
                { error: "Too many reset attempts. Try again later." },
                {
                    status: 429,
                    headers: { "Retry-After": Math.ceil(rateLimit.retryAfterMs / 1000).toString() },
                },
            );
        }

        if (!email || !token || !newPassword) {
            return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
        }

        if (newPassword.length < 8) {
            return NextResponse.json({ error: "Password must be at least 8 characters" }, { status: 400 });
        }

        // 1. Find user
        const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
        if (!user) {
            return NextResponse.json({ error: "Invalid reset request" }, { status: 400 });
        }

        // We can't directly query by hash using eq because Argon2 generates a salt.
        // Argon2 strings are unique even for the same input. 
        // Thus, we must fetch all unexpired tokens for the user and verify them.
        const now = new Date();
        const activeResets = await db.select().from(passwordResets)
            .where(and(
                eq(passwordResets.userId, user.id),
                gt(passwordResets.expiresAt, now)
            ));

        if (activeResets.length === 0) {
            return NextResponse.json({ error: "Link expired or invalid" }, { status: 400 });
        }

        let validResetId = null;
        const argon2 = await import("argon2");

        for (const resetRecord of activeResets) {
            try {
                if (await argon2.verify(resetRecord.tokenHash, token)) {
                    validResetId = resetRecord.id;
                    break;
                }
            } catch (e) {
                // Ignore hash verification failures
            }
        }

        if (!validResetId) {
            return NextResponse.json({ error: "Link expired or invalid" }, { status: 400 });
        }

        // 3. Hash new password
        const newPasswordHash = await hash(newPassword);

        await db.transaction(async (tx) => {
            // Update password
            await tx.update(users)
                .set({ passwordHash: newPasswordHash })
                .where(eq(users.id, user.id));

            // Clean up all pending reset links after a successful reset.
            await tx.delete(passwordResets)
                .where(eq(passwordResets.userId, user.id));

            // Best practice: Invalidate active sessions since password changed
            await tx.delete(sessions)
                .where(eq(sessions.userId, user.id));
        });

        return NextResponse.json({ message: "Password updated successfully" }, { status: 200 });

    } catch (err) {
        console.error("Reset password error:", err);
        void recordOpsError({
            category: "auth",
            source: "auth.reset-password",
            fallbackMessage: "Reset password flow failed",
            error: err,
            route: "/api/auth/reset-password",
            method: "POST",
        });
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
