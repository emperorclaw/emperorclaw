import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { taskEvents, tasks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { requireCompanyFromSession } from "@/lib/company-session";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    try {
        // Require authenticated session and resolve company
        const { companyId } = await requireCompanyFromSession();

        const resolvedParams = await params;
        const taskId = resolvedParams.id;
        const body = await req.json();
        const { comment } = body;

        if (!comment) return NextResponse.json({ error: "comment is required" }, { status: 400 });

        const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);

        if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

        // Tenant isolation: ensure the task belongs to the caller's company
        if (task.companyId !== companyId) {
            return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }

        const [newEvent] = await db.insert(taskEvents).values({
            companyId: task.companyId,
            taskId,
            eventType: "task_note",
            actorType: "human",
            payloadJson: { note: comment },
        }).returning();

        await broadcastMcpEvent(task.companyId, {
            type: "task_note_added",
            taskId,
            projectId: task.projectId,
            event: newEvent,
        });

        return NextResponse.json({ success: true, event: newEvent });
    } catch (error) {
        console.error("Task note error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
