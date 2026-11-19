import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, gt, ne } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { getValidatedServerSession } from "@/lib/auth";
import { consumeRateLimit } from "@/lib/rate-limit";
import { AccountSecurityError, isSameOriginRequest, reauthenticate, recordSecurityEvent } from "@/lib/account-security";
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
export async function GET() {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) return reply({ code: "SESSION_EXPIRED" }, 401);
    const rows = await db.select({ id: sessions.id, createdAt: sessions.createdAt, lastSeenAt: sessions.lastSeenAt, expiresAt: sessions.expiresAt, userAgent: sessions.userAgent }).from(sessions)
        .where(and(eq(sessions.userId, session.user.id), gt(sessions.expiresAt, new Date()))).orderBy(desc(sessions.lastSeenAt)).limit(100);
    return reply({ sessions: rows.map((row) => ({ ...row, current: row.id === session.sessionId })) });
}
const schema = z.object({ sessionId: z.string().uuid().optional(), others: z.boolean().optional(), password: z.string().min(1).max(1024), code: z.string().max(100).default("") }).strict()
    .refine((value) => Boolean(value.sessionId) !== Boolean(value.others));
export async function DELETE(req: NextRequest) {
    if (!isSameOriginRequest(req)) return reply({ code: "INVALID_ORIGIN" }, 403);
    const session = await getValidatedServerSession();
    if (!session?.user?.id || !session.sessionId) return reply({ code: "SESSION_EXPIRED" }, 401);
    const userId = session.user.id;
    if (!consumeRateLimit({ key: `account:revoke:${userId}`, limit: 10, windowMs: 15 * 60_000 }).allowed) return reply({ code: "RATE_LIMITED" }, 429);
    const parsed = schema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return reply({ code: "INVALID_REQUEST" }, 400);
    try {
        const removed = await db.transaction(async (tx) => {
            // Check ownership before consuming a one-time code.
            if (parsed.data.sessionId) {
                const [target] = await tx.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.id, parsed.data.sessionId), eq(sessions.userId, userId)));
                if (!target) return null;
            }
            await reauthenticate(tx, userId, session.sessionId!, parsed.data.password, parsed.data.code);
            const rows = await tx.delete(sessions).where(and(eq(sessions.userId, userId), parsed.data.others ? ne(sessions.id, session.sessionId!) : eq(sessions.id, parsed.data.sessionId!))).returning({ id: sessions.id });
            await recordSecurityEvent(tx, userId, "sessions_revoked", rows.length);
            return rows;
        });
        if (removed === null) return reply({ code: "SESSION_NOT_FOUND" }, 404);
        return reply({ ok: true, signedOut: removed.some((row) => row.id === session.sessionId) });
    } catch (error) {
        if (error instanceof AccountSecurityError) return reply({ code: error.code }, error.status);
        console.error("[account] session revocation failed");
        return reply({ code: "REQUEST_FAILED" }, 500);
    }
}
