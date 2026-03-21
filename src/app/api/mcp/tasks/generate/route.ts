import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { projects, tasks, taskEvents } from "@/db/schema";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { TASK_STATES } from "@/lib/task-state";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/tasks/generate";

    const { requestHash, cachedResponse, error: idempError, status } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    const body = await req.json();
    const {
        projectId,
        taskType,
        templateVersion,
        contractVersion,
        inputJson,
        priority = 0,
        proofRequired = false,
        humanApprovalRequired,
        proofTypesJson = "[]",
        blockedByTaskIds = [],
        taskKind = "standard",
        recurringTaskDefinitionId = null,
    } = body;

    if (!projectId || !taskType) {
        return NextResponse.json({ error: "projectId and taskType are required" }, { status: 400 });
    }

    try {
        const [existingProject] = await db.select().from(projects).where(
            and(eq(projects.id, projectId), eq(projects.companyId, companyId))
        ).limit(1);

        if (!existingProject) {
            return NextResponse.json({ error: "RELATIONSHIP_VIOLATION", details: "projectId does not exist or belong to this company" }, { status: 400 });
        }

        const [newTask] = await db.insert(tasks).values({
            id: randomUUID(),
            companyId,
            projectId,
            recurringTaskDefinitionId,
            taskKind,
            taskType,
            templateVersion,
            contractVersion,
            state: TASK_STATES.inbox,
            priority,
            proofRequired,
            humanApprovalRequired: typeof humanApprovalRequired === "boolean"
                ? humanApprovalRequired
                : Boolean(existingProject.requireApprovalForDone),
            proofTypesJson,
            inputJson: inputJson || {},
            blockedByTaskIds,
        }).returning();

        await db.insert(taskEvents).values({
            companyId,
            taskId: newTask.id,
            eventType: 'task_generated',
            actorType: 'system',
            payloadJson: { source: 'mcp_api' }
        });

        import('@/lib/pubsub').then(({ broadcastMcpEvent }) => {
            broadcastMcpEvent(companyId, { type: 'new_task', task: newTask });
        });

        const res = { message: "Task generated", task: newTask };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (dbError) {
        console.error("DB Error:", dbError);
        return NextResponse.json({ error: "Failed to generate task" }, { status: 500 });
    }
}
