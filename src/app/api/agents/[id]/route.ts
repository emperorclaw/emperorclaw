import { NextRequest, NextResponse } from "next/server";
import { getCompanyId, getUserId } from "@/lib/auth";
import { deleteAgentAndData } from "@/lib/agent-deletion";

export const dynamic = "force-dynamic";

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const [companyId, userId] = await Promise.all([getCompanyId(), getUserId()]);
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const confirmName = typeof body.confirmName === "string" ? body.confirmName.trim() : "";

    let deletedAgent;
    try {
        deletedAgent = await deleteAgentAndData({
            companyId,
            agentId: id,
            actorType: "human",
            actorId: userId,
            confirmName,
        });
    } catch (error) {
        if (error instanceof Error && error.name === "ConfirmationMismatchError") {
            return NextResponse.json({ error: error.message }, { status: 400 });
        }
        throw error;
    }

    if (!deletedAgent) {
        return NextResponse.json({ error: "Agent not found or already deleted." }, { status: 404 });
    }

    return NextResponse.json({
        message: `Agent ${deletedAgent.name} deleted.`,
        agent: { id: deletedAgent.id, name: deletedAgent.name },
    });
}
