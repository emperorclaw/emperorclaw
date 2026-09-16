import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyMembers } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { requireRole, AuthError } from "@/lib/roles";

// Authorization is resolved from the DB via requireRole (not the stale JWT
// companyRole claim), and every query is scoped to the caller's company so a
// member id from another tenant can never be read or written.

// GET /api/instance/members/[userId]/scope
export async function GET(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }

    const { userId } = await params;
    const [membership] = await db
        .select({ scopeJson: companyMembers.scopeJson })
        .from(companyMembers)
        .where(and(
            eq(companyMembers.userId, userId),
            eq(companyMembers.companyId, ctx.companyId),
        ))
        .limit(1);

    return NextResponse.json({ scope: membership?.scopeJson || {} });
}

// PUT /api/instance/members/[userId]/scope
export async function PUT(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }

    const { userId } = await params;
    const body = await req.json();
    const scopeJson = body.scope || {};

    const [updated] = await db.update(companyMembers)
        .set({ scopeJson })
        .where(and(
            eq(companyMembers.userId, userId),
            eq(companyMembers.companyId, ctx.companyId),
        ))
        .returning({ id: companyMembers.id });

    if (!updated) {
        return NextResponse.json({ error: "Member not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, scope: scopeJson });
}
