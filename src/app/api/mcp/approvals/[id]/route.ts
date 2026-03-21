import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { getApprovalDetail, resolveApproval } from "@/lib/approvals";

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
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
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    try {
        const companyId = auth.companyToken!.companyId;
        const { id } = await params;
        const body = await req.json();
        const { status, resolverUserId, resolutionNote } = body;

        if (status !== "approved" && status !== "rejected") {
            return NextResponse.json({ error: "status must be approved or rejected" }, { status: 400 });
        }

        const approval = await resolveApproval({
            companyId,
            approvalId: id,
            resolverUserId: resolverUserId || null,
            status,
            resolutionNote: resolutionNote || null,
        });

        if (!approval) {
            return NextResponse.json({ error: "Approval not found" }, { status: 404 });
        }

        return NextResponse.json({ approval });
    } catch (error) {
        console.error("MCP approval resolve error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
