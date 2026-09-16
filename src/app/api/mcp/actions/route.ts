import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveBoundAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { actionRuns, projects, tasks } from "@/db/schema";
import { and, eq, isNull } from "drizzle-orm";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { agentId, sessionId, projectId, taskId, kind, status, summary, metadataJson, startedAt } = body;

        const resolvedAgentId = await resolveBoundAgentId(companyId, auth.companyToken!, agentId);

        // Reject project/task references that do not belong to this company, so a
        // token cannot attach action runs to another tenant's entities.
        if (projectId) {
            if (typeof projectId !== "string" || !UUID_RE.test(projectId)) {
                return NextResponse.json({ error: "Project not found" }, { status: 404 });
            }
            const [project] = await db.select({ id: projects.id }).from(projects)
                .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt)))
                .limit(1);
            if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }
        if (taskId) {
            if (typeof taskId !== "string" || !UUID_RE.test(taskId)) {
                return NextResponse.json({ error: "Task not found" }, { status: 404 });
            }
            const [task] = await db.select({ id: tasks.id }).from(tasks)
                .where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId), isNull(tasks.deletedAt)))
                .limit(1);
            if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });
        }

        const [actionRun] = await db.insert(actionRuns).values({
            companyId,
            agentId: resolvedAgentId,
            sessionId: sessionId || null,
            projectId: projectId || null,
            taskId: taskId || null,
            kind: kind || "task_execution",
            status: status || "running",
            summary: summary || null,
            metadataJson: metadataJson || {},
            startedAt: startedAt ? new Date(startedAt) : new Date(),
        }).returning();

        return NextResponse.json({ actionRun }, { status: 201 });
    } catch (error: any) {
        const message = error.message || "Internal Server Error";
        return NextResponse.json({ error: message }, { status: message.startsWith("Access denied") ? 403 : 500 });
    }
}
