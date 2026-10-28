import { NextResponse } from "next/server";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { customers, projects, resourceMemberships, tasks, views } from "@/db/schema";
import { accessErrorResponse } from "@/lib/company-access";
import { loadScopeMemberships } from "@/lib/member-scope";
import type { ModuleKey } from "@/lib/modules";
import { moduleGuard } from "@/lib/modules-server";
import { effectiveResourceRole, type MembershipFact, type ResourceFacts } from "@/lib/resource-roles";
import { roleGte } from "@/lib/role-matrix";
import { AuthError, requireRole, type GuardContext, type Role } from "@/lib/roles";

/**
 * The resource-aware twin of companyRouteAccess (0.20): routes that change
 * something INSIDE a customer or project (the customer itself, its projects,
 * tasks, views, knowledge notes, files) check the caller's role on that
 * resource, so a company viewer with "Can edit" on a project edits there and a
 * resource admin manages it. Company-wide actions (members, billing, modules,
 * settings, agents, fleet, tokens) stay on companyRouteAccess.
 *
 * The rule itself is lib/resource-roles.ts effectiveResourceRole.
 */

export type ResourceRef = { type: "customer"; id: string } | { type: "project"; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const membershipCache = new WeakMap<GuardContext, Promise<readonly MembershipFact[]>>();

/**
 * The caller's resource memberships: the copy requireRole already loaded, or
 * one query per guard context (copies made with a spread keep `memberships`).
 */
function membershipsOf(ctx: GuardContext): Promise<readonly MembershipFact[]> {
    if (ctx.memberships) return Promise.resolve(ctx.memberships);
    let rows = membershipCache.get(ctx);
    if (!rows) {
        rows = loadScopeMemberships(ctx.companyId, ctx.userId);
        membershipCache.set(ctx, rows);
    }
    return rows;
}

/** The customer, or the project with its customer; null when missing, deleted or another company's. */
export async function loadResourceFacts(companyId: string, ref: ResourceRef): Promise<ResourceFacts | null> {
    if (typeof ref.id !== "string" || !UUID_RE.test(ref.id)) return null;
    if (ref.type === "customer") {
        const [row] = await db.select({ id: customers.id }).from(customers)
            .where(and(eq(customers.companyId, companyId), eq(customers.id, ref.id), isNull(customers.deletedAt))).limit(1);
        return row ? { type: "customer", id: row.id } : null;
    }
    const [row] = await db.select({ id: projects.id, customerId: projects.customerId }).from(projects)
        .where(and(eq(projects.companyId, companyId), eq(projects.id, ref.id), isNull(projects.deletedAt))).limit(1);
    return row ? { type: "project", id: row.id, customerId: row.customerId } : null;
}

/** The project a task belongs to, as a resource (null when the task is missing or another company's). */
export async function taskResource(companyId: string, taskId: string): Promise<ResourceFacts | null> {
    if (!UUID_RE.test(taskId)) return null;
    const [row] = await db.select({ projectId: tasks.projectId, customerId: projects.customerId }).from(tasks)
        .innerJoin(projects, eq(projects.id, tasks.projectId))
        .where(and(eq(tasks.companyId, companyId), eq(tasks.id, taskId))).limit(1);
    return row ? { type: "project", id: row.projectId, customerId: row.customerId } : null;
}

/**
 * The role the caller acts with inside a customer or project (its customer
 * counts for a project); null = they may not see it. Owners, admins and
 * instance admins keep their company role everywhere.
 */
export async function roleFor(ctx: GuardContext, resource: ResourceFacts): Promise<Role | null> {
    if (roleGte(ctx.role, "admin")) return ctx.role;
    return effectiveResourceRole({
        companyRole: ctx.role,
        restricted: ctx.scope !== null,
        memberships: await membershipsOf(ctx),
        resource,
    });
}

export type ResourceGuardContext = GuardContext & { resource: ResourceFacts; resourceRole: Role };

/**
 * Guard: the signed-in person may act as `minRole` inside this resource.
 * A resource they cannot see (or that does not exist) is a 404, never a 403,
 * so its existence is not confirmed.
 */
export async function requireResourceRole(resource: ResourceRef | ResourceFacts, minRole: Role, ctx?: GuardContext): Promise<ResourceGuardContext> {
    const guard = ctx ?? await requireRole("viewer")();
    // A project already resolved (with its customer) is used as is; anything else is looked up.
    const facts = "customerId" in resource ? resource : await loadResourceFacts(guard.companyId, resource);
    const notFound = resource.type === "customer" ? "Customer not found" : "Project not found";
    if (!facts) throw new AuthError(notFound, 404);
    const role = await roleFor(guard, facts);
    if (!role) throw new AuthError(notFound, 404);
    if (!roleGte(role, minRole)) {
        throw new AuthError(`Forbidden — this action requires ${minRole} access to this ${facts.type}.`, 403);
    }
    return { ...guard, resource: facts, resourceRole: role };
}

/**
 * Route convenience, like companyRouteAccess:
 * `const access = await resourceRouteAccess({ type: "project", id }, "member"); if (access.response) return access.response;`
 */
export async function resourceRouteAccess(
    resource: ResourceRef | ResourceFacts,
    minRole: Role,
    options: { module?: ModuleKey; ctx?: GuardContext } = {},
): Promise<{ ctx: ResourceGuardContext; response?: undefined } | { ctx?: undefined; response: NextResponse }> {
    try {
        const ctx = await requireResourceRole(resource, minRole, options.ctx);
        const off = options.module ? await moduleGuard(ctx.companyId, options.module) : null;
        return off ? { response: off } : { ctx };
    } catch (error) {
        const response = accessErrorResponse(error);
        if (response) return { response };
        throw error;
    }
}

/**
 * For a route that already holds a company guard and a loaded record: null
 * when the caller may act as `minRole` on it, else the 404/403 response.
 * Records without a project or customer are company-wide: the company role
 * decides.
 */
export async function resourceWriteDenied(
    ctx: GuardContext,
    resource: ResourceFacts | null,
    minRole: Role = "member",
    what = "Resource",
): Promise<NextResponse | null> {
    if (!resource) {
        // Company-wide records: a restricted member reads them but changes them only with the company role.
        return roleGte(ctx.role, minRole) ? null : NextResponse.json({ error: `Forbidden — this action requires one of: ${minRole}.` }, { status: 403 });
    }
    const role = await roleFor(ctx, resource);
    if (!role) return NextResponse.json({ error: `${what} not found` }, { status: 404 });
    if (!roleGte(role, minRole)) return NextResponse.json({ error: `Forbidden — this action requires ${minRole} access to this ${resource.type}.` }, { status: 403 });
    return null;
}

/**
 * Bulk routes: a viewer who edits nowhere (no "Can edit"/Admin membership)
 * is refused up front with a 403, exactly as before 0.20.
 */
export async function mayEditSomewhere(ctx: GuardContext): Promise<boolean> {
    if (roleGte(ctx.role, "member") && !ctx.scope) return true;
    return (await membershipsOf(ctx)).some((m) => m.role === "admin" || m.role === "editor");
}

export function editNowhereResponse(): NextResponse {
    return NextResponse.json({ error: "Forbidden — this action requires one of: member." }, { status: 403 });
}

/**
 * Task routes: null when the caller may act as `minRole` on the task's
 * project, else the 404 (missing / out of scope) or 403 response.
 */
export async function taskWriteDenied(ctx: GuardContext, taskId: string, minRole: Role = "member"): Promise<NextResponse | null> {
    const notFound = NextResponse.json({ error: "Task not found" }, { status: 404 });
    if (!UUID_RE.test(taskId)) return notFound;
    const resource = await taskResource(ctx.companyId, taskId);
    if (!resource) return notFound;
    return resourceWriteDenied(ctx, resource, minRole, "Task");
}

/** Of these projects, the ones the caller may act as `minRole` in (bulk task actions). */
export async function projectsWithRole(ctx: GuardContext, projectIds: readonly string[], minRole: Role = "member"): Promise<Set<string>> {
    const ids = [...new Set(projectIds)].filter((id) => UUID_RE.test(id));
    if (ids.length === 0) return new Set();
    const rows = await db.select({ id: projects.id, customerId: projects.customerId }).from(projects)
        .where(and(eq(projects.companyId, ctx.companyId), inArray(projects.id, ids)));
    const out = new Set<string>();
    for (const row of rows) {
        const role = await roleFor(ctx, { type: "project", id: row.id, customerId: row.customerId });
        if (role && roleGte(role, minRole)) out.add(row.id);
    }
    return out;
}

/**
 * The role the caller acts with on one view: their role on the customer or
 * project it is filed under (company role for company views). null = no such
 * view in this company, or one they cannot see. Pass it as the view caller's
 * role so a resource admin manages the views inside their project.
 */
export async function viewRoleFor(ctx: GuardContext, viewId: string): Promise<Role | null> {
    if (!UUID_RE.test(viewId)) return null;
    const [row] = await db.select({ scopeType: views.scopeType, scopeId: views.scopeId }).from(views)
        .where(and(eq(views.companyId, ctx.companyId), eq(views.id, viewId))).limit(1);
    if (!row) return null;
    const resource = await scopeResource(ctx.companyId, row);
    return resource ? roleFor(ctx, resource) : ctx.role;
}

/**
 * Several records a change touches (the record itself, where it moves, its
 * parent folder): each needs `minRole` on its project/customer, or the company
 * role when it hangs off neither. Null when all pass, else the first denial.
 */
export async function recordsWriteDenied(
    ctx: GuardContext,
    records: readonly ({ projectId?: string | null; customerId?: string | null } | null | undefined)[],
    minRole: Role = "member",
    what = "Resource",
): Promise<NextResponse | null> {
    for (const record of records) {
        if (!record) continue;
        const denied = await resourceWriteDenied(ctx, await recordResource(ctx.companyId, record), minRole, what);
        if (denied) return denied;
    }
    return null;
}

/** True when anyone holds a membership on this resource (for a project: on it or its customer). */
export async function hasCustomAccess(companyId: string, resource: ResourceFacts): Promise<boolean> {
    const customerId = resource.type === "customer" ? resource.id : resource.customerId;
    const [row] = await db.select({ id: resourceMemberships.id }).from(resourceMemberships).where(and(
        eq(resourceMemberships.companyId, companyId),
        or(
            and(eq(resourceMemberships.resourceType, resource.type), eq(resourceMemberships.resourceId, resource.id)),
            customerId ? and(eq(resourceMemberships.resourceType, "customer"), eq(resourceMemberships.resourceId, customerId)) : undefined,
        ),
    )).limit(1);
    return Boolean(row);
}

/** A record's resource from its project/customer columns (project wins; null = company-wide). */
export async function recordResource(companyId: string, record: { projectId?: string | null; customerId?: string | null }): Promise<ResourceFacts | null> {
    if (record.projectId) {
        return (await loadResourceFacts(companyId, { type: "project", id: record.projectId }))
            ?? { type: "project", id: record.projectId, customerId: record.customerId ?? null };
    }
    return record.customerId ? { type: "customer", id: record.customerId } : null;
}

/** A knowledge note / view scope ('company' | 'customer' | 'project' | 'agent') as a resource (null = company-wide). */
export async function scopeResource(companyId: string, scope: { scopeType: string | null; scopeId: string | null }): Promise<ResourceFacts | null> {
    if (scope.scopeType === "customer" && scope.scopeId) return { type: "customer", id: scope.scopeId };
    if (scope.scopeType === "project" && scope.scopeId) return recordResource(companyId, { projectId: scope.scopeId });
    return null;
}
