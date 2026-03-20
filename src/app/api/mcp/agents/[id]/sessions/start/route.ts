import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { agentSessions, agents, runtimeNodes } from "@/db/schema";
import { getCompanyContext, readAgentMemory, startAgentSession } from "@/lib/control-plane";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;

    try {
        const body = await req.json();
        const { runtimeId, openclawSessionId, sessionType, channel, startedAt, checkpointJson } = body;

        if (!openclawSessionId) {
            return NextResponse.json({ error: "openclawSessionId is required" }, { status: 400 });
        }

        const [agent] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId))
        ).limit(1);

        if (!agent) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        let runtimeNodeId: string | null = null;
        if (runtimeId) {
            const [runtimeNode] = await db.select().from(runtimeNodes).where(
                and(eq(runtimeNodes.companyId, companyId), eq(runtimeNodes.runtimeId, runtimeId))
            ).limit(1);
            runtimeNodeId = runtimeNode?.id || null;
        }

        const session = await startAgentSession({
            companyId,
            agentId,
            runtimeNodeId,
            openclawSessionId,
            sessionType: sessionType || "main",
            channel: channel || null,
            startedAt: startedAt ? new Date(startedAt) : null,
            checkpointJson: checkpointJson || null,
        });

        const memory = await readAgentMemory(companyId, agentId, 25);
        const contextNotes = await getCompanyContext(companyId);
        const recentSessions = await db.select().from(agentSessions).where(
            and(eq(agentSessions.companyId, companyId), eq(agentSessions.agentId, agentId))
        ).limit(5);

        return NextResponse.json({
            session,
            memory,
            contextNotes,
            recentSessions,
        });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
