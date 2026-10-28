import { NextResponse } from "next/server";
import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { companyMembers, resourceMemberships, users } from "@/db/schema";
import { companyRouteAccess } from "@/lib/company-access";

/**
 * The people a new agent can be limited to ("Who can use it" in the hire
 * dialog, lib/agent-access.ts): the company's members, names only (no
 * emails). The server checks again on save that each one can see the agent.
 */
export async function GET() {
    const access = await companyRouteAccess("member");
    if (access.response) return access.response;
    // A restricted member only picks among people who share one of their
    // clients or projects (and themselves): never the whole company directory.
    const scope = access.ctx.scope;
    const shared = scope
        ? (await db.selectDistinct({ userId: resourceMemberships.userId }).from(resourceMemberships).where(and(
            eq(resourceMemberships.companyId, access.ctx.companyId),
            or(
                scope.customerIds?.length ? and(eq(resourceMemberships.resourceType, "customer"), inArray(resourceMemberships.resourceId, scope.customerIds)) : undefined,
                scope.projectIds?.length ? and(eq(resourceMemberships.resourceType, "project"), inArray(resourceMemberships.resourceId, scope.projectIds)) : undefined,
                sql`false`,
            ),
        ))).map((row) => row.userId).concat(access.ctx.userId)
        : null;
    const rows = await db.select({ id: users.id, name: users.displayName })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, access.ctx.companyId), isNull(users.deletedAt), shared ? inArray(users.id, shared) : undefined))
        .orderBy(asc(users.email)).limit(500);
    return NextResponse.json({
        me: access.ctx.userId,
        people: rows.map((row) => ({ id: row.id, name: row.name || "Unnamed member" })),
    });
}
