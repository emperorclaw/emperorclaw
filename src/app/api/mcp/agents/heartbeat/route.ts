import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";

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

        const internalAgentId = await resolveAgentId(companyId, agentId);

        const [agent] = await db.update(agents).set({
            lastSeenAt: new Date(),
            currentLoad: currentLoad,
            status: 'online', // Implicitly online on heartbeat
        }).where(
            and(
                eq(agents.id, internalAgentId),
                eq(agents.companyId, companyId),
                isNull(agents.deletedAt) // ensure not deleted
            )
        ).returning();

        if (!agent) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }

        return NextResponse.json({ message: "Heartbeat acknowledged", lastSeenAt: agent.lastSeenAt });
    } catch (error) {
        console.error("Agent heartbeat error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
