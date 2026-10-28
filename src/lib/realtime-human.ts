import { db } from "@/db";
import { agentAccess, agents, companyMembers, projects, users } from "@/db/schema";
import { and, asc, eq, inArray, isNull, ne } from "drizzle-orm";
import { getEffectiveRole, roleGte, type CompanyRole, type Role } from "@/lib/role-matrix";
import { getInstanceCompany, isSelfHosted } from "@/lib/instance";
import { memberMaySeeAgent, memberVisibleProjectIds, resolveMemberScope, type MemberScope } from "@/lib/member-scope";
import { agentUse } from "@/lib/agent-access";

/**
 * The signed-in person's company access for a browser realtime socket, resolved
 * from the DB (never the login-time JWT copy) so an admin's role or scope edit
 * applies on the next refresh. Mirrors lib/roles.ts resolveRequestIdentity, but
 * takes the already-validated userId instead of reading the RSC session.
 */
export type HumanRealtimeContext = {
    userId: string;
    companyId: string;
    role: Role;
    scope: MemberScope | null;
    /** Member allow-lists expanded to allow-sets; null everywhere = unrestricted (admin/owner). */
    allowedAgentIds: ReadonlySet<string> | null;
    allowedCustomerIds: ReadonlySet<string> | null;
    /** Projects visible through the member's customers or a project membership. */
    allowedProjectIds: ReadonlySet<string> | null;
    /** Customers of the projects granted directly (lib/realtime-delivery.ts humanSocketReceives). */
    grantedProjectCustomerIds: ReadonlySet<string> | null;
    /** Agents limited to other people (lib/agent-access.ts): their DMs and status never reach this socket. */
    hiddenAgentIds: ReadonlySet<string>;
};

/** Limited agents (access not 'everyone') this person may not use. Plain query: server.ts loads this outside Next. */
async function hiddenAgentsFor(companyId: string, userId: string, role: Role, scope: MemberScope | null): Promise<Set<string>> {
    const limited = await db.select({ id: agents.id, access: agents.access, ownerUserId: agents.ownerUserId }).from(agents)
        .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt), ne(agents.access, "everyone")));
    if (limited.length === 0) return new Set();
    const mine = await db.select({ agentId: agentAccess.agentId }).from(agentAccess)
        .where(and(eq(agentAccess.companyId, companyId), eq(agentAccess.userId, userId), inArray(agentAccess.agentId, limited.map((a) => a.id))));
    const listed = new Set(mine.map((row) => row.agentId));
    const subject = { userId, isAdmin: roleGte(role, "admin") };
    return new Set(limited.filter((agent) => agentUse(subject, { ...agent, people: listed.has(agent.id) ? [userId] : [] }, memberMaySeeAgent(scope, agent.id)) !== "full").map((a) => a.id));
}

export async function resolveHumanRealtimeContext(userId: string): Promise<HumanRealtimeContext | null> {
    const [row] = await db
        .select({
            instanceRole: users.instanceRole,
            companyId: companyMembers.companyId,
            companyRole: companyMembers.role,
            scopeJson: companyMembers.scopeJson,
        })
        .from(users)
        .leftJoin(companyMembers, eq(companyMembers.userId, users.id))
        .where(eq(users.id, userId))
        .orderBy(asc(companyMembers.createdAt))
        .limit(1);
    if (!row) return null;

    const instanceRole = (row.instanceRole as "instance_admin" | "member") ?? "member";
    let companyId = row.companyId ?? null;
    if (!companyId && instanceRole === "instance_admin" && isSelfHosted()) {
        companyId = (await getInstanceCompany())?.id ?? null;
    }
    if (!companyId) return null;

    const role = getEffectiveRole(instanceRole, (row.companyRole as CompanyRole) ?? null);
    const scope = roleGte(role, "admin") ? null : await resolveMemberScope(companyId, userId, row.scopeJson);
    const granted = scope?.projectIds?.length
        ? await db.select({ customerId: projects.customerId }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, scope.projectIds)))
        : [];
    return {
        userId,
        companyId,
        role,
        scope,
        allowedAgentIds: scope ? new Set(scope.agentIds ?? []) : null,
        allowedCustomerIds: scope ? new Set(scope.customerIds ?? []) : null,
        allowedProjectIds: scope ? await memberVisibleProjectIds(companyId, scope) : null,
        grantedProjectCustomerIds: scope ? new Set(granted.map((g) => g.customerId).filter((id): id is string => Boolean(id))) : null,
        hiddenAgentIds: await hiddenAgentsFor(companyId, userId, role, scope),
    };
}
