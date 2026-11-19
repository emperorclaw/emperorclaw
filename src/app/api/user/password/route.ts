import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { hash, verify } from "argon2";
import { z } from "zod";
import { db } from "@/db";
import { users, sessions, passwordResets } from "@/db/schema";
import { getValidatedServerSession } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/rate-limit";
import { AccountSecurityError, isSameOriginRequest, reauthenticate, recordSecurityEvent } from "@/lib/account-security";
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from "@/lib/password-policy";

const schema = z.object({ currentPassword: z.string().min(1).max(1024), newPassword: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH), code: z.string().max(100).default("") }).strict();
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function POST(req: NextRequest) {
    if (!isSameOriginRequest(req)) return reply({ code: "INVALID_ORIGIN" }, 403);
    const session = await getValidatedServerSession();
    if (!session?.user?.id || !session.sessionId) return reply({ code: "SESSION_EXPIRED" }, 401);
    const userId = session.user.id;
    if (!consumeRateLimit({ key: `account:password:${userId}`, limit: 5, windowMs: 15 * 60_000 }).allowed) return reply({ code: "RATE_LIMITED" }, 429);
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return reply({ code: "INVALID_PASSWORD_REQUEST" }, 400);
    try {
        await db.transaction(async (tx) => {
            const user = await reauthenticate(tx, userId, session.sessionId!, parsed.data.currentPassword, parsed.data.code);
            if (await verify(user.passwordHash, parsed.data.newPassword)) throw new AccountSecurityError("PASSWORD_UNCHANGED");
            await tx.update(users).set({ passwordHash: await hash(parsed.data.newPassword) }).where(eq(users.id, userId));
            await tx.delete(passwordResets).where(eq(passwordResets.userId, userId));
            const revoked = await tx.delete(sessions).where(eq(sessions.userId, userId)).returning({ id: sessions.id });
            await recordSecurityEvent(tx, userId, "password_changed", revoked.length);
        });
        return reply({ ok: true, signedOut: true });
    } catch (error) {
        if (error instanceof AccountSecurityError) return reply({ code: error.code }, error.status);
        console.error("[account] password change failed");
        return reply({ code: "REQUEST_FAILED" }, 500);
    }
}
