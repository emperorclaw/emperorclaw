import { NextResponse } from "next/server";
import { listPendingDecisions } from "@/lib/approvals";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeApproval, memberVisibleProjectIds } from "@/lib/member-scope";

/** Decisions waiting on a human, for the sidebar badge (same definition as the Approvals page). */
export async function GET() {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;
    const decisions = await listPendingDecisions(companyId);
    const visible = await memberVisibleProjectIds(companyId, access.ctx.scope);
    if (!visible) return NextResponse.json({ count: decisions.count });
    // A restricted member's badge counts only decisions on their projects.
    const count = decisions.approvals.filter(({ approval }) => memberMaySeeApproval(access.ctx.scope, visible, approval)).length
        + decisions.implicit.filter((task) => visible.has(task.projectId)).length;
    return NextResponse.json({ count });
}
