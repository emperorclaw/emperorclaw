import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { projectMemory, projects } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { verifyMcpToken } from "@/lib/mcp";
import { broadcastMcpEvent } from "@/lib/pubsub";
import { requireProjectInScope } from "@/lib/agent-scope";
import { mcpMayUseProject, mcpRouteAccess } from "@/lib/mcp-access";

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

        const scopeDenied = await requireProjectInScope(req, companyId, projectId, auth.companyToken!);
        if (scopeDenied) return scopeDenied;

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

        const scoped = await mcpRouteAccess(companyId, auth.companyToken!, agentId);
        if (scoped.response) return scoped.response;
        const internalAgentId = scoped.access.agentId;
        if (!mcpMayUseProject(scoped.access, projectId)) {
            return NextResponse.json({ error: "Project is outside this agent's scope" }, { status: 403 });
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
        const message = err instanceof Error ? err.message : "Internal Server Error";
        const status = message.startsWith("Agent not found") ? 404 : 500;
        return NextResponse.json({ error: message }, { status });
    }
}
