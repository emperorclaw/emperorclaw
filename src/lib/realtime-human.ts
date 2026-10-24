import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { getEffectiveRole, roleGte, type CompanyRole, type Role } from "@/lib/role-matrix";
import { getInstanceCompany, isSelfHosted } from "@/lib/instance";
import { memberVisibleProjectIds, normalizeMemberScope, type MemberScope } from "@/lib/member-scope";

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
    /** Projects visible through the member's customers (member-scope projects follow their customer). */
    allowedProjectIds: ReadonlySet<string> | null;
};

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
    const scope = roleGte(role, "admin") ? null : normalizeMemberScope(row.scopeJson);
    return {
        userId,
        companyId,
        role,
        scope,
        allowedAgentIds: scope ? new Set(scope.agentIds ?? []) : null,
        allowedCustomerIds: scope ? new Set(scope.customerIds ?? []) : null,
        allowedProjectIds: scope ? await memberVisibleProjectIds(companyId, scope) : null,
    };
}
