import { getValidatedServerSession, type SessionWithUserId } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { getCurrentUserEffectiveRole } from "@/lib/roles";
import MembersClient from "./members-client";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
    const session = await getValidatedServerSession();
    if (!session?.user?.id) {
        redirect("/login");
    }

    const roleCtx = await getCurrentUserEffectiveRole();
    if (!roleCtx) {
        redirect("/login");
    }

    // Only admin+ can access member management
    if (roleCtx.role !== "instance_admin" && roleCtx.role !== "owner" && roleCtx.role !== "admin") {
        redirect("/");
    }

    // Fetch members
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
        .where(eq(companyMembers.companyId, roleCtx.companyId));

    const members = memberships.map((m) => ({
        id: m.id,
        email: m.email,
        companyRole: m.companyRole,
        instanceRole: m.instanceRole,
        joinedAt: m.joinedAt?.toISOString() ?? null,
    }));

    return (
        <MembersClient
            currentUserId={roleCtx.userId}
            currentUserRole={roleCtx.role}
            companyId={roleCtx.companyId}
            initialMembers={members}
        />
    );
}
