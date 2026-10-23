import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { requireRole } from "@/lib/roles";
import { canAdmin, canWrite } from "@/lib/role-matrix";

// GET /api/user/profile — read own profile
export async function GET() {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const [user] = await db
        .select({ displayName: users.displayName, roleTitle: users.roleTitle, email: users.email, id: users.id })
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

// PATCH /api/user/profile — update own display name and role title
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

    if (Object.keys(updates).length === 0) {
        return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const [updated] = await db.update(users)
        .set(updates)
        .where(eq(users.id, session.user.id))
        .returning({ id: users.id, displayName: users.displayName, roleTitle: users.roleTitle, email: users.email });

    return NextResponse.json({ ok: true, user: updated });
}
