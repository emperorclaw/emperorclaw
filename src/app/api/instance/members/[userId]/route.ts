import { NextRequest, NextResponse } from "next/server";
import { requireRole, AuthError } from "@/lib/roles";
import { db } from "@/db";
import { agentAccess, agents, companyMembers, companyTokens, resourceMemberships, sessions, tasks, users } from "@/db/schema";
import { and, eq, isNull, ne } from "drizzle-orm";
import { isSelfHosted } from "@/lib/instance";
import { archivePrivateThreadsOf } from "@/lib/control-plane";
import { humanActor, recordMemberAudit } from "@/lib/audit";

/** How many owners the company has besides `exceptUserId`. */
async function otherOwnerCount(companyId: string, exceptUserId: string): Promise<number> {
    const rows = await db.select({ id: companyMembers.id }).from(companyMembers).where(and(
        eq(companyMembers.companyId, companyId),
        eq(companyMembers.role, "owner"),
        ne(companyMembers.userId, exceptUserId),
    ));
    return rows.length;
}

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
        const { role, instanceRole, displayName, roleTitle } = body;

        // Validate role values
        const validCompanyRoles = ["owner", "admin", "member", "viewer"];

        if (role && !validCompanyRoles.includes(role)) {
            return NextResponse.json(
                { error: "Invalid company role. Allowed values: owner, admin, member, viewer." },
                { status: 400 }
            );
        }

        // The instance-level role outranks every company role, so only an
        // instance admin may grant or revoke it — otherwise an owner could
        // promote themselves (or anyone) to instance_admin. The target must
        // also be a member of the caller's company.
        if (instanceRole !== undefined) {
            if (ctx.role !== "instance_admin") {
                return NextResponse.json(
                    { error: "Only an instance admin can change instance roles." },
                    { status: 403 }
                );
            }
            if (instanceRole !== "instance_admin" && instanceRole !== "member") {
                return NextResponse.json(
                    { error: "Invalid instance role. Allowed values: instance_admin, member." },
                    { status: 400 }
                );
            }
            const [targetMembership] = await db
                .select({ id: companyMembers.id })
                .from(companyMembers)
                .where(and(
                    eq(companyMembers.userId, userId),
                    eq(companyMembers.companyId, ctx.companyId),
                ))
                .limit(1);
            if (!targetMembership) {
                return NextResponse.json({ error: "Member not found" }, { status: 404 });
            }
        }

        // Every change (role, profile) targets a member of the caller's company.
        const [target] = await db
            .select({ role: companyMembers.role })
            .from(companyMembers)
            .where(and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, ctx.companyId)))
            .limit(1);
        if (!target) {
            return NextResponse.json({ error: "Member not found" }, { status: 404 });
        }

        // Last-owner guard: a company always keeps at least one owner.
        if (role && role !== "owner" && target.role === "owner" && (await otherOwnerCount(ctx.companyId, userId)) === 0) {
            return NextResponse.json(
                { error: "Cannot demote the last owner. Make another member an owner first." },
                { status: 422 }
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
        if ((role && role !== target.role) || instanceRole) await recordMemberAudit(ctx.companyId, humanActor(ctx.userId), "member.role_changed", userId, { role: target.role }, { role: role || target.role, instanceRole: instanceRole || undefined });

        // Update profile fields
        const profileUpdates: Record<string, any> = {};
        if (displayName !== undefined) profileUpdates.displayName = displayName || null;
        if (roleTitle !== undefined) profileUpdates.roleTitle = roleTitle || null;
        if (Object.keys(profileUpdates).length > 0) {
            await db.update(users).set(profileUpdates).where(eq(users.id, userId));
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

        const [targetMembership] = await db
            .select({ role: companyMembers.role })
            .from(companyMembers)
            .where(and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, ctx.companyId)))
            .limit(1);
        if (!targetMembership) {
            return NextResponse.json({ error: "Member not found" }, { status: 404 });
        }
        // Only an owner (or instance admin) may remove an owner, and never the last one.
        if (targetMembership.role === "owner") {
            if (ctx.role !== "owner" && ctx.role !== "instance_admin") {
                return NextResponse.json({ error: "Only an owner can remove another owner." }, { status: 403 });
            }
            if ((await otherOwnerCount(ctx.companyId, userId)) === 0) {
                return NextResponse.json(
                    { error: "Cannot remove the last owner. Make another member an owner first." },
                    { status: 422 }
                );
            }
        }

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

        // Removing a person from the company also releases work assigned to
        // that membership. The FK provides a final safety net, while doing it
        // explicitly keeps updated_at accurate for dashboards and sync.
        await db.transaction(async (tx) => {
            const [membership] = await tx.select({ id: companyMembers.id })
                .from(companyMembers)
                .where(and(
                    eq(companyMembers.userId, userId),
                    eq(companyMembers.companyId, ctx.companyId),
                ))
                .limit(1);

            if (membership) {
                await tx.update(tasks).set({
                    assignedMemberId: null,
                    updatedAt: new Date(),
                }).where(and(
                    eq(tasks.companyId, ctx.companyId),
                    eq(tasks.assignedMemberId, membership.id),
                ));
            }

            await tx.delete(companyMembers).where(and(
                eq(companyMembers.userId, userId),
                eq(companyMembers.companyId, ctx.companyId),
            ));
            // Their roles on clients/projects and their place on agents' "Who can
            // use it" lists go too (0.20): a later re-invite starts from nothing.
            await tx.delete(resourceMemberships).where(and(eq(resourceMemberships.companyId, ctx.companyId), eq(resourceMemberships.userId, userId)));
            await tx.delete(agentAccess).where(and(eq(agentAccess.companyId, ctx.companyId), eq(agentAccess.userId, userId)));
            // Agents they own lose their owner: a limited one becomes an orphan
            // an admin can recover (lib/agent-access.ts), never theirs again.
            await tx.update(agents).set({ ownerUserId: null }).where(and(eq(agents.companyId, ctx.companyId), eq(agents.ownerUserId, userId)));
            // Their private chats with agents are kept but hidden from everyone.
            await archivePrivateThreadsOf(ctx.companyId, userId, tx);
            // Tokens they minted (screens, integrations) stop working too.
            await tx.update(companyTokens).set({ revokedAt: new Date() }).where(and(
                eq(companyTokens.companyId, ctx.companyId),
                eq(companyTokens.createdByUserId, userId),
                isNull(companyTokens.revokedAt),
            ));
            // Sign them out everywhere: an open browser session must not keep
            // reaching company data after removal.
            await tx.delete(sessions).where(eq(sessions.userId, userId));
        });
        await recordMemberAudit(ctx.companyId, humanActor(ctx.userId), "member.removed", userId, { role: targetMembership.role }, null);

        return NextResponse.json({ success: true }, { status: 200 });
    } catch (err) {
        if (err instanceof AuthError) {
            return NextResponse.json({ error: err.message }, { status: err.statusCode });
        }
        console.error("Remove member error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
