import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { updateTaskForCompany } from "@/lib/openclaw/tasks";
import { getTaskDetailForCompany } from "@/lib/openclaw/task-context";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";
import { loadAgentScopeContext, isProjectAllowed } from "@/lib/agent-scope";

/** Resolves agentId (if given) and checks it against the task's project scope. */
async function checkTaskScope(
    companyId: string,
    agentId: unknown,
    projectId: string,
    deniedStatus: 403 | 404,
): Promise<NextResponse | null> {
    if (typeof agentId !== "string" || !agentId) return null;
    let resolvedAgentId: string;
    try {
        resolvedAgentId = await resolveAgentId(companyId, agentId);
    } catch {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }
    const { allowedProjectIds } = await loadAgentScopeContext(companyId, resolvedAgentId);
    if (!isProjectAllowed(allowedProjectIds, projectId)) {
        return NextResponse.json(
            { error: deniedStatus === 404 ? "Task not found" : "Task's project is outside this agent's scope" },
            { status: deniedStatus },
        );
    }
    return null;
}

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: taskId } = await params;

    try {
        const task = await getTaskDetailForCompany(companyId, taskId);
        if (!task) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }

        const agentIdParam = req.nextUrl.searchParams.get("agentId");
        const scopeDenied = await checkTaskScope(companyId, agentIdParam, task.projectId, 404);
        if (scopeDenied) return scopeDenied;

        return NextResponse.json({ task: serializeTaskWithAssignee(task) }, { status: 200 });
    } catch (err) {
        console.error(`Error fetching task ${taskId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

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

        if (body.agentId) {
            const [existingTask] = await db.select({ projectId: tasks.projectId }).from(tasks).where(
                and(eq(tasks.id, taskId), eq(tasks.companyId, companyId), isNull(tasks.deletedAt))
            ).limit(1);
            if (!existingTask) {
                return NextResponse.json({ error: "Task not found" }, { status: 404 });
            }
            const scopeDenied = await checkTaskScope(companyId, body.agentId, existingTask.projectId, 403);
            if (scopeDenied) return scopeDenied;
        }

        const result = await updateTaskForCompany({
            companyId,
            taskId,
            title: typeof body.title === "string" ? body.title : undefined,
            goal: typeof body.goal === "string" ? body.goal : undefined,
            priority: typeof body.priority === "number" ? body.priority : undefined,
            assignee: body.assignee !== undefined ? body.assignee : undefined,
            assignedAgentId: body.assignedAgentId !== undefined ? body.assignedAgentId : undefined,
            state: body.state,
            inputJson: body.inputJson && typeof body.inputJson === "object" ? body.inputJson : undefined,
        });

        if ("error" in result) {
            return NextResponse.json({ error: result.error }, { status: result.status });
        }

        const res = { message: `Task ${taskId} updated successfully`, task: serializeTaskWithAssignee(result.task) };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });
    } catch (err) {
        const message = err instanceof Error ? err.message : "Internal Server Error";
        const routeStatus = message.includes("not found") ? 404 : message === "Invalid assignee" ? 400 : 500;
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

        let agentId: unknown;
        try {
            agentId = (await req.json())?.agentId;
        } catch {
            // No body — DELETE typically has none, treat as unscoped caller.
        }
        const scopeDenied = await checkTaskScope(companyId, agentId, existing.projectId, 403);
        if (scopeDenied) return scopeDenied;

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
