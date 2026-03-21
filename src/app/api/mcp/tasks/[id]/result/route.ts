import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { projects, tasks, taskEvents } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { normalizeTaskState, TASK_STATES } from "@/lib/task-state";
import { createApprovalRequest, getLatestPendingApproval, taskHasPendingApproval } from "@/lib/approvals";
import { validateTaskStateTransition } from "@/lib/project-workflow";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const resolvedParams = await params;
    const companyId = auth.companyToken!.companyId;
    const taskId = resolvedParams.id;
    const endpoint = `/api/mcp/tasks/${taskId}/result`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    const body = await req.json();
    const { state, outputJson, agentId, comment, approvalRationale, confidence = 0 } = body;

    if (!state || !agentId) {
        return NextResponse.json({ error: "state and agentId are required" }, { status: 400 });
    }

    const nextState = normalizeTaskState(state);
    if (!nextState) {
        return NextResponse.json({ error: "Invalid state" }, { status: 400 });
    }

    let internalAgentId: string;
    try {
        internalAgentId = await resolveAgentId(companyId, agentId);
    } catch (error) {
        const message = error instanceof Error ? error.message : "Agent not found";
        return NextResponse.json({ error: message }, { status: 404 });
    }

    const [existingTask] = await db.select().from(tasks).where(
        and(eq(tasks.id, taskId), eq(tasks.companyId, companyId))
    ).limit(1);

    if (!existingTask) {
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    if (existingTask.assignedAgentId !== internalAgentId) {
        return NextResponse.json({ error: "Only the assigned agent can complete this task" }, { status: 409 });
    }

    const [project] = await db.select().from(projects).where(
        and(eq(projects.id, existingTask.projectId), eq(projects.companyId, companyId))
    ).limit(1);

    if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const hasPendingApproval = await taskHasPendingApproval(companyId, taskId);
    const transitionError = validateTaskStateTransition({
        project,
        task: existingTask,
        requestedState: nextState,
        actorAgentId: internalAgentId,
        hasPendingApproval,
        comment,
    });

    if (transitionError) {
        return NextResponse.json({ error: transitionError }, { status: 409 });
    }

    if (
        nextState === TASK_STATES.done &&
        (existingTask.humanApprovalRequired || project.requireApprovalForDone)
    ) {
        const approval = await createApprovalRequest({
            companyId,
            projectId: project.id,
            taskIds: [taskId],
            requesterAgentId: internalAgentId,
            rationale: approvalRationale || comment || `Approval requested to complete task ${taskId}.`,
            confidence,
            actionType: "task_done",
            metadataJson: {
                requestedState: nextState,
                taskType: existingTask.taskType,
            },
        });

        const pendingApproval = approval || (await getLatestPendingApproval(companyId, taskId));
        return NextResponse.json({
            error: "Task requires approval before done",
            approval: pendingApproval,
        }, { status: 409 });
    }

    const [updatedTask] = await db.update(tasks).set({
        state: nextState,
        outputJson: outputJson ?? existingTask.outputJson,
        updatedAt: new Date(),
        leaseOwner: null,
        leaseUntil: null,
    }).where(
        and(eq(tasks.id, taskId), eq(tasks.companyId, companyId))
    ).returning();

    await db.insert(taskEvents).values({
        companyId,
        taskId,
        eventType: `task_${nextState}`,
        actorType: 'agent',
        actorId: internalAgentId,
        payloadJson: { state: nextState, output: outputJson },
    });

    import('@/lib/pubsub').then(({ broadcastMcpEvent }) => {
        broadcastMcpEvent(companyId, { type: 'task_updated', task: updatedTask });
    });

    const res = { message: "Task result saved", task: updatedTask };
    await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
    return NextResponse.json(res);
}
