import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";

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
    return NextResponse.json(user);
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
