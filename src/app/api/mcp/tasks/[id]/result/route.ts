import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { tasks, taskEvents } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const resolvedParams = await params;
    const companyId = auth.companyToken!.companyId;
    const taskId = resolvedParams.id;
    const endpoint = `/mcp/tasks/${taskId}/result`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    const body = await req.json();
    const { state, outputJson, agentId } = body;

    if (!state || !agentId) {
        return NextResponse.json({ error: "state and agentId are required" }, { status: 400 });
    }

    const internalAgentId = await resolveAgentId(companyId, agentId);

    const [existingTask] = await db.select().from(tasks).where(
        and(eq(tasks.id, taskId), eq(tasks.companyId, companyId))
    ).limit(1);

    if (!existingTask) {
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    // Determine actual next state based on needs_review rules
    let nextState = state;
    if (state === 'done' && existingTask.proofRequired && existingTask.humanApprovalRequired) {
        nextState = 'review';
    }

    const [updatedTask] = await db.update(tasks).set({
        state: nextState,
        outputJson: outputJson || existingTask.outputJson,
        updatedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
    }).where(
        eq(tasks.id, taskId)
    ).returning();

    await db.insert(taskEvents).values({
        companyId,
        taskId,
        eventType: `task_${nextState}`,
        actorType: 'agent',
        actorId: internalAgentId,
        payloadJson: { output: outputJson },
    });

    const res = { message: "Task result saved", task: updatedTask };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res);
}
