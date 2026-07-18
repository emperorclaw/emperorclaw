import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { isSelfHosted } from "@/lib/instance";

// ── PUT /api/instance/members/[userId]/role — Change role ─────────────────

export async function PUT(
    req: NextRequest,
    { params }: { params: Promise<{ userId: string }> }
) {
    try {
        const ctx = await requireRole("instance_admin", "owner")();

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Member management is only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const { userId } = await params;
        const body = await req.json();
        const { role, instanceRole } = body;

        // Validate role values
        const validCompanyRoles = ["owner", "admin", "member", "viewer"];

        if (role && !validCompanyRoles.includes(role)) {
            return NextResponse.json(
                { error: "Invalid company role. Allowed values: owner, admin, member, viewer." },
                { status: 400 }
            );
        }

        // Last-admin guard (FR-24, EC-4, EC-5)
        if (instanceRole && instanceRole !== "instance_admin") {
            // User being demoted from instance_admin — check it's not the last
            const [targetUser] = await db
                .select({ instanceRole: users.instanceRole })
                .from(users)
                .where(eq(users.id, userId))
                .limit(1);

            if (targetUser?.instanceRole === "instance_admin") {
                const adminRows = await db
                    .select()
                    .from(users)
                    .where(
                        and(
                            eq(users.instanceRole, "instance_admin"),
                            isNull(users.deletedAt)
                        )
                    );

                if (adminRows.length <= 1) {
                    return NextResponse.json(
                        {
                            error: "Cannot remove the last instance admin. Promote another user to instance_admin first.",
                        },
                        { status: 422 }
                    );
                }
            }
        }

        // Update company role
        if (role) {
            await db
                .update(companyMembers)
                .set({ role })
                .where(
                    and(
                        eq(companyMembers.userId, userId),
                        eq(companyMembers.companyId, ctx.companyId)
                    )
                );
        }

        // Update instance role
        if (instanceRole) {
            await db
                .update(users)
                .set({ instanceRole })
                .where(eq(users.id, userId));
        }

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (err) {
        if (err instanceof AuthError) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("Update member role error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// ── DELETE /api/instance/members/[userId] — Remove member ─────────────────

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ userId: string }> }
) {
    try {
        const ctx = await requireRole("admin")();

        if (!isSelfHosted()) {
            return NextResponse.json(
                { error: "Member management is only available in self-hosted deployments." },
                { status: 403 }
            );
        }

        const { userId } = await params;

        // Last-admin guard
        const [targetUser] = await db
            .select({ instanceRole: users.instanceRole })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        if (targetUser?.instanceRole === "instance_admin") {
            const adminRows = await db
                .select()
                .from(users)
                .where(
                    and(
                        eq(users.instanceRole, "instance_admin"),
                        isNull(users.deletedAt)
                    )
                );

            if (adminRows.length <= 1) {
                return NextResponse.json(
                    {
                        error: "Cannot remove the last instance admin. Promote another user to instance_admin first.",
                    },
                    { status: 422 }
                );
            }
        }

        // Remove membership
        await db
            .delete(companyMembers)
            .where(
                and(
                    eq(companyMembers.userId, userId),
                    eq(companyMembers.companyId, ctx.companyId)
                )
            );

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (err) {
        if (err instanceof AuthError) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("Remove member error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
