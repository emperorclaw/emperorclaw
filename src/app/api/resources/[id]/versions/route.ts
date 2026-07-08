import { NextResponse } from "next/server";
import { listResourceVersions } from "@/lib/resources";
import { getResourceMembership, unauthorizedResourceResponse } from "../../_shared";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const membership = await getResourceMembership();
  if (!membership) return unauthorizedResourceResponse();
  const { id } = await params;
  return NextResponse.json({ versions: await listResourceVersions(membership.companyId, id) });
}
