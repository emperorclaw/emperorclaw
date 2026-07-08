import { NextResponse } from "next/server";
import { restoreResourceVersion } from "@/lib/resources";
import { getResourceMembership, unauthorizedResourceResponse } from "../../_shared";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const membership = await getResourceMembership();
  if (!membership) return unauthorizedResourceResponse();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!body.versionId || typeof body.versionId !== "string") {
    return NextResponse.json({ error: "versionId is required" }, { status: 400 });
  }
  const resource = await restoreResourceVersion({ companyId: membership.companyId, resourceId: id, versionId: body.versionId, userId: membership.userId });
  if (!resource) return NextResponse.json({ error: "Version not found" }, { status: 404 });
  return NextResponse.json({ resource });
}
