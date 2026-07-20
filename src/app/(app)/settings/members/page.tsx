import { getValidatedServerSession, type SessionWithUserId } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, users, agents, customers } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
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
            displayName: users.displayName,
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
        displayName: m.displayName,
        companyRole: m.companyRole,
        instanceRole: m.instanceRole,
        joinedAt: m.joinedAt?.toISOString() ?? null,
    }));

    // Fetch agents and customers for scope picker
    const allAgents = await db.select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, roleCtx.companyId), isNull(agents.deletedAt)));
    
    const allCustomers = await db.select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(and(eq(customers.companyId, roleCtx.companyId), isNull(customers.deletedAt)));

    return (
        <MembersClient
            currentUserId={roleCtx.userId}
            currentUserRole={roleCtx.role}
            companyId={roleCtx.companyId}
            initialMembers={members}
            agents={allAgents}
            customersData={allCustomers}
        />
    );
}
