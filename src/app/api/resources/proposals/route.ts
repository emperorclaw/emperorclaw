import { NextResponse } from "next/server";
import { createResourceProposal, listResourceProposals } from "@/lib/resources";
import { getResourceMembership, unauthorizedResourceResponse } from "../_shared";

export async function GET(request: Request) {
  const membership = await getResourceMembership();
  if (!membership) return unauthorizedResourceResponse();
  const { searchParams } = new URL(request.url);
  return NextResponse.json({ proposals: await listResourceProposals(membership.companyId, searchParams.get("status")) });
}

export async function POST(request: Request) {
  const membership = await getResourceMembership();
  if (!membership) return unauthorizedResourceResponse();
  const body = await request.json().catch(() => ({}));
  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const proposal = await createResourceProposal({
    companyId: membership.companyId,
    proposedByUserId: membership.userId,
    scopeType: body.scopeType || "company",
    scopeId: body.scopeId || null,
    targetResourceId: body.targetResourceId || null,
    action: body.action || "create",
    title: body.title,
    proposedText: body.proposedText || "",
    reason: body.reason || null,
    evidenceJson: body.evidenceJson || {},
  });
  return NextResponse.json({ proposal }, { status: 201 });
}
