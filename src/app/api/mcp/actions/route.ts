import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken, resolveAgentId } from "@/lib/mcp";
import { db } from "@/db";
import { actionRuns } from "@/db/schema";

export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const { agentId, sessionId, projectId, taskId, kind, status, summary, metadataJson, startedAt } = body;

        const resolvedAgentId = agentId ? await resolveAgentId(companyId, agentId) : null;

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
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
