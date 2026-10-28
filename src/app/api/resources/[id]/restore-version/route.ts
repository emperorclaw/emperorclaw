import { NextResponse } from "next/server";
import { restoreResourceVersion } from "@/lib/resources";
import { memberResourceWriteDenied } from "../../_shared";
import { companyRouteAccess } from "@/lib/company-access";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await companyRouteAccess("viewer");
  if (access.response) return access.response;
  const membership = access.ctx;
  const { id } = await params;
  const denied = await memberResourceWriteDenied(membership, id);
  if (denied) return denied;
  const body = await request.json().catch(() => ({}));
  if (!body.versionId || typeof body.versionId !== "string") {
    return NextResponse.json({ error: "versionId is required" }, { status: 400 });
  }
  const resource = await restoreResourceVersion({ companyId: membership.companyId, resourceId: id, versionId: body.versionId, userId: membership.userId });
  if (!resource) return NextResponse.json({ error: "Version not found" }, { status: 404 });
  return NextResponse.json({ resource });
}
