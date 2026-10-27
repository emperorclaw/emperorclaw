import { NextResponse } from "next/server";
import { createResourceProposal, listResourceProposals } from "@/lib/resources";
import { lengthError, NAME_MAX } from "@/lib/input-limits";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeProposal } from "../_shared";

export async function GET(request: Request) {
  const access = await companyRouteAccess("viewer");
  if (access.response) return access.response;
  const membership = access.ctx;
  const { searchParams } = new URL(request.url);
  const proposals = await listResourceProposals(membership.companyId, searchParams.get("status"));
  const visible = [];
  for (const proposal of proposals) {
    if (await memberMaySeeProposal(membership, proposal)) visible.push(proposal);
  }
  return NextResponse.json({ proposals: visible });
}

export async function POST(request: Request) {
  const access = await companyRouteAccess("member");
  if (access.response) return access.response;
  const membership = access.ctx;
  const body = await request.json().catch(() => ({}));
  if (!body.title || typeof body.title !== "string") {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const titleError = lengthError("title", body.title, NAME_MAX);
  if (titleError) return NextResponse.json({ error: titleError }, { status: 400 });
  const target = { scopeType: body.scopeType || "company", scopeId: body.scopeId || null, targetResourceId: body.targetResourceId || null };
  if (!(await memberMaySeeProposal(membership, target))) {
    return NextResponse.json({ error: "That scope is outside your access" }, { status: 403 });
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
