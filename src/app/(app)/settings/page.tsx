import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, companyTokens, users, agents, customers } from "@/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import SettingsClient from "./settings-client";
import { serializeCompanyToken } from "@/lib/mcp";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
    const session = await getValidatedServerSession();
    const sessionUserId = session?.user?.id;
    if (!sessionUserId) {
        redirect("/login");
    }

    const [membership] = await db.select().from(companyMembers)
        .where(eq(companyMembers.userId, sessionUserId))
        .limit(1);

    if (!membership) {
        return <div className="p-8 text-zinc-400">Company not found.</div>;
    }

    // Get instance role
    const [userRecord] = await db
        .select({ instanceRole: users.instanceRole })
        .from(users)
        .where(eq(users.id, sessionUserId))
        .limit(1);

    const tokens = await db.select().from(companyTokens)
        .where(and(
            eq(companyTokens.companyId, membership.companyId),
            isNull(companyTokens.revokedAt),
        ))
        .orderBy(desc(companyTokens.createdAt));

    // Fetch members, agents, customers for the members tab
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
        .where(eq(companyMembers.companyId, membership.companyId));
    
    const membersList = memberships.map((m) => ({
        id: m.id,
        email: m.email,
        companyRole: m.companyRole,
        instanceRole: m.instanceRole,
        joinedAt: m.joinedAt?.toISOString() ?? null,
    }));

    const allAgents = await db.select({ id: agents.id, name: agents.name })
        .from(agents)
        .where(and(eq(agents.companyId, membership.companyId), isNull(agents.deletedAt)));
    
    const allCustomers = await db.select({ id: customers.id, name: customers.name })
        .from(customers)
        .where(and(eq(customers.companyId, membership.companyId), isNull(customers.deletedAt)));

    const currentUserRole = userRecord?.instanceRole === "instance_admin" ? "instance_admin" : membership.role;

    return (
        <Suspense fallback={<div className="p-8"><div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-cyan-400/30 border-t-cyan-400" /></div>}>
            <SettingsClient
                initialTokens={tokens.map(serializeCompanyToken)}
                companyRole={membership.role}
                instanceRole={userRecord?.instanceRole ?? "member"}
                currentUserId={sessionUserId}
                currentUserRole={currentUserRole}
                companyId={membership.companyId}
                initialMembers={membersList}
                agents={allAgents}
                customersData={allCustomers}
            />
        </Suspense>
    );
}
