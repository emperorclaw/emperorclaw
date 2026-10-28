import { NextRequest, NextResponse } from "next/server";
import { AuthError, requireRole } from "@/lib/roles";
import { updateTaskForCompany } from "@/lib/openclaw/tasks";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";
import { assignedAgentIds, memberMayAssignAgents, memberMaySeeTaskId } from "@/lib/member-scope";
import { memberMayUseAllAgents } from "@/lib/agent-access-server";
import { archiveTasksForCaller } from "@/lib/task-archive";
import { taskWriteDenied } from "@/lib/resource-access";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    let ctx;
    try {
        ctx = await requireRole("viewer")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }

    const { id: taskId } = await params;
    if (!(await memberMaySeeTaskId(ctx.companyId, ctx.scope, taskId))) {
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }
    // Resource-aware (0.20): edit access to the task's project or its customer.
    const denied = await taskWriteDenied(ctx, taskId);
    if (denied) return denied;
    try {
        const body = await req.json();
        // A restricted member reassigns work only to agents in their scope.
        if (!memberMayAssignAgents(ctx.scope, body) || !(await memberMayUseAllAgents(ctx, assignedAgentIds(body)))) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }
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
            blockedReason: body.blockedReason !== undefined ? body.blockedReason : undefined,
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
        ctx = await requireRole("viewer")();
    } catch (error) {
        if (error instanceof AuthError) return NextResponse.json({ error: error.message }, { status: error.statusCode });
        throw error;
    }

    const { id: taskId } = await params;
    const denied = await taskWriteDenied(ctx, taskId);
    if (denied) return denied;
    try {
        // Same checks as the bulk archive: company, then the member's scope.
        const { tasks: [task] } = await archiveTasksForCaller(ctx, [taskId]);
        if (!task) {
            return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }
        return NextResponse.json({ task });
    } catch (error) {
        console.error("Task delete error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
