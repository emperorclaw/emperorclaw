import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { notifications } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";

/** Mark notifications read: { ids: string[] } or { all: true }. Only your own. */
export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.filter((id: unknown): id is string => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 200) : [];
    if (!body.all && ids.length === 0) return NextResponse.json({ error: "Pass ids or all: true" }, { status: 400 });
    const conditions = [eq(notifications.companyId, companyId), eq(notifications.userId, userId), isNull(notifications.readAt)];
    if (!body.all) conditions.push(inArray(notifications.id, ids));
    const updated = await db.update(notifications).set({ readAt: new Date() }).where(and(...conditions)).returning({ id: notifications.id });
    return NextResponse.json({ ok: true, updated: updated.length });
}
