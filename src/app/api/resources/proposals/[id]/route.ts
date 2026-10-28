import { NextResponse } from "next/server";
import { reviewResourceProposal } from "@/lib/resources";
import { companyRouteAccess } from "@/lib/company-access";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { resourceProposals } from "@/db/schema";
import { memberMaySeeProposal, memberResourceWriteDenied } from "../../_shared";
import { resourceWriteDenied, scopeResource } from "@/lib/resource-access";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await companyRouteAccess("viewer");
  if (access.response) return access.response;
  const membership = access.ctx;
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  if (!["approved", "rejected", "merged"].includes(body.status)) {
    return NextResponse.json({ error: "status must be approved, rejected, or merged" }, { status: 400 });
  }
  // Reviewing (merging) writes the note: only inside the reviewer's scope.
  const [proposal] = await db.select().from(resourceProposals)
    .where(and(eq(resourceProposals.companyId, membership.companyId), eq(resourceProposals.id, id))).limit(1);
  if (!proposal || !(await memberMaySeeProposal(membership, proposal))) {
    return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
  }
  // Resource-aware (0.20): reviewing needs edit access to the proposal's scope;
  // approving or merging writes the target note too, so it needs edit access
  // there as well. Rejecting never touches the note (it may even be gone).
  const writesNote = body.status === "approved" || body.status === "merged";
  const denied = await resourceWriteDenied(membership, await scopeResource(membership.companyId, proposal), "member", "Proposal")
    ?? (writesNote && proposal.targetResourceId ? await memberResourceWriteDenied(membership, proposal.targetResourceId) : null);
  if (denied) return denied;
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
