import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { notificationPreferences } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { isEmailConfigured } from "@/lib/email";
import { DEFAULT_EMAIL_KINDS, NOTIFICATION_KIND_LABELS, NOTIFICATION_KINDS } from "@/lib/notifications";

export const dynamic = "force-dynamic";

/** Which kinds reach you by email (everything always lands in the in-app inbox). */
export async function GET() {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const [row] = await db.select().from(notificationPreferences)
        .where(and(eq(notificationPreferences.companyId, companyId), eq(notificationPreferences.userId, userId))).limit(1);
    return NextResponse.json({
        emailConfigured: isEmailConfigured(),
        emailKinds: row?.emailKinds ?? DEFAULT_EMAIL_KINDS,
        kinds: NOTIFICATION_KINDS.map((kind) => ({ kind, label: NOTIFICATION_KIND_LABELS[kind] })),
    });
}

export async function PUT(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const body = await req.json().catch(() => ({}));
    if (!Array.isArray(body.emailKinds)) return NextResponse.json({ error: "emailKinds must be a list" }, { status: 400 });
    const emailKinds = [...new Set(body.emailKinds.filter((k: unknown): k is string => typeof k === "string" && (NOTIFICATION_KINDS as readonly string[]).includes(k)))] as string[];
    await db.insert(notificationPreferences).values({ companyId, userId, emailKinds })
        .onConflictDoUpdate({ target: [notificationPreferences.companyId, notificationPreferences.userId], set: { emailKinds, updatedAt: new Date() } });
    return NextResponse.json({ ok: true, emailKinds });
}
