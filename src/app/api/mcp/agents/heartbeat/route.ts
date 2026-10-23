import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { mcpBoundAgentMismatch, mcpTokenMayActOnAgent } from "@/lib/mcp-access";
import { nextCheckinDeadline } from "@/lib/lifecycle";
import { acknowledgeAgentHeartbeat } from "@/lib/openclaw/runtime";
import { touchRuntimeNode } from "@/lib/control-plane";

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

        // A bound token only reports its own agent's liveness.
        if (!(await mcpTokenMayActOnAgent(companyId, auth.companyToken!, String(agentId)))) return mcpBoundAgentMismatch();

        nextCheckinDeadline();
        const agent = await acknowledgeAgentHeartbeat({
            companyId,
            agentId,
            currentLoad,
        });

        if (!agent) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        // 0.9+ bridges name their runtime on every heartbeat, so duplicate
        // detection sees a live runtime between its (rarer) register calls.
        if (typeof body.runtimeId === "string" && body.runtimeId.trim()) {
            await touchRuntimeNode(companyId, body.runtimeId.trim().slice(0, 200));
        }

        return NextResponse.json({ message: "Heartbeat acknowledged", lastSeenAt: agent.lastSeenAt });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
