import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projectMemory, projects } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";

export async function GET(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
    try {
        const auth = await verifyMcpToken(req);
        if (auth.error) {
            return NextResponse.json({ error: auth.error }, { status: auth.status });
        }

        const companyId = auth.companyToken!.companyId;
        const { projectId } = await params;

        // Verify project exists and belongs to company
        const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        if (!project || project.companyId !== companyId) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const memoryItems = await db.select()
            .from(projectMemory)
            .where(eq(projectMemory.projectId, projectId))
            .orderBy(desc(projectMemory.createdAt));

        return NextResponse.json({
            data: memoryItems
        }, { status: 200 });

    } catch (err: unknown) {
        console.error("GET Project Memory error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ projectId: string }> }) {
    try {
        const auth = await verifyMcpToken(req);
        if (auth.error) {
            return NextResponse.json({ error: auth.error }, { status: auth.status });
        }

        const companyId = auth.companyToken!.companyId;
        const { projectId } = await params;

        // Verify project exists and belongs to company
        const [project] = await db.select().from(projects).where(eq(projects.id, projectId)).limit(1);
        if (!project || project.companyId !== companyId) {
            return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }

        const body = await req.json();
        const { content, tags, agentId } = body;

        let internalAgentId = null;
        if (agentId) {
            internalAgentId = await resolveAgentId(companyId, agentId);
        }

        if (!content || typeof content !== 'string') {
            return NextResponse.json({ error: "Content string is required" }, { status: 400 });
        }

        const [newItem] = await db.insert(projectMemory).values({
            companyId,
            projectId,
            content,
            tags: tags || [],
            createdByAgentId: internalAgentId,
        }).returning();

        await broadcastMcpEvent(companyId, {
            type: "project_memory_added",
            projectId,
            actorAgentId: internalAgentId,
            memory: newItem,
        });

        return NextResponse.json({
            data: newItem
        }, { status: 201 });

    } catch (err: unknown) {
        console.error("POST Project Memory error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
