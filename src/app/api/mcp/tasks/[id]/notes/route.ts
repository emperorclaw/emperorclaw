import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { taskEvents, tasks } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const resolvedParams = await params;
    const companyId = auth.companyToken!.companyId;
    const taskId = resolvedParams.id;
    const endpoint = `/api/mcp/tasks/${taskId}/notes`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { note, agentId } = body;

        if (!note || !agentId) {
            return NextResponse.json({ error: "note and agentId are required" }, { status: 400 });
        }

        const internalAgentId = await resolveAgentId(companyId, agentId);

        const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId))).limit(1);

        if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

        const [newEvent] = await db.insert(taskEvents).values({
            companyId: task.companyId,
            taskId,
            eventType: "task_note",
            actorType: "agent",
            actorId: internalAgentId,
            payloadJson: { note },
        }).returning();

        const res = { message: "Task note added successfully", event: newEvent };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res);
    } catch (err) {
        console.error("Agent task note error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
