import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { cache } from "react";
import { getInstanceCompany, isSelfHosted } from "@/lib/instance";

// ── Types, hierarchy, matrix ──────────────────────────────────────────────
// The pure rules live in lib/role-matrix.ts (shared with the UI and tests).

import {
    getEffectiveRole,
    roleGte,
    type CompanyRole,
    type InstanceRole,
    type Role,
} from "@/lib/role-matrix";
import { normalizeMemberScope, type MemberScope } from "@/lib/member-scope";

export {
    PERMISSION_MATRIX,
    ROLE_HIERARCHY,
    canAdmin,
    canWrite,
    getEffectiveRole,
    hasPermission,
    roleGte,
} from "@/lib/role-matrix";
export type { CompanyRole, InstanceRole, Permission, Role } from "@/lib/role-matrix";

// ── AuthError ─────────────────────────────────────────────────────────────

export class AuthError extends Error {
    public statusCode: number;
    constructor(message: string, statusCode: 401 | 403 = 403) {
        super(message);
        this.name = "AuthError";
        this.statusCode = statusCode;
    }
}

// ── Route Guard ───────────────────────────────────────────────────────────
// requireRole returns an async guard function that validates the session
// and checks the user's effective role. Usage in API route handlers:
//
//   const ctx = await requireRole("admin")();
//   // ctx = { userId, companyId, role }

export interface GuardContext {
    userId: string;
    companyId: string;
    role: Role;
    /**
     * The member's access scope, read from the DB on every request (never the
     * login-time JWT copy, which goes stale when an admin edits it). null =
     * unrestricted; always null for admins and owners.
     */
    scope: MemberScope | null;
}

type RequestIdentity = {
    userId: string;
    instanceRole: InstanceRole;
    companyId: string | null;
    companyRole: CompanyRole | null;
    scopeJson: unknown;
};

/**
 * Who is calling, resolved once per request: the validated session, then ONE
 * query joining the user and their oldest membership. React cache() memoizes
 * it for the duration of a server render/request (and is a plain call outside
 * one), so several guards in one request share the lookup.
 *
 * An instance admin without a membership (self-hosted) acts in the instance
 * company, the same fallback getCompanyId applies, so pages and APIs agree.
 */
export const resolveRequestIdentity = cache(async (): Promise<RequestIdentity | null> => {
    const session = await getValidatedServerSession();
    const userId = session?.user?.id;
    if (!userId) return null;
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
    const instanceRole: InstanceRole = (row.instanceRole as InstanceRole) ?? "member";
    let companyId = row.companyId ?? null;
    if (!companyId && instanceRole === "instance_admin" && isSelfHosted()) {
        companyId = (await getInstanceCompany())?.id ?? null;
    }
    return { userId, instanceRole, companyId, companyRole: (row.companyRole as CompanyRole) ?? null, scopeJson: row.scopeJson };
});

export function requireRole(...requiredRoles: Role[]) {
    return async function guard(): Promise<GuardContext> {
        const identity = await resolveRequestIdentity();
        if (!identity) {
            throw new AuthError("Unauthorized — please log in.", 401);
        }
        const { userId, instanceRole, companyRole, companyId } = identity;

        if (!companyId) {
            throw new AuthError("No company membership found.", 403);
        }

        const effective = getEffectiveRole(instanceRole, companyRole);

        const hasSufficientRole = requiredRoles.some((r) => roleGte(effective, r));
        if (!hasSufficientRole) {
            throw new AuthError(
                `Forbidden — this action requires one of: ${requiredRoles.join(", ")}.`,
                403
            );
        }

        const scope = roleGte(effective, "admin") ? null : normalizeMemberScope(identity.scopeJson);
        return { userId, companyId, role: effective, scope };
    };
}

/**
 * Quick check: returns the effective role for the currently logged-in user.
 * Returns null if the user is not authenticated or has no company membership.
 */
export async function getCurrentUserEffectiveRole(): Promise<{
    userId: string;
    companyId: string;
    role: Role;
    instanceRole: InstanceRole;
    companyRole: CompanyRole | null;
} | null> {
    const session = await getValidatedServerSession();
    if (!session || !session.user?.id) return null;

    const userId = session.user.id;

    const [userRecord] = await db
        .select({ instanceRole: users.instanceRole })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);

    if (!userRecord) return null;

    const instanceRole: InstanceRole = (userRecord.instanceRole as InstanceRole) ?? "member";

    const [membership] = await db
        .select({ companyId: companyMembers.companyId, role: companyMembers.role })
        .from(companyMembers)
        .where(eq(companyMembers.userId, userId))
        .orderBy(companyMembers.createdAt)
        .limit(1);

    const companyRole: CompanyRole | null = (membership?.role as CompanyRole) ?? null;
    const companyId = membership?.companyId ?? null;

    if (!companyId) return null;

    const role = getEffectiveRole(instanceRole, companyRole);
    return { userId, companyId, role, instanceRole, companyRole };
}
