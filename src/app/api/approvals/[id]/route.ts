import { NextRequest, NextResponse } from "next/server";
import { getCompanyId } from "@/lib/auth";
import { AuthError, requireRole } from "@/lib/roles";
import { getApprovalDetail, resolveApproval } from "@/lib/approvals";

export async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const detail = await getApprovalDetail(companyId, id);
    if (!detail) {
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
        const body = await req.json();
        const { status, resolutionNote } = body;

        if (status !== "approved" && status !== "rejected") {
            return NextResponse.json({ error: "status must be approved or rejected" }, { status: 400 });
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
