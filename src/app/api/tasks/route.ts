import { NextRequest, NextResponse } from "next/server";
import { getCompanyId, getValidatedServerSession } from "@/lib/auth";
import { createTaskForProject, updateTaskForCompany } from "@/lib/openclaw/tasks";
import { serializeTaskWithAssignee } from "@/lib/task-assignee";

function splitLines(value: unknown) {
    if (Array.isArray(value)) {
        return value.map((item) => String(item).trim()).filter(Boolean);
    }
    if (typeof value !== "string") return [];
    return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    if (!companyId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const session = await getValidatedServerSession();
        const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const taskType = typeof body.taskType === "string" && body.taskType.trim() ? body.taskType.trim() : "manual_task";

        if (!projectId) {
            return NextResponse.json({ error: "projectId is required" }, { status: 400 });
        }
        if (!title) {
            return NextResponse.json({ error: "title is required" }, { status: 400 });
        }

        const inputJson = {
            title,
            description: typeof body.description === "string" ? body.description.trim() : "",
            goal: typeof body.goal === "string" && body.goal.trim() ? body.goal.trim() : title,
            acceptanceCriteria: splitLines(body.acceptanceCriteria),
            definitionOfDone: typeof body.definitionOfDone === "string" ? body.definitionOfDone.trim() : "",
            deliverables: splitLines(body.deliverables),
            ownerRole: typeof body.ownerRole === "string" ? body.ownerRole.trim() : "",
        };

        const { task } = await createTaskForProject({
            companyId,
            projectId,
            taskType,
            priority: Number(body.priority) || 0,
            proofRequired: Boolean(body.proofRequired),
            humanApprovalRequired: Boolean(body.humanApprovalRequired),
            inputJson,
            assignee: body.assignee !== undefined ? body.assignee : undefined,
            assignedAgentId: body.assignedAgentId || undefined,
            source: "browser_ui",
            actorType: "human",
            actorId: session?.user?.id || null,
        });

        if (body.state) {
            const result = await updateTaskForCompany({
                companyId,
                taskId: task.id,
                state: body.state,
                actorType: "human",
                actorId: session?.user?.id || null,
            });
            if ("error" in result) {
                return NextResponse.json({ error: result.error }, { status: result.status });
            }
            return NextResponse.json({ task: serializeTaskWithAssignee(result.task) }, { status: 201 });
        }

        return NextResponse.json({ task: serializeTaskWithAssignee(task) }, { status: 201 });
    } catch (error) {
        const message = error instanceof Error ? error.message : "Internal Server Error";
        const status = message === "RELATIONSHIP_VIOLATION"
            ? 404
            : message === "Invalid assignee"
                ? 400
                : message.includes("not found")
                    ? 404
                    : 500;
        return NextResponse.json({ error: message === "RELATIONSHIP_VIOLATION" ? "Project not found" : message }, { status });
    }
}
