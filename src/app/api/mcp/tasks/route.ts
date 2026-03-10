import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { tasks, taskEvents, projects } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { and, desc, eq, isNull } from "drizzle-orm";
import { randomUUID } from "crypto";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const state = searchParams.get("state");
    const projectId = searchParams.get("projectId");

    try {
        const conditions = [
            eq(tasks.companyId, companyId),
            isNull(tasks.deletedAt),
        ];
        if (state) {
            conditions.push(eq(tasks.state, state));
        }
        if (projectId) {
            conditions.push(eq(tasks.projectId, projectId));
        }

        const rows = await db.select()
            .from(tasks)
            .where(and(...conditions))
            .orderBy(desc(tasks.createdAt))
            .limit(limit);

        return NextResponse.json({ tasks: rows });
    } catch (err) {
        console.error("Error fetching tasks:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/tasks";

    const { requestHash, cachedResponse, error: idempError, status } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    const body = await req.json();
    const { projectId, taskType, templateVersion, contractVersion, inputJson, priority = 0, proofRequired = false, humanApprovalRequired = false, proofTypesJson = "[]", blockedByTaskIds = [] } = body;

    if (!projectId || !taskType) {
        return NextResponse.json({ error: "projectId and taskType are required" }, { status: 400 });
    }

    // Integrity Guard: Verify Project exists
    const [existingProject] = await db.select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));

    if (!existingProject) {
        return NextResponse.json({ error: "RELATIONSHIP_VIOLATION", details: "projectId does not exist or belong to this company" }, { status: 400 });
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
