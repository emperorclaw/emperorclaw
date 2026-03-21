import { NextRequest, NextResponse } from "next/server";
import { getCompanyId, getUserId } from "@/lib/auth";
import { db } from "@/db";
import { projects, tasks, auditLog, chatMessages } from "@/db/schema";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { TASK_STATES } from "@/lib/task-state";

export async function POST(req: NextRequest) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { projectName, projectDescription, tasks: taskList } = await req.json();
    if (!projectName || !taskList) return NextResponse.json({ error: "Missing required fields" }, { status: 400 });

    try {
        // 1. Create Project
        const [project] = await db.insert(projects).values({
            companyId: companyId as any,
            goal: projectName, // We use 'goal' as the title in the schema
            status: "active",
        } as any).returning();

        // 2. Create Tasks
        const createdTasks = [];
        for (const t of taskList) {
            const [task] = await db.insert(tasks).values({
                companyId: companyId as any,
                projectId: project.id,
                taskType: t.title, // We map the title to taskType for now
                state: TASK_STATES.queued,
                priority: 2,
                inputJson: { description: t.description, orchestratorRole: t.agentRole }
            } as any).returning();
            
            createdTasks.push(task);
        }

        // 4. Audit Log
        await db.insert(auditLog).values({
            companyId: companyId as any,
            actorType: "human",
            actorId: userId as any,
            action: "mission_orchestration",
            targetType: "project",
            targetId: project.id,
            payloadJson: { goal: projectName, taskCount: taskList.length }
        } as any);

        // 5. Chat Notification
        await db.insert(chatMessages).values({
            companyId: companyId as any,
            senderType: "agent", // System messages appear as agent-managed
            fromUserId: "system-orchestrator",
            text: `🚀 **Mission Initiated:** ${projectName}\nBreakdown: ${taskList.length} tasks generated and queued for workforce assignment. Monitoring for agent pick-up.`
        } as any);

        // 6. Broadcast
        broadcastMcpEvent(companyId, {
            type: "mission_started",
            projectId: project.id,
            projectName,
            taskCount: taskList.length
        });

        return NextResponse.json({ ok: true, projectId: project.id });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
