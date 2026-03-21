import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { nextCheckinDeadline } from "@/lib/lifecycle";
import { acknowledgeAgentHeartbeat } from "@/lib/openclaw/runtime";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { agentId, currentLoad } = body;

        if (!agentId || currentLoad === undefined) {
            return NextResponse.json({ error: "agentId and currentLoad required" }, { status: 400 });
        }

        nextCheckinDeadline();
        const agent = await acknowledgeAgentHeartbeat({
            companyId,
            agentId,
            currentLoad,
        });

        if (!agent) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        return NextResponse.json({ message: "Heartbeat acknowledged", lastSeenAt: agent.lastSeenAt });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
