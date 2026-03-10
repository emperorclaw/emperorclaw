import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { tasks, taskEvents } from "@/db/schema";
import { randomUUID } from "crypto";

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
    const { projectId, taskType, templateVersion, contractVersion, inputJson, priority = 0, proofRequired = false, humanApprovalRequired = false, proofTypesJson = "[]", blockedByTaskIds = [] } = body;

    if (!projectId || !taskType) {
        return NextResponse.json({ error: "projectId and taskType are required" }, { status: 400 });
    }

    try {
        const [newTask] = await db.insert(tasks).values({
            id: randomUUID(),
            companyId,
            projectId,
            taskType,
            templateVersion,
            contractVersion,
            state: 'queued',
            priority,
            proofRequired,
            humanApprovalRequired,
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
