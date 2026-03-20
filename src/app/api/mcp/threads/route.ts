import { NextRequest, NextResponse } from "next/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { messageThreads, threadParticipants } from "@/db/schema";
import { ensureDirectThread, ensureTeamThread } from "@/lib/control-plane";

export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const type = searchParams.get("type");
    const agentId = searchParams.get("agentId");
    const projectId = searchParams.get("projectId");
    const taskId = searchParams.get("taskId");

    const conditions = [
        eq(messageThreads.companyId, companyId),
        isNull(messageThreads.archivedAt),
    ];

    if (type) conditions.push(eq(messageThreads.type, type));
    if (projectId) conditions.push(eq(messageThreads.projectId, projectId));
    if (taskId) conditions.push(eq(messageThreads.taskId, taskId));

    const threads = await db.select().from(messageThreads).where(and(...conditions));

    if (!agentId) {
        return NextResponse.json({ threads });
    }

    const participants = await db.select().from(threadParticipants).where(
        and(
            eq(threadParticipants.companyId, companyId),
            inArray(threadParticipants.threadId, threads.map(thread => thread.id)),
            eq(threadParticipants.participantType, "agent"),
            eq(threadParticipants.participantId, agentId)
        )
    );

    const allowedThreadIds = new Set(participants.map(participant => participant.threadId));
    return NextResponse.json({ threads: threads.filter(thread => allowedThreadIds.has(thread.id)) });
}

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { type, title, agentId, projectId, taskId, incidentId } = body;

        if (!type) {
            return NextResponse.json({ error: "type is required" }, { status: 400 });
        }

        if (type === "team") {
            return NextResponse.json({ thread: await ensureTeamThread(companyId) }, { status: 201 });
        }

        if (type === "direct") {
            if (!agentId) {
                return NextResponse.json({ error: "agentId is required for direct threads" }, { status: 400 });
            }

            const thread = await ensureDirectThread(companyId, agentId, null);
            return NextResponse.json({ thread }, { status: 201 });
        }

        const [thread] = await db.insert(messageThreads).values({
            companyId,
            type,
            title: title || null,
            projectId: projectId || null,
            taskId: taskId || null,
            incidentId: incidentId || null,
            createdByType: "agent",
        }).returning();

        return NextResponse.json({ thread }, { status: 201 });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
