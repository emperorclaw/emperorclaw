import { NextResponse } from "next/server";
import { listResourceVersions } from "@/lib/resources";
import { memberResourceDenied } from "../../_shared";
import { companyRouteAccess } from "@/lib/company-access";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await companyRouteAccess("viewer");
  if (access.response) return access.response;
  const membership = access.ctx;
  const { id } = await params;
  const denied = await memberResourceDenied(membership, id);
  if (denied) return denied;
  return NextResponse.json({ versions: await listResourceVersions(membership.companyId, id) });
}
