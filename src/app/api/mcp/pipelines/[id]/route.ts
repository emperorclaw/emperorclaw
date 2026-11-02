import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { pipelines, pipelineRuns } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { mcpDenyOutOfScope, mcpMayReachAgent, mcpRouteAccess } from "@/lib/mcp-access";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateMermaid, isPipelineScheduler, parsePipelineContextConfig, parsePipelineSteps, validateForActivation, PIPELINE_SCHEDULERS, PIPELINE_STATUSES, PipelineStatus, PipelineStep } from "@/lib/pipelines";
import { closeScheduleStreak, emperorScheduleProblemFor, nextRunAtFor } from "@/lib/pipeline-runs";
import { moduleGuard } from "@/lib/modules-server";

async function findPipeline(companyId: string, id: string) {
    const [row] = await db.select().from(pipelines).where(
        and(eq(pipelines.id, id), eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt))
    ).limit(1);
    return row;
}

// GET /api/mcp/pipelines/[id] — pipeline detail plus recent runs.
export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const moduleOff = await moduleGuard(companyId, "automations");
    if (moduleOff) return moduleOff;
    const { id } = await params;

    try {
        const pipeline = await findPipeline(companyId, id);
        if (!pipeline) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }
        const pipelineDenied = await mcpDenyOutOfScope(req, companyId, auth.companyToken!, pipeline, "Pipeline");
        if (pipelineDenied) return pipelineDenied;

        const runs = await db.select().from(pipelineRuns)
            .where(eq(pipelineRuns.pipelineId, pipeline.id))
            .orderBy(desc(pipelineRuns.startedAt))
            .limit(20);

        return NextResponse.json({ pipeline, runs });
    } catch (err) {
        console.error("Pipeline GET error:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// PATCH /api/mcp/pipelines/[id] — update fields / change status.
// If steps or trigger change, the diagram is regenerated server-side.
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const moduleOff = await moduleGuard(companyId, "automations");
    if (moduleOff) return moduleOff;
    const { id } = await params;
    const endpoint = `/api/mcp/pipelines/${id}`;

    const { requestHash, cachedResponse, error: idempError, status: idempStatus } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status: idempStatus });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const pipeline = await findPipeline(companyId, id);
        if (!pipeline) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }
        const pipelineDenied = await mcpDenyOutOfScope(req, companyId, auth.companyToken!, pipeline, "Pipeline");
        if (pipelineDenied) return pipelineDenied;

        const body = await req.json();
        const updates: Record<string, unknown> = { updatedAt: new Date() };

        if (typeof body.purpose === "string") updates.purpose = body.purpose;
        if (typeof body.docMarkdown === "string") updates.docMarkdown = body.docMarkdown;
        if (typeof body.runtimeRef === "string") updates.runtimeRef = body.runtimeRef;
        if (typeof body.summary === "string") updates.summary = body.summary;
        if (body.scheduledBy !== undefined) {
            if (!isPipelineScheduler(body.scheduledBy)) {
                return NextResponse.json({ error: `scheduledBy must be one of: ${PIPELINE_SCHEDULERS.join(", ")}` }, { status: 400 });
            }
            updates.scheduledBy = body.scheduledBy;
        }
        if (
            body.contextQuery !== undefined ||
            body.contextResourceIds !== undefined ||
            body.contextTagFilters !== undefined ||
            body.contextMaxChars !== undefined
        ) {
            const contextConfig = parsePipelineContextConfig({
                contextQuery: body.contextQuery ?? pipeline.contextQuery,
                contextResourceIds: body.contextResourceIds ?? pipeline.contextResourceIds,
                contextTagFilters: body.contextTagFilters ?? pipeline.contextTagFilters,
                contextMaxChars: body.contextMaxChars ?? pipeline.contextMaxChars,
            });
            updates.contextQuery = contextConfig.contextQuery;
            updates.contextResourceIds = contextConfig.contextResourceIds;
            updates.contextTagFilters = contextConfig.contextTagFilters;
            updates.contextMaxChars = contextConfig.contextMaxChars;
        }

        let steps = Array.isArray(pipeline.stepsJson) ? pipeline.stepsJson as PipelineStep[] : [];
        let trigger = pipeline.trigger;
        let triggerConfig: unknown = pipeline.triggerConfig;
        let regenerate = false;

        if (body.steps !== undefined) {
            const parsed = parsePipelineSteps(body.steps);
            if (parsed.error) return NextResponse.json({ error: parsed.error }, { status: 400 });
            steps = parsed.steps;
            updates.stepsJson = parsed.steps;
            regenerate = true;
        }
        if (typeof body.trigger === "string") {
            if (!["cron", "event", "manual"].includes(body.trigger)) {
                return NextResponse.json({ error: "trigger must be one of: cron, event, manual" }, { status: 400 });
            }
            trigger = body.trigger;
            updates.trigger = body.trigger;
            regenerate = true;
        }
        if (body.triggerConfig !== undefined) {
            triggerConfig = body.triggerConfig;
            updates.triggerConfig = body.triggerConfig;
            regenerate = true;
        }
        if (regenerate) {
            updates.diagramMermaid = generateMermaid(trigger, triggerConfig, steps);
        }

        if (typeof body.status === "string") {
            if (!PIPELINE_STATUSES.includes(body.status as PipelineStatus)) {
                return NextResponse.json({ error: `status must be one of: ${PIPELINE_STATUSES.join(", ")}` }, { status: 400 });
            }
            if (body.status === "active") {
                const activationError = validateForActivation({
                    purpose: (updates.purpose as string | undefined) ?? pipeline.purpose,
                    docMarkdown: (updates.docMarkdown as string | undefined) ?? pipeline.docMarkdown,
                    stepsJson: steps,
                });
                if (activationError) {
                    return NextResponse.json({ error: activationError }, { status: 422 });
                }
            }
            updates.status = body.status;
        }

        // nextRunAt follows the cron (server-computed, from now); an agent may
        // still state it for an event or manual trigger it schedules itself.
        const nextTrigger = (updates.trigger as string | undefined) ?? pipeline.trigger;
        const resulting = {
            trigger: nextTrigger,
            triggerConfig: updates.triggerConfig !== undefined ? updates.triggerConfig : pipeline.triggerConfig,
            scheduledBy: (updates.scheduledBy as string | undefined) ?? pipeline.scheduledBy,
            status: (updates.status as string | undefined) ?? pipeline.status,
        };
        // Only a real change moves the next slot: resending the same status or
        // schedule (agents re-sync often) must not push a pending slot back.
        const scheduleChanged = resulting.trigger !== pipeline.trigger || resulting.status !== pipeline.status
            || resulting.scheduledBy !== pipeline.scheduledBy || JSON.stringify(resulting.triggerConfig) !== JSON.stringify(pipeline.triggerConfig);
        const resumed = resulting.status === "active" && pipeline.status !== "active";
        // Emperor's schedule hands the owner a task at every slot: the caller
        // must be allowed to hand that agent work, and the schedule must be one
        // Emperor keeps (readable, at most every 15 minutes).
        if (scheduleChanged && resulting.scheduledBy === "emperor" && resulting.trigger === "cron" && resulting.status === "active") {
            const scoped = await mcpRouteAccess(companyId, auth.companyToken!, null);
            if (scoped.response) return scoped.response;
            if (pipeline.ownerAgentId && !mcpMayReachAgent(scoped.access, pipeline.ownerAgentId)) {
                return NextResponse.json({ error: "Emperor's schedule would hand tasks to an agent outside your scope" }, { status: 403 });
            }
            const problem = await emperorScheduleProblemFor(companyId, resulting);
            if (problem) return NextResponse.json({ error: problem }, { status: 422 });
        }
        if (resulting.status !== "paused") updates.pausedReason = null;
        if (nextTrigger === "cron") {
            if (scheduleChanged) {
                updates.nextRunAt = await nextRunAtFor(companyId, {
                    status: (updates.status as string | undefined) ?? pipeline.status,
                    trigger: nextTrigger,
                    triggerConfig: updates.triggerConfig !== undefined ? updates.triggerConfig : pipeline.triggerConfig,
                });
            }
        } else if (body.nextRunAt) {
            const stated = new Date(body.nextRunAt);
            if (!Number.isNaN(stated.getTime())) updates.nextRunAt = stated;
        } else if (body.trigger !== undefined) {
            updates.nextRunAt = null;
        }

        const [updated] = await db.update(pipelines).set(updates)
            .where(eq(pipelines.id, pipeline.id)).returning();

        if (resumed) await closeScheduleStreak(pipeline.id);

        const res = { message: "Pipeline updated", pipeline: updated };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res);
    } catch (e) {
        console.error("Pipeline PATCH error:", e);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}

// DELETE /api/mcp/pipelines/[id] — retire (soft delete).
export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const moduleOff = await moduleGuard(companyId, "automations");
    if (moduleOff) return moduleOff;
    const { id } = await params;
    const endpoint = `/api/mcp/pipelines/${id}`;

    const { requestHash, cachedResponse, error: idempError, status: idempStatus } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status: idempStatus });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const pipeline = await findPipeline(companyId, id);
        if (!pipeline) {
            return NextResponse.json({ error: "Pipeline not found or already retired" }, { status: 404 });
        }
        const pipelineDenied = await mcpDenyOutOfScope(req, companyId, auth.companyToken!, pipeline, "Pipeline");
        if (pipelineDenied) return pipelineDenied;

        const [retired] = await db.update(pipelines).set({
            status: "retired",
            deletedAt: new Date(),
            updatedAt: new Date(),
        }).where(eq(pipelines.id, pipeline.id)).returning();

        const res = { message: `Pipeline ${pipeline.name} retired`, pipeline: retired };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res);
    } catch (e) {
        console.error("Pipeline DELETE error:", e);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
