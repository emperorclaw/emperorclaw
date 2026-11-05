import { NextResponse } from "next/server";
import { roleGte, type GuardContext } from "@/lib/roles";
import { getApprovalDetail } from "@/lib/approvals";
import { memberMaySeeApproval, memberVisibleProjectIds } from "@/lib/member-scope";
import { recordResource, resourceWriteDenied } from "@/lib/resource-access";

export type ApprovalDetail = NonNullable<Awaited<ReturnType<typeof getApprovalDetail>>>;

/**
 * Who may see and who may decide a human-decided approval: the one rule
 * PATCH /api/approvals/[id] (Inbox, Approvals page, chat cards) and the chat
 * card's details (GET /api/approvals/[id]/card) share.
 *
 * - `detail` null: the approval does not exist or the person may not see it
 *   (a restricted member outside its project) — answer 404.
 * - `denied` set: the person sees it but may not decide it (a viewer, or a
 *   restricted member with only "Can view" on that project, 0.20).
 */
export async function approvalDecisionAccess(ctx: GuardContext, approvalId: string): Promise<{ detail: ApprovalDetail | null; denied: NextResponse | null }> {
    const detail = await getApprovalDetail(ctx.companyId, approvalId);
    if (!detail || !memberMaySeeApproval(ctx.scope, await memberVisibleProjectIds(ctx.companyId, ctx.scope), detail.approval)) {
        return { detail: null, denied: NextResponse.json({ error: "Approval not found" }, { status: 404 }) };
    }
    if (!roleGte(ctx.role, "member")) {
        return { detail, denied: NextResponse.json({ error: "Forbidden — this action requires one of: member." }, { status: 403 }) };
    }
    if (ctx.scope && detail.approval.projectId) {
        const denied = await resourceWriteDenied(ctx, await recordResource(ctx.companyId, { projectId: detail.approval.projectId }), "member", "Approval");
        if (denied) return { detail, denied };
    }
    return { detail, denied: null };
}
