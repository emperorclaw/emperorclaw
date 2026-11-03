import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { scheduleOrganizationNoteRefresh } from "@/lib/organization-note-schedule";
import { eq } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { requireRole } from "@/lib/roles";
import { canAdmin, canWrite } from "@/lib/role-matrix";
import { parseLocalePreference, type Locale } from "@/i18n/config";
import { isSecureRequest, localeCookieHeaders, withCookies } from "@/i18n/cookies";

// GET /api/user/profile — read own profile
export async function GET() {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [user] = await db
        .select({ displayName: users.displayName, roleTitle: users.roleTitle, email: users.email, id: users.id, locale: users.locale })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);

    if (!user) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // The caller's effective company role (from the DB), so the UI can hide
    // actions the server would refuse. Routes still enforce it themselves.
    const access = await requireRole("viewer")().catch(() => null);
    return NextResponse.json({
        ...user,
        role: access?.role ?? null,
        canWrite: canWrite(access?.role),
        canAdmin: canAdmin(access?.role),
        restricted: Boolean(access?.scope),
    });
}

// PATCH /api/user/profile — update own display name, role title and UI language (locale: "en" | "zh-CN" | null = automatic)
export async function PATCH(req: NextRequest) {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const updates: Record<string, any> = {};

    if (typeof body.displayName === "string") {
        updates.displayName = body.displayName.trim() || null;
    }
    if (typeof body.roleTitle === "string") {
        updates.roleTitle = body.roleTitle.trim() || null;
    }
    if ("locale" in body) {
        const locale = parseLocalePreference(body.locale);
        if (locale === undefined) {
            return NextResponse.json({ error: "Unsupported locale" }, { status: 400 });
        }
        updates.locale = locale;
    }

    if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const [updated] = await db.update(users)
        .set(updates)
        .where(eq(users.id, session.user.id))
        .returning({ id: users.id, displayName: users.displayName, roleTitle: users.roleTitle, email: users.email, locale: users.locale });

    // People appear on the org chart (and its note) by name and role.
    if ("displayName" in updates || "roleTitle" in updates) {
        const memberships = await db.select({ companyId: companyMembers.companyId }).from(companyMembers).where(eq(companyMembers.userId, session.user.id)).catch(() => []);
        for (const { companyId } of memberships) scheduleOrganizationNoteRefresh(companyId);
    }
    const res = NextResponse.json({ ok: true, user: updated });
    // Mirror the saved language in NEXT_LOCALE, so requests resolve it without a DB query.
    return "locale" in updates ? withCookies(res, localeCookieHeaders(updates.locale as Locale | null, isSecureRequest(req))) : res;
}
