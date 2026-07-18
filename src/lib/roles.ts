import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers, users } from "@/db/schema";
import { eq } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────

export type InstanceRole = "instance_admin" | "member";
export type CompanyRole = "owner" | "admin" | "member" | "viewer";
export type Role = InstanceRole | CompanyRole;

export type Permission =
    | "instance:settings:write"
    | "users:invite"
    | "users:remove"
    | "users:role:change"
    | "projects:all:write"
    | "projects:own:write"
    | "projects:read"
    | "tokens:manage"
    | "agents:manage";

// ── Role Hierarchy ────────────────────────────────────────────────────────
// Ordered from highest to lowest. Higher roles inherit all permissions of lower roles.

export const ROLE_HIERARCHY: Role[] = [
    "instance_admin",
    "owner",
    "admin",
    "member",
    "viewer",
];

// ── Permission Matrix ─────────────────────────────────────────────────────
// Maps each permission to the set of roles that HAVE it.
// O(1) lookup via Set.has() — no linear scans (NFR-6).

export const PERMISSION_MATRIX: Record<Permission, ReadonlySet<Role>> = {
    "instance:settings:write": new Set<Role>(["instance_admin"]),
    "users:invite": new Set<Role>(["instance_admin", "owner", "admin"]),
    "users:remove": new Set<Role>(["instance_admin", "owner", "admin"]),
    "users:role:change": new Set<Role>(["instance_admin", "owner"]),
    "projects:all:write": new Set<Role>(["instance_admin", "owner", "admin"]),
    "projects:own:write": new Set<Role>(["instance_admin", "owner", "admin", "member"]),
    "projects:read": new Set<Role>(["instance_admin", "owner", "admin", "member", "viewer"]),
    "tokens:manage": new Set<Role>(["instance_admin", "owner", "admin"]),
    "agents:manage": new Set<Role>(["instance_admin", "owner", "admin", "member"]),
};

// ── Helpers ───────────────────────────────────────────────────────────────

const ROLE_INDEX = new Map<Role, number>(
    ROLE_HIERARCHY.map((r, i) => [r, i])
);

/**
 * Returns true if role `a` is >= role `b` in the hierarchy.
 * Lower index = higher rank.
 */
export function roleGte(a: Role, b: Role): boolean {
    const idxA = ROLE_INDEX.get(a) ?? ROLE_HIERARCHY.length;
    const idxB = ROLE_INDEX.get(b) ?? ROLE_HIERARCHY.length;
    return idxA <= idxB;
}

/**
 * Resolves the effective role for a user given their instance role and company role.
 * Returns the HIGHER of the two per the hierarchy (FR-23).
 */
export function getEffectiveRole(
    instanceRole: InstanceRole,
    companyRole: CompanyRole | null
): Role {
    if (instanceRole === "instance_admin") return "instance_admin";
    if (!companyRole) return instanceRole;
    // instance_admin already handled; compare company roles against member
    return roleGte(companyRole, instanceRole) ? companyRole : instanceRole;
}

/**
 * Checks whether a user has the given permission.
 * @param userInstanceRole - The user's instance_role from the users table
 * @param userCompanyRole - The user's company role from company_members (nullable)
 * @param permission - The permission to check
 */
export function hasPermission(
    userInstanceRole: InstanceRole,
    userCompanyRole: CompanyRole | null,
    permission: Permission
): boolean {
    const effective = getEffectiveRole(userInstanceRole, userCompanyRole);
    const allowedRoles = PERMISSION_MATRIX[permission];
    if (!allowedRoles) return false;

    // The effective role grants the permission if it OR any higher role is in the set.
    // Since higher roles inherit lower roles' permissions, we check: is effective >= some role that has the permission?
    for (const allowedRole of allowedRoles) {
        if (roleGte(effective, allowedRole)) return true;
    }
    return false;
}

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
}

export function requireRole(...requiredRoles: Role[]) {
    return async function guard(): Promise<GuardContext> {
        const session = await getValidatedServerSession();
        if (!session || !session.user?.id) {
            throw new AuthError("Unauthorized — please log in.", 401);
        }

        const userId = session.user.id;

        // Get user's instance role
        const [userRecord] = await db
            .select({ instanceRole: users.instanceRole })
            .from(users)
            .where(eq(users.id, userId))
            .limit(1);

        const instanceRole: InstanceRole = (userRecord?.instanceRole as InstanceRole) ?? "member";

        // Get company membership
        const [membership] = await db
            .select({ companyId: companyMembers.companyId, role: companyMembers.role })
            .from(companyMembers)
            .where(eq(companyMembers.userId, userId))
            .limit(1);

        const companyRole: CompanyRole | null = (membership?.role as CompanyRole) ?? null;
        const companyId = membership?.companyId ?? null;

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

        return { userId, companyId, role: effective };
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
        .limit(1);

    const companyRole: CompanyRole | null = (membership?.role as CompanyRole) ?? null;
    const companyId = membership?.companyId ?? null;

    if (!companyId) return null;

    const role = getEffectiveRole(instanceRole, companyRole);
    return { userId, companyId, role, instanceRole, companyRole };
}
