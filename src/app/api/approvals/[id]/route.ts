import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { getApprovalDetail, resolveApproval } from "@/lib/approvals";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeApproval, memberVisibleProjectIds } from "@/lib/member-scope";
import { alwaysAllowRefusal, approvalDecisionAccess } from "@/lib/approval-access";

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const access = await companyRouteAccess("viewer");
    if (access.response) return access.response;
    const companyId = access.ctx.companyId;

    const { id } = await params;
    const detail = await getApprovalDetail(companyId, id);
    if (!detail || !memberMaySeeApproval(access.ctx.scope, await memberVisibleProjectIds(companyId, access.ctx.scope), detail.approval)) {
        return NextResponse.json({ error: "Approval not found" }, { status: 404 });
    }

    return NextResponse.json(detail);
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    let ctx;
    try {
        ctx = await requireRole("member")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }

    try {
        const { id } = await params;
        // A restricted member decides only approvals on projects they can see,
        // and never with only "Can view" on that project (0.20). The chat
        // card's details apply the same rule (lib/approval-access.ts).
        const { detail, denied } = await approvalDecisionAccess(ctx, id);
        if (denied) return denied;
        if (!detail) return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        const body = await req.json();
        const { status, resolutionNote } = body;

        if (status !== "approved" && status !== "rejected" && status !== "dismissed") {
            return NextResponse.json({ error: "status must be approved, rejected, or dismissed" }, { status: 400 });
        }
        // "Always allow" (0.30.1): approve and set the requesting agent's permission to "allowed".
        const alwaysAllow = body.alwaysAllow === true;
        if (body.alwaysAllow !== undefined && typeof body.alwaysAllow !== "boolean") {
            return NextResponse.json({ error: "alwaysAllow must be a boolean" }, { status: 400 });
        }
        if (alwaysAllow) {
            if (status !== "approved") return NextResponse.json({ error: "alwaysAllow only goes with status approved" }, { status: 400 });
            const refused = await alwaysAllowRefusal(ctx, detail.approval);
            if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });
        }

        const approval = await resolveApproval({
            companyId: ctx.companyId,
            approvalId: id,
            resolverUserId: ctx.userId,
            status,
            resolutionNote: resolutionNote || null,
            alwaysAllow,
        });

        if (!approval) {
            return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        }

        return NextResponse.json({ approval });
    } catch (error) {
        console.error("Approval resolve error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
