import { NextResponse } from "next/server";
import { listPendingDecisions } from "@/lib/approvals";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeApproval, memberVisibleProjectIds } from "@/lib/member-scope";
import { isAssignedToHuman } from "@/lib/approval-routing";
import { canAdmin } from "@/lib/role-matrix";

/**
 * Decisions waiting on this person, for the sidebar badge (same definition as
 * the Approvals page): a routed ask counts only for its approvers.
 */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const decisions = await listPendingDecisions(companyId);
    const viewer = { userId: access.ctx.userId, isOwnerOrAdmin: canAdmin(access.ctx.role) };
    const mine = decisions.approvals.filter(({ approval }) => isAssignedToHuman(approval, viewer));
    const visible = await memberVisibleProjectIds(companyId, access.ctx.scope);
    if (!visible) return NextResponse.json({ count: mine.length + decisions.implicit.length });
    // A restricted member's badge counts only decisions on their projects.
    const count = mine.filter(({ approval }) => memberMaySeeApproval(access.ctx.scope, visible, approval)).length
        + decisions.implicit.filter((task) => visible.has(task.projectId)).length;
    return NextResponse.json({ count });
}
