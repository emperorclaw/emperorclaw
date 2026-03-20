import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { readAgentMemory, writeAgentMemory } from "@/lib/control-plane";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "20", 10), 100);

    const [agent] = await db.select().from(agents).where(
        and(eq(agents.id, agentId), eq(agents.companyId, companyId))
    ).limit(1);

    if (!agent) {
        return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    const memory = await readAgentMemory(companyId, agentId, limit);
    return NextResponse.json({ agent, ...memory });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;

    try {
        const body = await req.json();
        const { sessionId, projectId, taskId, kind, content, summary, metadataJson, snapshot } = body;

        if (!content || typeof content !== "string") {
            return NextResponse.json({ error: "content is required" }, { status: 400 });
        }

        const memory = await writeAgentMemory({
            companyId,
            agentId,
            sessionId: sessionId || null,
            projectId: projectId || null,
            taskId: taskId || null,
            kind: kind || "context",
            content,
            summary: summary || null,
            metadataJson: metadataJson || {},
            snapshot: snapshot || null,
        });

        return NextResponse.json(memory, { status: 201 });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
