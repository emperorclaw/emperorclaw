import { NextResponse } from "next/server";
import { reviewResourceProposal } from "@/lib/resources";
import { getResourceMembership, unauthorizedResourceResponse } from "../../_shared";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const membership = await getResourceMembership();
  if (!membership) return unauthorizedResourceResponse();
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!["approved", "rejected", "merged"].includes(body.status)) {
    return NextResponse.json({ error: "status must be approved, rejected, or merged" }, { status: 400 });
  }
  const result = await reviewResourceProposal({
    companyId: membership.companyId,
    proposalId: id,
    status: body.status,
    resolutionNote: body.resolutionNote || null,
    reviewedByUserId: membership.userId,
    proposedTextOverride: body.proposedTextOverride || null,
  });
  if (!result) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  return NextResponse.json(result);
}
