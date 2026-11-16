import { NextResponse } from "next/server";
import { listPendingDecisions } from "@/lib/approvals";
import { companyRouteAccess } from "@/lib/company-access";
import { isAssignedToHuman } from "@/lib/approval-routing";
import { approvalViewerFor } from "@/lib/approval-routing-server";
import { approvalViewsFor, implicitTaskReasons } from "@/lib/approval-access";

/**
 * Decisions waiting on this person, for the sidebar badge (same definition as
 * the Approvals page): a routed ask counts only for its approvers, and only
 * what they may actually decide (never a "Can view" project's, a private chat
 * they have no part in, or a task they could not approve).
 */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const { ctx } = access;
    const decisions = await listPendingDecisions(ctx.companyId);
    const viewer = await approvalViewerFor(ctx.companyId, ctx.userId, ctx.role);
    const [views, implicit] = await Promise.all([
        approvalViewsFor(ctx, decisions.approvals.map(({ approval }) => approval), viewer),
        implicitTaskReasons(ctx, decisions.implicit, viewer),
    ]);
    const approvals = decisions.approvals.filter(({ approval }) => views.get(approval.id)?.mayDecide && isAssignedToHuman(approval, viewer)).length;
    const tasks = decisions.implicit.filter((task) => implicit.get(task.id) === null).length;
    return NextResponse.json({ count: approvals + tasks });
}
