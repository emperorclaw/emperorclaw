import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projectMemory, taskEvents, tasks } from "@/db/schema";
import { eq, and, asc } from "drizzle-orm";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

type TaskHandoff = {
    fromRole: string;
    toRole: string;
    summary: string;
    nextStep: string;
    blockers?: unknown[];
    artifactRefs?: unknown[];
};

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const { id: taskId } = await params;
    const companyId = auth.companyToken!.companyId;

    try {
        const events = await db.select().from(taskEvents).where(
            and(
                eq(taskEvents.taskId, taskId),
                eq(taskEvents.companyId, companyId)
            )
        ).orderBy(asc(taskEvents.createdAt));

        return NextResponse.json({ events });
    } catch (err) {
        console.error(`Error fetching history for task ${taskId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

function validateHandoff(handoff: Record<string, unknown> | null | undefined): string | null {
    if (!handoff) return null;
    const required = ["fromRole", "toRole", "summary", "nextStep"];
    for (const key of required) {
        if (!handoff[key] || typeof handoff[key] !== "string") {
            return `handoff.${key} is required and must be a string`;
        }
    }
    if (handoff.blockers && !Array.isArray(handoff.blockers)) {
        return "handoff.blockers must be an array when provided";
    }
    if (handoff.artifactRefs && !Array.isArray(handoff.artifactRefs)) {
        return "handoff.artifactRefs must be an array when provided";
    }
    return null;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const resolvedParams = await params;
    const companyId = auth.companyToken!.companyId;
    const taskId = resolvedParams.id;
    const endpoint = `/api/mcp/tasks/${taskId}/notes`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const { note, agentId, handoff } = body;

        if (!note || !agentId) {
            return NextResponse.json({ error: "note and agentId are required" }, { status: 400 });
        }

        const handoffError = validateHandoff(handoff);
        if (handoffError) {
            return NextResponse.json({ error: handoffError }, { status: 400 });
        }

        const internalAgentId = await resolveAgentId(companyId, agentId);

        const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), eq(tasks.companyId, companyId))).limit(1);

        if (!task) return NextResponse.json({ error: "Task not found" }, { status: 404 });

        const payload: { note: string; handoff?: TaskHandoff } = { note };
        if (handoff) payload.handoff = handoff;

        const [newEvent] = await db.insert(taskEvents).values({
            companyId: task.companyId,
            taskId,
            eventType: handoff ? "task_handoff" : "task_note",
            actorType: "agent",
            actorId: internalAgentId,
            payloadJson: payload,
        }).returning();

        let memoryItem = null;
        if (handoff) {
            const memoryText = `[HANDOFF][task:${taskId}] ${handoff.fromRole} -> ${handoff.toRole} | ${handoff.summary} | next: ${handoff.nextStep}`;
            [memoryItem] = await db.insert(projectMemory).values({
                companyId: task.companyId,
                projectId: task.projectId,
                content: memoryText,
                tags: ["handoff", "task-context", handoff.fromRole, handoff.toRole],
                createdByAgentId: internalAgentId,
            }).returning();
        }

        await broadcastMcpEvent(companyId, {
            type: "task_note_added",
            taskId,
            projectId: task.projectId,
            event: newEvent,
            memory: memoryItem,
        });

        const res = { message: "Task note added successfully", event: newEvent, memory: memoryItem };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res);
    } catch (err) {
        console.error("Agent task note error:", err);
        const message = err instanceof Error ? err.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
