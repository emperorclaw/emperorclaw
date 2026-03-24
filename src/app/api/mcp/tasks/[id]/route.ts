import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { updateTaskForCompany } from "@/lib/openclaw/tasks";

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: taskId } = await params;
    const endpoint = `/api/mcp/tasks/${taskId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const result = await updateTaskForCompany({
            companyId,
            taskId,
            title: typeof body.title === "string" ? body.title : undefined,
            goal: typeof body.goal === "string" ? body.goal : undefined,
            priority: typeof body.priority === "number" ? body.priority : undefined,
            assignedAgentId: body.assignedAgentId !== undefined ? body.assignedAgentId : undefined,
            state: body.state,
            inputJson: body.inputJson && typeof body.inputJson === "object" ? body.inputJson : undefined,
        });

        if ("error" in result) {
            return NextResponse.json({ error: result.error }, { status: result.status });
        }

        const res = { message: `Task ${taskId} updated successfully`, task: result.task };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Internal Server Error";
        const routeStatus = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status: routeStatus });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: taskId } = await params;
    const endpoint = `/api/mcp/tasks/${taskId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(tasks).where(
            and(eq(tasks.id, taskId), eq(tasks.companyId, companyId), isNull(tasks.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Task not found or already deleted." }, { status: 404 });
        }

        const [deletedTask] = await db.update(tasks).set({
            deletedAt: new Date(),
        }).where(eq(tasks.id, taskId)).returning();

        await broadcastMcpEvent(companyId, { type: "task_updated", task: deletedTask });

        const res = { message: `Task ${taskId} archived successfully`, task: deletedTask };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting task ${taskId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
