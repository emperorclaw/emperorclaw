import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { companyMembers, customers, resourceMemberships } from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { requireRole, AuthError } from "@/lib/roles";
import { loadScopeMemberships, normalizeMemberScope } from "@/lib/member-scope";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
import { humanActor, recordMemberAudit } from "@/lib/audit";
import { changedFields, scopeAuditFields } from "@/lib/audit-format";

// Authorization is resolved from the DB via requireRole (not the stale JWT
// companyRole claim), and every query is scoped to the caller's company so a
// member id from another tenant can never be read or written.

// GET /api/instance/members/[userId]/scope
export async function GET(_req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }

    const { userId } = await params;
    const [membership] = await db
        .select({ scopeJson: companyMembers.scopeJson })
        .from(companyMembers)
        .where(and(
            eq(companyMembers.userId, userId),
            eq(companyMembers.companyId, ctx.companyId),
        ))
        .limit(1);
    if (!membership) return NextResponse.json({ scope: {} });

    // The customer list lives in resource_memberships since 0.20; the editor
    // still reads and writes it as scope.customerIds.
    const stored = (membership.scopeJson && typeof membership.scopeJson === "object" ? membership.scopeJson : {}) as Record<string, unknown>;
    const rows = await loadScopeMemberships(ctx.companyId, userId);
    return NextResponse.json({ scope: { ...stored, customerIds: rows.filter((r) => r.resourceType === "customer").map((r) => r.resourceId) } });
}

// PUT /api/instance/members/[userId]/scope
export async function PUT(req: NextRequest, { params }: { params: Promise<{ userId: string }> }) {
    let ctx;
    try {
        ctx = await requireRole("admin")();
    } catch (err) {
        if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.statusCode });
        throw err;
    }

    const { userId } = await params;
    const body = await req.json().catch(() => ({}));
    const raw = body?.scope;
    if (raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))) {
        return NextResponse.json({ error: "scope must be an object" }, { status: 400 });
    }
    if (raw?.mode !== undefined && raw.mode !== "all" && raw.mode !== "restricted") {
        return NextResponse.json({ error: "scope.mode must be 'all' or 'restricted'" }, { status: 400 });
    }
    // Store only the known shape: { mode: "all" } or { mode: "restricted", agentIds }.
    // The customer ticks become customer memberships (lib/resource-roles.ts).
    const restricted = normalizeMemberScope(raw);
    const scopeJson = restricted ? { mode: "restricted" as const, agentIds: restricted.agentIds ?? [] } : { mode: "all" as const };
    const requestedCustomerIds = Array.isArray(raw?.customerIds)
        ? [...new Set((raw.customerIds as unknown[]).filter((id): id is string => typeof id === "string" && UUID_RE.test(id)))]
        : null;

    const [previous] = await db.select({ scopeJson: companyMembers.scopeJson, role: companyMembers.role }).from(companyMembers)
        .where(and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, ctx.companyId))).limit(1);
    if (!previous) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    const previousCustomerIds = (await loadScopeMemberships(ctx.companyId, userId)).filter((r) => r.resourceType === "customer").map((r) => r.resourceId);
    const valid = restricted && requestedCustomerIds && requestedCustomerIds.length
        ? (await db.select({ id: customers.id }).from(customers).where(and(eq(customers.companyId, ctx.companyId), inArray(customers.id, requestedCustomerIds)))).map((c) => c.id)
        : [];

    // Same semantics as before 0.20, now explicit:
    // - mode 'restricted': the customer list is exactly scope.customerIds, and
    //   an OMITTED customerIds means no customers (fail closed, as 0.19
    //   normalized it to []). The ticks become customer memberships: a new one
    //   gets the role the company role implies (editor for a member, viewer for
    //   a viewer), a kept one keeps the role set in the client's Access dialog;
    // - mode 'all': memberships are left as they are (they only matter again,
    //   unchanged, if the member is restricted later; for an unrestricted
    //   member a migrated row never raises their company role).
    // One transaction, so the scope and its memberships never disagree.
    const syncCustomers = Boolean(restricted);
    const customerIds = syncCustomers ? valid : previousCustomerIds;
    await db.transaction(async (tx) => {
        await tx.update(companyMembers).set({ scopeJson })
            .where(and(eq(companyMembers.userId, userId), eq(companyMembers.companyId, ctx.companyId)));
        if (!syncCustomers) return;
        const removed = previousCustomerIds.filter((id) => !valid.includes(id));
        const added = valid.filter((id) => !previousCustomerIds.includes(id));
        if (removed.length) {
            await tx.delete(resourceMemberships).where(and(eq(resourceMemberships.companyId, ctx.companyId), eq(resourceMemberships.userId, userId),
                eq(resourceMemberships.resourceType, "customer"), inArray(resourceMemberships.resourceId, removed)));
        }
        if (added.length) {
            await tx.insert(resourceMemberships).values(added.map((id) => ({
                companyId: ctx.companyId, userId, resourceType: "customer", resourceId: id,
                role: previous.role === "viewer" ? "viewer" : "editor", createdByUserId: ctx.userId,
            }))).onConflictDoNothing();
        }
    });

    const scopeDiff = changedFields(
        scopeAuditFields({ ...(previous?.scopeJson as object ?? {}), customerIds: previousCustomerIds }),
        scopeAuditFields({ ...scopeJson, customerIds }),
    );
    if (Object.keys(scopeDiff.after).length > 0) await recordMemberAudit(ctx.companyId, humanActor(ctx.userId), "member.scope_changed", userId, scopeDiff.before, scopeDiff.after);
    return NextResponse.json({ ok: true, scope: { ...scopeJson, customerIds } });
}
