import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { actionRuns, actionSteps } from "@/db/schema";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: actionRunId } = await params;

    try {
        const [actionRun] = await db.select().from(actionRuns).where(
            and(eq(actionRuns.id, actionRunId), eq(actionRuns.companyId, companyId))
        ).limit(1);

        if (!actionRun) {
            return NextResponse.json({ error: "Action run not found" }, { status: 404 });
        }

        const body = await req.json();
        const { stepType, toolName, status, target, inputSummaryJson, outputSummaryJson, errorText, startedAt, endedAt } = body;

        const [step] = await db.insert(actionSteps).values({
            actionRunId,
            companyId,
            stepType: stepType || "tool",
            toolName: toolName || null,
            status: status || "running",
            target: target || null,
            inputSummaryJson: inputSummaryJson || {},
            outputSummaryJson: outputSummaryJson || {},
            errorText: errorText || null,
            startedAt: startedAt ? new Date(startedAt) : new Date(),
            endedAt: endedAt ? new Date(endedAt) : null,
        }).returning();

        return NextResponse.json({ step }, { status: 201 });
    } catch (error: any) {
        return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
    }
}
