import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { isSelfHosted } from "@/lib/instance";

// ── GET /api/instance/members — List members (admin+) ─────────────────────

export async function GET(_req: NextRequest) {
    try {
        const ctx = await requireRole("admin")();

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Member management is only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const memberships = await db
            .select({
                id: users.id,
                email: users.email,
                instanceRole: users.instanceRole,
                companyRole: companyMembers.role,
                joinedAt: companyMembers.createdAt,
            })
            .from(companyMembers)
            .innerJoin(users, eq(companyMembers.userId, users.id))
            .where(eq(companyMembers.companyId, ctx.companyId));

        const members = memberships.map((m) => ({
            id: m.id,
            email: m.email,
            companyRole: m.companyRole,
            instanceRole: m.instanceRole,
            joinedAt: m.joinedAt?.toISOString() ?? null,
        }));

        return NextResponse.json({ members }, { status: 200 });
    } catch (err) {
        if (err instanceof AuthError) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("List members error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

