import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { agentSessions, agents, tasks } from "@/db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";
import { TASK_STATES } from "@/lib/task-state";
import { nextCheckinDeadline } from "@/lib/lifecycle";

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

        let internalAgentId: string;
        try {
            internalAgentId = await resolveAgentId(companyId, agentId);
        } catch (error) {
            const message = error instanceof Error ? error.message : "Agent not found";
            return NextResponse.json({ error: message }, { status: 404 });
        }

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

        await db.update(tasks).set({
            leaseUntil: sql`NOW() + INTERVAL '10 minutes'`,
            updatedAt: new Date(),
        }).where(
            and(
                eq(tasks.companyId, companyId),
                eq(tasks.assignedAgentId, internalAgentId),
                eq(tasks.state, TASK_STATES.inProgress),
                isNull(tasks.deletedAt)
            )
        );

        await db.update(agentSessions).set({
            lastHeartbeatAt: new Date(),
            checkinDeadlineAt: nextCheckinDeadline(),
            wakeAttempts: 0,
            lastProvisionError: null,
            status: "active",
        }).where(
            and(
                eq(agentSessions.companyId, companyId),
                eq(agentSessions.agentId, internalAgentId),
                isNull(agentSessions.endedAt),
            ),
        );

        return NextResponse.json({ message: "Heartbeat acknowledged", lastSeenAt: agent.lastSeenAt });
    } catch (error) {
        console.error("Agent heartbeat error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
