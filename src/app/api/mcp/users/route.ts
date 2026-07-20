import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { users, companyMembers } from "@/db/schema";
import { eq, and } from "drizzle-orm";

// GET /api/mcp/users — list company members for agent lookup
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("id");

    // Single user lookup
    if (userId) {
        const [member] = await db
            .select({
                id: users.id,
                email: users.email,
                displayName: users.displayName,
                roleTitle: users.roleTitle,
                instanceRole: users.instanceRole,
                companyRole: companyMembers.role,
            })
            .from(users)
            .innerJoin(companyMembers, and(
                eq(companyMembers.userId, users.id),
                eq(companyMembers.companyId, companyId),
            ))
            .where(eq(users.id, userId))
            .limit(1);

        if (!member) {
            return NextResponse.json({ error: "User not found" }, { status: 404 });
        }
        return NextResponse.json({ ok: true, user: member });
    }

    // List all company members
    const allMembers = await db
        .select({
            id: users.id,
            email: users.email,
            displayName: users.displayName,
            roleTitle: users.roleTitle,
            instanceRole: users.instanceRole,
            companyRole: companyMembers.role,
        })
        .from(users)
        .innerJoin(companyMembers, and(
            eq(companyMembers.userId, users.id),
            eq(companyMembers.companyId, companyId),
        ))
        .orderBy(users.displayName);

    return NextResponse.json({
        ok: true,
        users: allMembers.map(u => ({
            id: u.id,
            email: u.email,
            displayName: u.displayName,
            roleTitle: u.roleTitle,
            role: u.companyRole,
            instanceRole: u.instanceRole,
        })),
    });
}
