// Roles per client and project (0.20). Pure: no database, safe for client
// components and unit tests. lib/resource-access.ts gathers the facts (the
// caller's company role, restriction and resource_memberships rows) and the
// route guards go through effectiveResourceRole.
//
// One rule: inside a customer or project a person acts with
//   max(company role, their role on the project, their role on its customer)
// where editor ≡ member, viewer ≡ viewer and admin ≡ admin in the company
// hierarchy (lib/role-matrix.ts). A membership can ELEVATE (a company viewer
// with "Can edit" on Harbor Dental edits inside Harbor Dental) but only there:
// it never changes company-wide permissions.
//
// A restricted member (company_members.scope_json mode 'restricted') only
// sees the resources they hold a membership for, and there the membership
// role is the whole answer: their company role does not raise it, so "Can
// view" is read-only. Migration 0072 mapped member -> editor and viewer ->
// viewer, so nobody's existing rights changed.

import { roleGte, type Role } from "@/lib/role-matrix";

export const RESOURCE_TYPES = ["customer", "project"] as const;
export type ResourceType = (typeof RESOURCE_TYPES)[number];

export const RESOURCE_ROLES = ["admin", "editor", "viewer"] as const;
export type ResourceRole = (typeof RESOURCE_ROLES)[number];

export const RESOURCE_ROLE_LABELS: Record<ResourceRole, string> = {
    admin: "Admin",
    editor: "Can edit",
    viewer: "Can view",
};

export function isResourceRole(value: unknown): value is ResourceRole {
    return typeof value === "string" && (RESOURCE_ROLES as readonly string[]).includes(value);
}

export function isResourceType(value: unknown): value is ResourceType {
    return typeof value === "string" && (RESOURCE_TYPES as readonly string[]).includes(value);
}

/** The company role a resource role counts as. */
export function resourceRoleAsRole(role: ResourceRole): Role {
    return role === "admin" ? "admin" : role === "editor" ? "member" : "viewer";
}

/** The resource role a company role reaches inside a resource (owners and instance admins count as admin). */
export function roleAsResourceRole(role: Role): ResourceRole {
    if (roleGte(role, "admin")) return "admin";
    return roleGte(role, "member") ? "editor" : "viewer";
}

/** The highest of some roles (null when there are none). */
export function maxRole(roles: readonly Role[]): Role | null {
    let best: Role | null = null;
    for (const role of roles) if (!best || !roleGte(best, role)) best = role;
    return best;
}

export type MembershipFact = { resourceType: string; resourceId: string; role: string };

/** A customer, or a project (with the customer it belongs to, if any). */
export type ResourceFacts =
    | { type: "customer"; id: string }
    | { type: "project"; id: string; customerId: string | null };

/** The memberships that apply to a resource: the project's own and its customer's. */
export function membershipsFor(memberships: readonly MembershipFact[], resource: ResourceFacts): MembershipFact[] {
    const customerId = resource.type === "customer" ? resource.id : resource.customerId;
    return memberships.filter((m) =>
        (m.resourceType === resource.type && m.resourceId === resource.id)
        || (customerId !== null && m.resourceType === "customer" && m.resourceId === customerId));
}

/**
 * The role a person acts with inside a customer or project; null = they may
 * not see it at all (a restricted member without a membership on it).
 */
export function effectiveResourceRole(input: {
    companyRole: Role;
    restricted: boolean;
    memberships: readonly MembershipFact[];
    resource: ResourceFacts;
}): Role | null {
    const grants = membershipsFor(input.memberships, input.resource)
        .filter((m) => isResourceRole(m.role))
        .map((m) => resourceRoleAsRole(m.role as ResourceRole));
    if (input.restricted) return maxRole(grants);
    return maxRole([input.companyRole, ...grants]);
}

/**
 * Who may change a resource's Access: anyone acting as admin on it (a company
 * admin, or a resource admin). They can never grant a role above their own on
 * that resource; company roles are out of reach (other routes, company admins).
 */
export function mayManageResourceAccess(ownRole: Role | null): boolean {
    return Boolean(ownRole) && roleGte(ownRole as Role, "admin");
}

export function mayGrantResourceRole(ownRole: Role | null, grant: ResourceRole): boolean {
    return mayManageResourceAccess(ownRole) && roleGte(ownRole as Role, resourceRoleAsRole(grant));
}

/** "Harbor Dental · Can edit": the custom-access summary on the members page. */
export function customAccessSummary(rows: readonly { name: string; role: string }[]): string {
    return rows.map((row) => `${row.name} · ${isResourceRole(row.role) ? RESOURCE_ROLE_LABELS[row.role] : row.role}`).join(", ");
}
