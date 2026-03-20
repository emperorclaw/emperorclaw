import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { projectMemory, projects } from "@/db/schema";
import { getCompanyId, getUserId } from "@/lib/auth";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function POST(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
    const companyId = await getCompanyId();
    const userId = await getUserId();
    if (!companyId || !userId) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const { projectId } = await params;
        const body = await req.json();
        const { content, tags } = body;

        if (!content || typeof content !== "string") {
            return NextResponse.json({ error: "Content string is required" }, { status: 400 });
        }

        const [project] = await db.select().from(projects).where(
            and(eq(projects.id, projectId), eq(projects.companyId, companyId))
        ).limit(1);

        if (!project) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const [memory] = await db.insert(projectMemory).values({
            companyId,
            projectId,
            content,
            tags: Array.isArray(tags) ? tags : [],
            createdByAgentId: null,
        }).returning();

        await broadcastMcpEvent(companyId, {
            type: "project_memory_added",
            projectId,
            actorUserId: userId,
            memory,
        });

        return NextResponse.json({ data: memory }, { status: 201 });
    } catch (error) {
        console.error("Project memory write error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
