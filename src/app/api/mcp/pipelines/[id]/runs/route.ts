import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { pipelines, pipelineRuns } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { extractRunContextSourceIds, PIPELINE_RUN_STATUSES, PipelineRunStatus } from "@/lib/pipelines";

// GET /api/mcp/pipelines/[id]/runs — run history.
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id } = await params;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "50", 10), 200);

    try {
        const runs = await db.select().from(pipelineRuns)
            .where(and(eq(pipelineRuns.pipelineId, id), eq(pipelineRuns.companyId, companyId)))
            .orderBy(desc(pipelineRuns.startedAt))
            .limit(limit);

        return NextResponse.json({ runs });
    } catch (err) {
        console.error("Pipeline runs GET error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// POST /api/mcp/pipelines/[id]/runs — report runs from the agent's runtime.
//
// Two shapes, one endpoint (agent-friendly):
//   Start:    { status?: 'running', agentId?, summary? }            → returns runId
//   Complete: { runId, status: 'succeeded'|'failed'|'partial',
//               summary?, stats? }                                  → closes the run
//   One-shot: { status: 'succeeded'|'failed'|'partial', ... }        → creates an already-closed run
// stats may carry { taskIds, artifactIds, counts, contextSourceIds } for traceability.
export async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id } = await params;
    const endpoint = `/api/mcp/pipelines/${id}/runs`;

    const { requestHash, cachedResponse, error: idempError, status: idempStatus } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status: idempStatus });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [pipeline] = await db.select().from(pipelines).where(
            and(eq(pipelines.id, id), eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt))
        ).limit(1);
        if (!pipeline) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }

        const body = await req.json();
        const status: string = body.status || "running";
        if (!PIPELINE_RUN_STATUSES.includes(status as PipelineRunStatus)) {
            return NextResponse.json({ error: `status must be one of: ${PIPELINE_RUN_STATUSES.join(", ")}` }, { status: 400 });
        }

        let agentId: string | null = null;
        if (body.agentId) {
            try {
                agentId = await resolveAgentId(companyId, body.agentId);
            } catch {
                return NextResponse.json({ error: `Agent not found: ${body.agentId}` }, { status: 404 });
            }
        }

        const isTerminal = status !== "running";
        const stats = body.stats !== undefined ? body.stats : undefined;
        const contextSourceIds = extractRunContextSourceIds({
            contextSourceIds: body.contextSourceIds,
            stats,
        });
        const statsRecord = typeof stats === "object" && stats !== null ? stats as Record<string, unknown> : {};
        const contextSnapshot = body.contextSnapshot !== undefined
            ? body.contextSnapshot
            : (statsRecord.contextSnapshot !== undefined ? statsRecord.contextSnapshot : undefined);

        // Complete an existing run.
        if (body.runId) {
            const [run] = await db.select().from(pipelineRuns).where(
                and(eq(pipelineRuns.id, body.runId), eq(pipelineRuns.pipelineId, pipeline.id), eq(pipelineRuns.companyId, companyId))
            ).limit(1);
            if (!run) {
                return NextResponse.json({ error: "Run not found" }, { status: 404 });
            }

            const [updated] = await db.update(pipelineRuns).set({
                status,
                summary: typeof body.summary === "string" ? body.summary : run.summary,
                statsJson: stats !== undefined ? stats : run.statsJson,
                contextSourceIds: contextSourceIds.length > 0 ? contextSourceIds : run.contextSourceIds,
                contextSnapshot: contextSnapshot !== undefined ? contextSnapshot : run.contextSnapshot,
                endedAt: isTerminal ? new Date() : run.endedAt,
            }).where(eq(pipelineRuns.id, run.id)).returning();

            if (isTerminal) {
                await db.update(pipelines).set({
                    lastRunAt: updated.startedAt,
                    lastRunStatus: status,
                    updatedAt: new Date(),
                }).where(eq(pipelines.id, pipeline.id));
            }

            const res = { message: "Run updated", run: updated };
            await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
            return NextResponse.json(res);
        }

        // Start a new run (or report a one-shot completed run).
        const [run] = await db.insert(pipelineRuns).values({
            companyId,
            pipelineId: pipeline.id,
            agentId,
            status,
            summary: typeof body.summary === "string" ? body.summary : null,
            statsJson: stats !== undefined ? stats : {},
            contextSourceIds,
            contextSnapshot: contextSnapshot !== undefined ? contextSnapshot : {},
            endedAt: isTerminal ? new Date() : null,
        }).returning();

        await db.update(pipelines).set({
            runCount: sql`${pipelines.runCount} + 1`,
            ...(isTerminal ? { lastRunAt: run.startedAt, lastRunStatus: status } : { lastRunAt: run.startedAt, lastRunStatus: "running" }),
            updatedAt: new Date(),
        }).where(eq(pipelines.id, pipeline.id));

        const res = { message: isTerminal ? "Run reported" : "Run started", run };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 201 });
    } catch (e) {
        console.error("Pipeline runs POST error:", e);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
