import { NextResponse } from "next/server";
import { listResourceBacklinks } from "@/lib/resources";
import { visibleResourceIds, memberResourceDenied } from "../../_shared";
import { companyRouteAccess } from "@/lib/company-access";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await companyRouteAccess("viewer");
  if (access.response) return access.response;
  const membership = access.ctx;
  const { id } = await params;
  const denied = await memberResourceDenied(membership, id);
  if (denied) return denied;
  const result = await listResourceBacklinks(membership.companyId, id);
  const visible = await visibleResourceIds(membership, [
    ...result.outgoing.map((link) => link.targetResourceId ?? ""),
    ...result.backlinks.map((link) => link.sourceResourceId),
  ]);
  if (!visible) return NextResponse.json(result);
  return NextResponse.json({
    ...result,
    outgoing: result.outgoing.filter((link) => !link.targetResourceId || visible.has(link.targetResourceId)),
    backlinks: result.backlinks.filter((link) => visible.has(link.sourceResourceId)),
  });
}
