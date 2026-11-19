import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { userSecurityEvents, userMfa } from "@/db/schema";
import { getValidatedServerSession } from "@/lib/auth";
export async function GET() {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) return NextResponse.json({ code: "SESSION_EXPIRED" }, { status: 401 });
    const [events, [mfa]] = await Promise.all([
        db.select({ id: userSecurityEvents.id, event: userSecurityEvents.event, createdAt: userSecurityEvents.createdAt, sessionCount: userSecurityEvents.sessionCount }).from(userSecurityEvents).where(eq(userSecurityEvents.userId, session.user.id)).orderBy(desc(userSecurityEvents.createdAt)).limit(30),
        db.select({ enabled: userMfa.enabled }).from(userMfa).where(eq(userMfa.userId, session.user.id)),
    ]);
    return NextResponse.json({ events, mfaEnabled: mfa?.enabled ?? false }, { headers: { "Cache-Control": "no-store" } });
}
