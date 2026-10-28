import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";
import { db } from "@/db";
import { companies, companyMembers, customers, projects, resourceMemberships, users } from "@/db/schema";
import { humanActor, recordAudit } from "@/lib/audit";
import { sendEmail } from "@/lib/email";
import { getAppUrl } from "@/lib/env";
import { isSelfHosted } from "@/lib/instance";
import { createInvitation, InvitationError } from "@/lib/invitations";
import { consumeRateLimit } from "@/lib/rate-limit";
import { requireResourceRole, type ResourceGuardContext } from "@/lib/resource-access";
import {
    isResourceRole,
    mayGrantResourceRole,
    mayManageResourceAccess,
    resourceRoleAsRole,
    type ResourceRole,
    type ResourceType,
} from "@/lib/resource-roles";
import { roleGte } from "@/lib/role-matrix";
import { accessErrorResponse } from "@/lib/company-access";

/**
 * The one handler behind /api/customers/[id]/access and
 * /api/projects/[projectId]/access (0.20): who has a role on this customer or
 * project, and — for anyone acting as admin on it (a company admin or a
 * resource admin) — adding, changing and removing people, or inviting someone
 * by email straight into it. Nobody grants a role above their own on the
 * resource, and company roles are never touched here. Every change is audited.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AccessPerson = {
    userId: string;
    name: string;
    /** Only for those who manage this Access (resource or company admins); others get null. */
    email: string | null;
    role: ResourceRole;
    /** Set on a project's list when the role comes from its customer (managed there). */
    via: { type: "customer"; id: string; name: string } | null;
    /** True when this person sees nothing else (a restricted member). */
    restricted: boolean;
};

/** email: only for company admins (a resource admin picks by name). */
export type AccessCandidate = { userId: string; name: string; email: string | null };

/** A display name; never derived from the email (it would leak it). */
function personName(row: { name: string | null }): string {
    return row.name || "Unnamed member";
}

async function guard(type: ResourceType, id: string, minRole: "viewer" | "admin"): Promise<{ ctx: ResourceGuardContext } | { response: NextResponse }> {
    try {
        return { ctx: await requireResourceRole(type === "customer" ? { type, id } : { type, id }, minRole) };
    } catch (error) {
        const response = accessErrorResponse(error);
        if (response) return { response };
        throw error;
    }
}

async function resourceName(ctx: ResourceGuardContext): Promise<string> {
    if (ctx.resource.type === "customer") {
        const [row] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, ctx.resource.id)).limit(1);
        return row?.name ?? "this client";
    }
    const [row] = await db.select({ name: projects.goal }).from(projects).where(eq(projects.id, ctx.resource.id)).limit(1);
    return row?.name ?? "this project";
}

/** People with a role here: the resource's own memberships, plus (for a project) its customer's. */
async function listPeople(ctx: ResourceGuardContext): Promise<AccessPerson[]> {
    const { resource } = ctx;
    const customerId = resource.type === "project" ? resource.customerId : null;
    const rows = await db.select({
        userId: resourceMemberships.userId,
        resourceType: resourceMemberships.resourceType,
        resourceId: resourceMemberships.resourceId,
        role: resourceMemberships.role,
        name: users.displayName,
        email: users.email,
        scopeJson: companyMembers.scopeJson,
    })
        .from(resourceMemberships)
        .innerJoin(users, eq(users.id, resourceMemberships.userId))
        .innerJoin(companyMembers, and(eq(companyMembers.userId, resourceMemberships.userId), eq(companyMembers.companyId, resourceMemberships.companyId)))
        .where(and(
            eq(resourceMemberships.companyId, ctx.companyId),
            isNull(users.deletedAt),
            or(
                and(eq(resourceMemberships.resourceType, resource.type), eq(resourceMemberships.resourceId, resource.id)),
                customerId ? and(eq(resourceMemberships.resourceType, "customer"), eq(resourceMemberships.resourceId, customerId)) : undefined,
            ),
        ))
        .orderBy(asc(users.email));
    let customerName: string | null = null;
    if (customerId && rows.some((r) => r.resourceType === "customer")) {
        const [c] = await db.select({ name: customers.name }).from(customers).where(eq(customers.id, customerId)).limit(1);
        customerName = c?.name ?? null;
    }
    const isRestricted = (scopeJson: unknown) => Boolean(scopeJson && typeof scopeJson === "object" && (scopeJson as { mode?: unknown }).mode === "restricted");
    // Own rows first; an inherited row only for people without one here.
    const own = rows.filter((r) => r.resourceType === resource.type && r.resourceId === resource.id);
    const ownIds = new Set(own.map((r) => r.userId));
    const inherited = rows.filter((r) => r.resourceType === "customer" && resource.type === "project" && !ownIds.has(r.userId));
    return [...own, ...inherited].filter((r) => isResourceRole(r.role)).map((r) => ({
        userId: r.userId,
        name: personName(r),
        email: r.email,
        role: r.role as ResourceRole,
        via: r.resourceType === "customer" && resource.type === "project" ? { type: "customer" as const, id: r.resourceId, name: customerName ?? "its client" } : null,
        restricted: isRestricted(r.scopeJson),
    }));
}

/** Company members who could be added (not deleted, not already on the resource's own list). */
/**
 * Who can be added. Company admins get the whole member directory (with
 * emails). A resource admin who is not a company admin only gets the people
 * who already share one of their clients/projects with them, names only:
 * anyone else is reached through "invite by email".
 */
async function listCandidates(ctx: ResourceGuardContext, exclude: ReadonlySet<string>): Promise<AccessCandidate[]> {
    const companyAdmin = roleGte(ctx.role, "admin");
    let sharing: string[] | null = null;
    if (!companyAdmin) {
        const mine = await db.select({ type: resourceMemberships.resourceType, id: resourceMemberships.resourceId }).from(resourceMemberships)
            .where(and(eq(resourceMemberships.companyId, ctx.companyId), eq(resourceMemberships.userId, ctx.userId)));
        if (mine.length === 0) return [];
        sharing = (await db.selectDistinct({ userId: resourceMemberships.userId }).from(resourceMemberships).where(and(
            eq(resourceMemberships.companyId, ctx.companyId),
            or(...mine.map((m) => and(eq(resourceMemberships.resourceType, m.type), eq(resourceMemberships.resourceId, m.id)))),
        ))).map((row) => row.userId);
        if (sharing.length === 0) return [];
    }
    const rows = await db.select({ userId: companyMembers.userId, name: users.displayName, email: users.email })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, ctx.companyId), isNull(users.deletedAt), sharing ? inArray(companyMembers.userId, sharing) : undefined))
        .orderBy(asc(users.email)).limit(500);
    return rows.filter((r) => !exclude.has(r.userId) && r.userId !== ctx.userId)
        .map((r) => ({ userId: r.userId, name: personName(r), email: companyAdmin ? r.email : null }));
}

export async function getResourceAccess(type: ResourceType, id: string): Promise<NextResponse> {
    const g = await guard(type, id, "viewer");
    if ("response" in g) return g.response;
    const { ctx } = g;
    const canManage = mayManageResourceAccess(ctx.resourceRole);
    // Emails and the member directory are for the people who manage this Access.
    const people = (await listPeople(ctx)).map((p) => (canManage ? p : { ...p, email: null }));
    const ownIds = new Set(people.filter((p) => !p.via).map((p) => p.userId));
    return NextResponse.json({
        resource: { type, id, name: await resourceName(ctx) },
        people,
        canManage,
        // The highest role this caller may grant here.
        maxGrant: canManage ? "admin" : null,
        candidates: canManage ? await listCandidates(ctx, ownIds) : [],
        canInvite: canManage && isSelfHosted(),
    });
}

type Body = { userId?: unknown; email?: unknown; role?: unknown };

async function readBody(req: NextRequest): Promise<Body> {
    const body = await req.json().catch(() => null);
    return body && typeof body === "object" ? body as Body : {};
}

async function companyPerson(companyId: string, userId: unknown) {
    if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
    const [row] = await db.select({ userId: companyMembers.userId, name: users.displayName, email: users.email })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId), isNull(users.deletedAt))).limit(1);
    return row ?? null;
}

async function currentMembership(ctx: ResourceGuardContext, userId: string) {
    const [row] = await db.select({ id: resourceMemberships.id, role: resourceMemberships.role }).from(resourceMemberships)
        .where(and(
            eq(resourceMemberships.companyId, ctx.companyId),
            eq(resourceMemberships.userId, userId),
            eq(resourceMemberships.resourceType, ctx.resource.type),
            eq(resourceMemberships.resourceId, ctx.resource.id),
        )).limit(1);
    return row ?? null;
}

function forbidden(message: string): NextResponse {
    return NextResponse.json({ error: message }, { status: 403 });
}

/** A membership the caller may not touch: one above their own role here. */
function outranks(ctx: ResourceGuardContext, role: string): boolean {
    return isResourceRole(role) && !roleGte(ctx.resourceRole, resourceRoleAsRole(role));
}

/** Rate limit for every Access change: 60 an hour per person. */
function limited(userId: string): NextResponse | null {
    const rate = consumeRateLimit({ key: `resource-access:${userId}`, limit: 60, windowMs: 60 * 60 * 1000 });
    if (rate.allowed) return null;
    return NextResponse.json({ error: "Too many access changes. Try again later." }, { status: 429, headers: { "Retry-After": Math.ceil(rate.retryAfterMs / 1000).toString() } });
}

/**
 * POST {userId, role} adds a company member (or sets their role);
 * POST {email, role} invites someone new straight into this customer/project.
 */
export async function addResourceAccess(req: NextRequest, type: ResourceType, id: string): Promise<NextResponse> {
    const g = await guard(type, id, "admin");
    if ("response" in g) return g.response;
    const { ctx } = g;
    const body = await readBody(req);
    if (!isResourceRole(body.role)) return NextResponse.json({ error: "role must be admin, editor or viewer" }, { status: 400 });
    const role = body.role;
    if (!mayGrantResourceRole(ctx.resourceRole, role)) return forbidden("You cannot grant a role above your own here.");
    const tooMany = limited(ctx.userId);
    if (tooMany) return tooMany;
    const name = await resourceName(ctx);

    if (typeof body.email === "string" && body.email.trim() && body.userId === undefined) {
        return inviteToResource(req, ctx, body.email, role, name);
    }

    const person = await companyPerson(ctx.companyId, body.userId);
    if (!person) return NextResponse.json({ error: "Person not found" }, { status: 404 });
    const existing = await currentMembership(ctx, person.userId);
    if (existing && outranks(ctx, existing.role)) return forbidden("You cannot change the access of someone above your own role here.");
    if (existing?.role === role) return NextResponse.json({ ok: true, people: await listPeople(ctx) });
    if (existing) {
        await db.update(resourceMemberships).set({ role }).where(eq(resourceMemberships.id, existing.id));
    } else {
        await db.insert(resourceMemberships).values({
            companyId: ctx.companyId, userId: person.userId, resourceType: type, resourceId: id, role, createdByUserId: ctx.userId,
        }).onConflictDoUpdate({
            target: [resourceMemberships.companyId, resourceMemberships.userId, resourceMemberships.resourceType, resourceMemberships.resourceId],
            set: { role },
        });
    }
    await recordAudit({
        companyId: ctx.companyId, actor: humanActor(ctx.userId),
        action: existing ? "member.access_changed" : "member.access_granted",
        target: { type: "member", id: person.userId },
        before: existing ? { resourceRole: existing.role } : null,
        after: { resourceRole: role },
        meta: { label: personName(person), resourceType: type, resourceId: id, resourceName: name },
    });
    return NextResponse.json({ ok: true, people: await listPeople(ctx) }, { status: existing ? 200 : 201 });
}

/** PATCH {userId, role}: change a person's role here. */
export async function updateResourceAccess(req: NextRequest, type: ResourceType, id: string): Promise<NextResponse> {
    const g = await guard(type, id, "admin");
    if ("response" in g) return g.response;
    const { ctx } = g;
    const body = await readBody(req);
    if (!isResourceRole(body.role)) return NextResponse.json({ error: "role must be admin, editor or viewer" }, { status: 400 });
    if (!mayGrantResourceRole(ctx.resourceRole, body.role)) return forbidden("You cannot grant a role above your own here.");
    const person = await companyPerson(ctx.companyId, body.userId);
    const existing = person ? await currentMembership(ctx, person.userId) : null;
    if (!person || !existing) return NextResponse.json({ error: "Access not found" }, { status: 404 });
    if (outranks(ctx, existing.role)) return forbidden("You cannot change the access of someone above your own role here.");
    const tooMany = limited(ctx.userId);
    if (tooMany) return tooMany;
    if (existing.role !== body.role) {
        await db.update(resourceMemberships).set({ role: body.role }).where(eq(resourceMemberships.id, existing.id));
        await recordAudit({
            companyId: ctx.companyId, actor: humanActor(ctx.userId), action: "member.access_changed",
            target: { type: "member", id: person.userId },
            before: { resourceRole: existing.role }, after: { resourceRole: body.role },
            meta: { label: personName(person), resourceType: type, resourceId: id, resourceName: await resourceName(ctx) },
        });
    }
    return NextResponse.json({ ok: true, people: await listPeople(ctx) });
}

/** DELETE {userId} (or ?userId=): remove a person's role here. */
export async function removeResourceAccess(req: NextRequest, type: ResourceType, id: string): Promise<NextResponse> {
    const g = await guard(type, id, "admin");
    if ("response" in g) return g.response;
    const { ctx } = g;
    const body = await readBody(req);
    const userId = body.userId ?? req.nextUrl.searchParams.get("userId");
    const person = await companyPerson(ctx.companyId, userId);
    const existing = person ? await currentMembership(ctx, person.userId) : null;
    if (!person || !existing) return NextResponse.json({ error: "Access not found" }, { status: 404 });
    if (outranks(ctx, existing.role)) return forbidden("You cannot change the access of someone above your own role here.");
    const tooMany = limited(ctx.userId);
    if (tooMany) return tooMany;
    await db.delete(resourceMemberships).where(eq(resourceMemberships.id, existing.id));
    await recordAudit({
        companyId: ctx.companyId, actor: humanActor(ctx.userId), action: "member.access_removed",
        target: { type: "member", id: person.userId },
        before: { resourceRole: existing.role },
        meta: { label: personName(person), resourceType: type, resourceId: id, resourceName: await resourceName(ctx) },
    });
    return NextResponse.json({ ok: true, people: await listPeople(ctx) });
}

/**
 * Invite by email into this customer/project. An existing company member is
 * simply added; anyone else gets an invitation that, once accepted, makes
 * them a restricted member who sees only this resource.
 */
async function inviteToResource(req: NextRequest, ctx: ResourceGuardContext, rawEmail: string, role: ResourceRole, name: string): Promise<NextResponse> {
    const email = rawEmail.trim().toLowerCase();
    const [member] = await db.select({ userId: companyMembers.userId }).from(companyMembers)
        .innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, ctx.companyId), eq(users.email, email), isNull(users.deletedAt))).limit(1);
    if (member) {
        const forward = new NextRequest(req.url, { method: "POST", body: JSON.stringify({ userId: member.userId, role }), headers: { "content-type": "application/json" } });
        return addResourceAccess(forward, ctx.resource.type, ctx.resource.id);
    }
    if (!isSelfHosted()) {
        return forbidden("Invitations are only available in self-hosted deployments.");
    }
    try {
        const result = await createInvitation({
            email, role: "viewer", companyId: ctx.companyId, createdByUserId: ctx.userId,
            resource: { type: ctx.resource.type, id: ctx.resource.id, role },
        });
        await recordAudit({
            companyId: ctx.companyId, actor: humanActor(ctx.userId), action: "member.invited",
            target: { type: "invitation", id: result.id },
            after: { email: result.email, role: result.role, resourceRole: role },
            meta: { label: result.email, resourceType: ctx.resource.type, resourceId: ctx.resource.id, resourceName: name },
        });
        const inviteUrl = `${getAppUrl(req)}/signup?invite=${result.rawToken}&email=${encodeURIComponent(result.email)}`;
        const [company] = await db.select({ name: companies.name }).from(companies).where(eq(companies.id, ctx.companyId)).limit(1);
        const roleWord = role === "admin" ? "an admin" : role === "editor" ? "someone who can edit" : "someone who can view";
        let emailSent = false;
        try {
            emailSent = await sendEmail({
                to: result.email,
                subject: `You're invited to ${name} on ${company?.name ?? "Emperor Claw"}`,
                html: `<p>You've been invited to <strong>${escapeHtml(name)}</strong> in <strong>${escapeHtml(company?.name ?? "the workspace")}</strong> as ${roleWord}.</p><p><a href="${inviteUrl}">Click here to accept the invitation</a></p><p>This invitation expires on ${result.expiresAt.toLocaleDateString()}.</p>`,
            });
        } catch (error) {
            console.error("Resource invitation email failed:", error);
        }
        return NextResponse.json({ ok: true, invited: { id: result.id, email: result.email, inviteUrl, emailSent, expiresAt: result.expiresAt.toISOString() }, people: await listPeople(ctx) }, { status: 201 });
    } catch (error) {
        if (error instanceof InvitationError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }
}

function escapeHtml(value: string): string {
    return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}

/**
 * "Custom access" per person for the members settings page: their resource
 * memberships with the customer/project name.
 */
export async function loadCustomAccess(companyId: string, userIds: readonly string[]): Promise<Map<string, { type: ResourceType; id: string; name: string; role: ResourceRole }[]>> {
    const out = new Map<string, { type: ResourceType; id: string; name: string; role: ResourceRole }[]>();
    if (userIds.length === 0) return out;
    const rows = await db.select({ userId: resourceMemberships.userId, type: resourceMemberships.resourceType, id: resourceMemberships.resourceId, role: resourceMemberships.role })
        .from(resourceMemberships)
        .where(and(eq(resourceMemberships.companyId, companyId), inArray(resourceMemberships.userId, [...userIds])));
    const customerIds = rows.filter((r) => r.type === "customer").map((r) => r.id);
    const projectIds = rows.filter((r) => r.type === "project").map((r) => r.id);
    const [c, p] = await Promise.all([
        customerIds.length ? db.select({ id: customers.id, name: customers.name }).from(customers).where(and(eq(customers.companyId, companyId), inArray(customers.id, customerIds), isNull(customers.deletedAt))) : Promise.resolve([]),
        projectIds.length ? db.select({ id: projects.id, name: projects.goal }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds), isNull(projects.deletedAt))) : Promise.resolve([]),
    ]);
    const names = new Map([...c, ...p].map((r) => [r.id, r.name]));
    for (const row of rows) {
        const name = names.get(row.id);
        if (!name || !isResourceRole(row.role)) continue;
        out.set(row.userId, [...(out.get(row.userId) ?? []), { type: row.type as ResourceType, id: row.id, name, role: row.role }]);
    }
    return out;
}
