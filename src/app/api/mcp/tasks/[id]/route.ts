import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { tasks } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { updateTaskForCompany } from "@/lib/openclaw/tasks";
import { getTaskDetailForCompany } from "@/lib/openclaw/task-context";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";
import { assertMcpMayAssign, mcpAccessErrorResponse, mcpMayUseProject, mcpRouteAccess } from "@/lib/mcp-access";
import { auditTaskTitle, mcpRequestActor, recordAudit } from "@/lib/audit";

/** Resolves the acting agent (token binding first) and checks it against the task's project scope. */
async function checkTaskScope(
    companyId: string,
    token: { agentId?: string | null },
    agentId: unknown,
    projectId: string,
    deniedStatus: 403 | 404,
): Promise<NextResponse | null> {
    const scoped = await mcpRouteAccess(companyId, token, agentId);
    if (scoped.response) return scoped.response;
    if (!mcpMayUseProject(scoped.access, projectId)) {
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
        const scopeDenied = await checkTaskScope(companyId, auth.companyToken!, agentIdParam, task.projectId, 404);
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

        // The lease is not a PATCH field. It used to be accepted here and
        // silently dropped: the caller got 200 "updated successfully" and
        // believed it held a mutex it never had (it also cannot be a plain
        // write — taking a lease must be atomic). Taking and releasing now live
        // in POST/DELETE /api/mcp/tasks/{id}/lease.
        const leaseFields = ["leaseOwner", "leaseUntil"].filter((field) => field in body);
        if (leaseFields.length > 0) {
            return NextResponse.json({
                error: `The task lease cannot be set through PATCH (${leaseFields.join(", ")} would have been ignored). `
                    + `Take it with POST /api/mcp/tasks/${taskId}/lease {"owner": "<session id>", "ttlSeconds": 900} `
                    + `and release it with DELETE /api/mcp/tasks/${taskId}/lease?owner=<session id>.`,
            }, { status: 400 });
        }

        {
            const [existingTask] = await db.select({ projectId: tasks.projectId }).from(tasks).where(
                and(eq(tasks.id, taskId), eq(tasks.companyId, companyId), isNull(tasks.deletedAt))
            ).limit(1);
            if (!existingTask) {
                return NextResponse.json({ error: "Task not found" }, { status: 404 });
            }
            const scopeDenied = await checkTaskScope(companyId, auth.companyToken!, body.agentId, existingTask.projectId, 403);
            if (scopeDenied) return scopeDenied;
            // Reassigning to another agent: only to agents the actor may work with.
            const reach = await mcpRouteAccess(companyId, auth.companyToken!, body.agentId);
            if (reach.response) return reach.response;
            try {
                await assertMcpMayAssign(companyId, reach.access, { assignee: body.assignee, assignedAgentId: body.assignedAgentId });
            } catch (error) {
                const denied = mcpAccessErrorResponse(error);
                if (denied) return denied;
                throw error;
            }
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
            actor: await mcpRequestActor(companyId, auth.companyToken!, body.agentId),
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
        const scopeDenied = await checkTaskScope(companyId, auth.companyToken!, agentId, existing.projectId, 403);
        if (scopeDenied) return scopeDenied;

        const [deletedTask] = await db.update(tasks).set({
            deletedAt: new Date(),
        }).where(eq(tasks.id, taskId)).returning();

        await recordAudit({ companyId, actor: await mcpRequestActor(companyId, auth.companyToken!, agentId), action: "task.archived", target: { type: "task", id: taskId }, after: { archived: true }, meta: { label: auditTaskTitle(existing), projectId: existing.projectId } });
        await broadcastMcpEvent(companyId, { type: "task_updated", task: deletedTask });

        const res = { message: `Task ${taskId} archived successfully`, task: deletedTask };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting task ${taskId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
