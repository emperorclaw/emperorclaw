import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { endAgentSession } from "@/lib/control-plane";

export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string; sessionId: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { sessionId } = await params;

    try {
        const body = await req.json();
        const { status, summary, checkpointJson } = body;

        const session = await endAgentSession({
            companyId,
            sessionId,
            status: status || "ended",
            summary: summary || null,
            checkpointJson: checkpointJson || null,
        });

        if (!session) {
            return NextResponse.json({ error: "Session not found" }, { status: 404 });
        }

        return NextResponse.json({ session });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
