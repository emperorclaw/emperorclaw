import { NextRequest, NextResponse } from "next/server";
import { and, count, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { isMissingSchemaError } from "@/lib/schema-compat";
import { companyRouteAccess } from "@/lib/company-access";
import { filterNotificationsForMember } from "@/lib/member-scope";

export const dynamic = "force-dynamic";

/** The signed-in person's inbox: latest notifications and the unread count. */
export async function GET(req: NextRequest) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const userId = access.ctx.userId;
    const limit = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit")) || 30, 1), 100);
    try {
        const mine = and(eq(notifications.companyId, companyId), eq(notifications.userId, userId));
        const scope = access.ctx.scope;
        if (scope) {
            // A restricted member only sees notifications about agents, tasks,
            // approvals and messages inside their scope; the unread count matches.
            const all = await db.select().from(notifications).where(mine).orderBy(desc(notifications.createdAt)).limit(500);
            const visible = await filterNotificationsForMember(companyId, scope, all);
            return NextResponse.json({ notifications: visible.slice(0, limit), unreadCount: visible.filter((n) => !n.readAt).length },
                { headers: { "Cache-Control": "private, no-store" } });
        }
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
