import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { AuthError, requireRole } from "@/lib/roles";
import { updateTaskForCompany } from "@/lib/openclaw/tasks";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    let ctx;
    try {
        ctx = await requireRole("member")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }

    const { id: taskId } = await params;
    try {
        const body = await req.json();
        const inputJson = body.inputJson && typeof body.inputJson === "object" ? body.inputJson : undefined;
        const result = await updateTaskForCompany({
            companyId: ctx.companyId,
            taskId,
            title: typeof body.title === "string" ? body.title : undefined,
            goal: typeof body.goal === "string" ? body.goal : undefined,
            priority: typeof body.priority === "number" ? body.priority : Number.isFinite(Number(body.priority)) ? Number(body.priority) : undefined,
            assignee: body.assignee !== undefined ? body.assignee : undefined,
            assignedAgentId: body.assignedAgentId !== undefined ? body.assignedAgentId : undefined,
            state: body.state,
            inputJson,
            actorType: "human",
            actorId: ctx.userId,
        });

        if ("error" in result) {
            return NextResponse.json({ error: result.error }, { status: result.status });
        }

        return NextResponse.json({ task: serializeTaskWithAssignee(result.task) });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message.includes("not found") ? 404 : message === "Invalid assignee" ? 400 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    let ctx;
    try {
        ctx = await requireRole("member")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }

    const { id: taskId } = await params;
    try {
        const [existing] = await db.select().from(tasks).where(and(
            eq(tasks.id, taskId),
            eq(tasks.companyId, ctx.companyId),
            isNull(tasks.deletedAt),
        )).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }

        const [task] = await db.update(tasks).set({
            deletedAt: new Date(),
            updatedAt: new Date(),
        }).where(eq(tasks.id, taskId)).returning();

        await broadcastMcpEvent(ctx.companyId, { type: "task_updated", task });
        return NextResponse.json({ task });
    } catch (error) {
        console.error("Task delete error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
