import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { getApprovalDetail, resolveApproval } from "@/lib/approvals";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeApproval, memberVisibleProjectIds } from "@/lib/member-scope";

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
        // A restricted member decides only approvals on projects they can see.
        const current = await getApprovalDetail(ctx.companyId, id);
        if (!current || !memberMaySeeApproval(ctx.scope, await memberVisibleProjectIds(ctx.companyId, ctx.scope), current.approval)) {
            return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        }
        const body = await req.json();
        const { status, resolutionNote } = body;

        if (status !== "approved" && status !== "rejected" && status !== "dismissed") {
            return NextResponse.json({ error: "status must be approved, rejected, or dismissed" }, { status: 400 });
        }

        const approval = await resolveApproval({
            companyId: ctx.companyId,
            approvalId: id,
            resolverUserId: ctx.userId,
            status,
            resolutionNote: resolutionNote || null,
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
