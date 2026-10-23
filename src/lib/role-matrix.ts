// Pure role/permission rules (no DB, no session): imported by lib/roles.ts for
// the route guards, by the UI to decide what to render, and by unit tests.

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

// Ordered from highest to lowest. Higher roles inherit all permissions of lower roles.
export const ROLE_HIERARCHY: Role[] = [
    "instance_admin",
    "owner",
    "admin",
    "member",
    "viewer",
];

// Maps each permission to the set of roles that HAVE it.
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

const ROLE_INDEX = new Map<Role, number>(ROLE_HIERARCHY.map((r, i) => [r, i]));

/** True if role `a` is >= role `b` in the hierarchy (lower index = higher rank). */
export function roleGte(a: Role, b: Role): boolean {
    const idxA = ROLE_INDEX.get(a) ?? ROLE_HIERARCHY.length;
    const idxB = ROLE_INDEX.get(b) ?? ROLE_HIERARCHY.length;
    return idxA <= idxB;
}

/**
 * The effective role of a user in their company.
 *
 * `instance_admin` outranks everything. Otherwise the COMPANY role decides:
 * the instance role "member" is only the default instance tier every account
 * has, not a company permission level, so it must never lift a company
 * "viewer" up to "member" (that silently turned every viewer into a member who
 * could create, edit and delete). With no company role the instance role is
 * returned (route guards still refuse callers without a membership).
 */
export function getEffectiveRole(instanceRole: InstanceRole, companyRole: CompanyRole | null): Role {
    if (instanceRole === "instance_admin") return "instance_admin";
    if (!companyRole) return instanceRole;
    return companyRole;
}

export function hasPermission(
    userInstanceRole: InstanceRole,
    userCompanyRole: CompanyRole | null,
    permission: Permission,
): boolean {
    const effective = getEffectiveRole(userInstanceRole, userCompanyRole);
    const allowedRoles = PERMISSION_MATRIX[permission];
    if (!allowedRoles) return false;
    for (const allowedRole of allowedRoles) {
        if (roleGte(effective, allowedRole)) return true;
    }
    return false;
}

/** Anything that changes company data needs at least "member"; viewers only read. */
export function canWrite(role: Role | null | undefined): boolean {
    return Boolean(role) && roleGte(role as Role, "member");
}

/** Owners/admins (and instance admins) manage the company: settings, tokens, members. */
export function canAdmin(role: Role | null | undefined): boolean {
    return Boolean(role) && roleGte(role as Role, "admin");
}
