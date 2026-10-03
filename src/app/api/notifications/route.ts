import { NextRequest, NextResponse } from "next/server";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { isMissingSchemaError } from "@/lib/schema-compat";

export const dynamic = "force-dynamic";

/** The signed-in person's inbox: latest notifications and the unread count. */
export async function GET(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 30, 1), 100);
    try {
        const mine = and(eq(notifications.companyId, companyId), eq(notifications.userId, userId));
        const [rows, [unread]] = await Promise.all([
            db.select().from(notifications).where(mine).orderBy(desc(notifications.createdAt)).limit(limit),
            db.select({ value: count() }).from(notifications).where(and(mine, isNull(notifications.readAt))),
        ]);
        return NextResponse.json({ notifications: rows, unreadCount: Number(unread?.value) || 0 }, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
        // Before migration 0046 runs, the inbox is simply empty.
        if (isMissingSchemaError(error)) return NextResponse.json({ notifications: [], unreadCount: 0 });
        console.error("[notifications] list:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
