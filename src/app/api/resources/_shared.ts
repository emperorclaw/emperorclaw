import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getValidatedServerSession } from "@/lib/auth";
import { db } from "@/db";
import { companyMembers } from "@/db/schema";

export async function getResourceMembership() {
  const session = await getValidatedServerSession();
  const userId = session?.user?.id;
  if (!userId) return null;
  const [membership] = await db.select().from(companyMembers).where(eq(companyMembers.userId, userId)).limit(1);
  return membership || null;
}

export function unauthorizedResourceResponse() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

/**
 * A proposal is visible to a restricted member when both its own scope and
 * the note it targets (if any) are inside their scope.
 */
export async function memberMaySeeProposal(
  ctx: { companyId: string; scope: import("@/lib/member-scope").MemberScope | null },
  proposal: { scopeType: string | null; scopeId: string | null; targetResourceId: string | null },
): Promise<boolean> {
  if (!ctx.scope) return true;
  const { memberMaySeeResource } = await import("@/lib/member-scope");
  if (!(await memberMaySeeResource(ctx.companyId, ctx.scope, proposal))) return false;
  return !proposal.targetResourceId || (await memberResourceDenied(ctx, proposal.targetResourceId)) === null;
}

/**
 * Knowledge graph / backlinks for a restricted member: only notes inside
 * their scope survive, and links to hidden notes are dropped (a link would
 * otherwise leak the hidden note's id and link text).
 */
export async function visibleResourceIds(
  ctx: { companyId: string; scope: import("@/lib/member-scope").MemberScope | null },
  ids: string[],
): Promise<Set<string> | null> {
  if (!ctx.scope) return null;
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Set();
  const { db } = await import("@/db");
  const { scopedResources } = await import("@/db/schema");
  const { and, eq, inArray } = await import("drizzle-orm");
  const { filterResourcesForMember } = await import("@/lib/member-scope");
  const rows = await db.select({ id: scopedResources.id, scopeType: scopedResources.scopeType, scopeId: scopedResources.scopeId })
    .from(scopedResources).where(and(eq(scopedResources.companyId, ctx.companyId), inArray(scopedResources.id, unique)));
  return new Set((await filterResourcesForMember(ctx.companyId, ctx.scope, rows)).map((row) => row.id));
}

/**
 * A restricted member may only reach notes inside their scope (customer,
 * project via its customer, agent; company notes are open). Out-of-scope and
 * missing both read as 404.
 */
export async function memberResourceDenied(
  ctx: { companyId: string; scope: import("@/lib/member-scope").MemberScope | null },
  resourceId: string,
): Promise<NextResponse | null> {
  if (!ctx.scope) return null;
  const { getScopedResource } = await import("@/lib/resources");
  const { memberMaySeeResource } = await import("@/lib/member-scope");
  const resource = await getScopedResource(ctx.companyId, resourceId);
  if (!resource || !(await memberMaySeeResource(ctx.companyId, ctx.scope, resource))) {
    return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  }
  return null;
}

/**
 * Changing a note (0.20, resource-aware): it must be visible, and the caller
 * needs edit access to the customer/project it is filed under (company role
 * for company and agent notes). Missing reads as 404.
 */
export async function memberResourceWriteDenied(
  ctx: import("@/lib/roles").GuardContext,
  resourceId: string,
): Promise<NextResponse | null> {
  const hidden = await memberResourceDenied(ctx, resourceId);
  if (hidden) return hidden;
  const { getScopedResource } = await import("@/lib/resources");
  const { resourceWriteDenied, scopeResource } = await import("@/lib/resource-access");
  const resource = await getScopedResource(ctx.companyId, resourceId);
  if (!resource) return NextResponse.json({ error: "Resource not found" }, { status: 404 });
  return resourceWriteDenied(ctx, await scopeResource(ctx.companyId, resource), "member", "Resource");
}
