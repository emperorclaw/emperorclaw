export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeRecord } from "@/lib/member-scope";
import { memberMayUseAgent } from "@/lib/agent-access-server";
import { recordsWriteDenied } from "@/lib/resource-access";
import { db } from "@/db";
import { agents, pipelines } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { isPipelineScheduler, validateForActivation, PIPELINE_SCHEDULERS, PIPELINE_STATUSES, PipelineStatus } from "@/lib/pipelines";
import { closeScheduleStreak, emperorScheduleProblemFor, nextRunAtFor } from "@/lib/pipeline-runs";
import { humanActor, recordAudit } from "@/lib/audit";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Pipeline status changes are writes: the company role for company-wide
 * pipelines, "Can edit" or Admin on the pipeline's project/customer otherwise
 * (0.20, checked per pipeline below), never "Can view".
 */
async function getMembership() {
    const access = await companyRouteAccess("viewer", { module: "automations" });
    if (access.response) return { error: access.response };
    return { membership: access.ctx };
}

// PATCH /api/pipelines/[id] - UI changes: status (pause / activate / retire),
// the agent that runs it (ownerAgentId, null = none) and who schedules a cron
// automation (scheduledBy: agent | emperor). Any subset of the three.
export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await getMembership();
        if (auth.error) return auth.error;
        const membership = auth.membership;

        const { id } = await params;
        const body = await req.json().catch(() => ({})) as Record<string, unknown>;
        const status = body.status as string | undefined;
        const hasOwner = Object.prototype.hasOwnProperty.call(body, "ownerAgentId");
        const hasScheduler = body.scheduledBy !== undefined;

        if (status === undefined && !hasOwner && !hasScheduler) {
            return NextResponse.json({ error: "Nothing to change: send status, ownerAgentId or scheduledBy" }, { status: 400 });
        }
        if (status !== undefined && !PIPELINE_STATUSES.includes(status as PipelineStatus)) {
            return NextResponse.json({ error: `status must be one of: ${PIPELINE_STATUSES.join(", ")}` }, { status: 400 });
        }
        if (hasScheduler && !isPipelineScheduler(body.scheduledBy)) {
            return NextResponse.json({ error: `scheduledBy must be one of: ${PIPELINE_SCHEDULERS.join(", ")}` }, { status: 400 });
        }

        const [pipeline] = await db.select().from(pipelines).where(
            and(eq(pipelines.id, id), eq(pipelines.companyId, membership.companyId), isNull(pipelines.deletedAt))
        ).limit(1);
        if (!pipeline || !(await memberMaySeeRecord(membership.companyId, membership.scope, pipeline))) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }
        const denied = await recordsWriteDenied(membership, [pipeline], "member", "Pipeline");
        if (denied) return denied;

        if (status === "active" && pipeline.status !== "active") {
            const activationError = validateForActivation(pipeline);
            if (activationError) {
                return NextResponse.json({ error: activationError }, { status: 422 });
            }
        }

        let ownerAgentId = pipeline.ownerAgentId;
        if (hasOwner) {
            if (body.ownerAgentId === null || body.ownerAgentId === "") {
                ownerAgentId = null;
            } else if (typeof body.ownerAgentId !== "string") {
                return NextResponse.json({ error: "ownerAgentId must be an agent id or null" }, { status: 400 });
            } else {
                const [agent] = await db.select({ id: agents.id, budgetStatus: agents.budgetStatus }).from(agents).where(and(
                    eq(agents.companyId, membership.companyId), isNull(agents.deletedAt),
                    UUID_RE.test(body.ownerAgentId) ? eq(agents.id, body.ownerAgentId) : eq(agents.name, body.ownerAgentId),
                )).limit(1);
                // Owning an automation means getting its tasks: only an agent this person may hand work to.
                if (!agent || !(await memberMayUseAgent(membership, agent.id))) {
                    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
                }
                if (agent.budgetStatus === "paused") {
                    return NextResponse.json({ error: "That agent is paused. Resume it or choose another agent." }, { status: 422 });
                }
                ownerAgentId = agent.id;
            }
        }

        const nextStatus = status ?? pipeline.status;
        const scheduledBy = hasScheduler ? body.scheduledBy as string : pipeline.scheduledBy;
        const now = new Date();

        // Emperor starting runs on schedule hands its agent a task each time:
        // the person must be allowed to hand that agent work, and the schedule
        // must be one Emperor keeps (readable, at most every 15 minutes).
        const emperorScheduled = scheduledBy === "emperor" && pipeline.trigger === "cron" && nextStatus === "active";
        if (emperorScheduled && (scheduledBy !== pipeline.scheduledBy || nextStatus !== pipeline.status || ownerAgentId !== pipeline.ownerAgentId)) {
            if (ownerAgentId && !(await memberMayUseAgent(membership, ownerAgentId))) {
                return NextResponse.json({ error: "You can't hand work to the agent that runs this automation, so Emperor can't run it on schedule for you." }, { status: 403 });
            }
            const problem = await emperorScheduleProblemFor(membership.companyId, { trigger: pipeline.trigger, triggerConfig: pipeline.triggerConfig, scheduledBy });
            if (problem) return NextResponse.json({ error: problem }, { status: 422 });
        }

        // The next slot moves only when the schedule does (turned on or off,
        // or who keeps it); resuming starts from now, with no backlog.
        const scheduleChanged = nextStatus !== pipeline.status || scheduledBy !== pipeline.scheduledBy;
        const nextRunAt = scheduleChanged
            ? await nextRunAtFor(membership.companyId, { status: nextStatus, trigger: pipeline.trigger, triggerConfig: pipeline.triggerConfig }, now)
            : pipeline.nextRunAt;

        const [updated] = await db.update(pipelines).set({
            status: nextStatus,
            ownerAgentId,
            scheduledBy,
            nextRunAt,
            ...(nextStatus !== "paused" ? { pausedReason: null } : {}),
            updatedAt: now,
            ...(nextStatus === "retired" ? { deletedAt: now } : {}),
        }).where(eq(pipelines.id, pipeline.id)).returning();

        // Turned on again: earlier failed starts no longer count toward a pause.
        if (nextStatus === "active" && pipeline.status !== "active") await closeScheduleStreak(pipeline.id);

        const actor = humanActor(membership.userId);
        const target = { type: "pipeline" as const, id: pipeline.id };
        if (nextStatus !== pipeline.status && (nextStatus === "paused" || (nextStatus === "active" && pipeline.status === "paused"))) {
            await recordAudit({
                companyId: membership.companyId, actor, target,
                action: nextStatus === "paused" ? "pipeline.paused" : "pipeline.resumed",
                before: { status: pipeline.status }, after: { name: updated.name, status: nextStatus }, meta: { label: updated.name },
            });
        }
        if (ownerAgentId !== pipeline.ownerAgentId || scheduledBy !== pipeline.scheduledBy) {
            await recordAudit({
                companyId: membership.companyId, actor, target, action: "pipeline.updated",
                before: { ownerAgentId: pipeline.ownerAgentId, scheduledBy: pipeline.scheduledBy },
                after: { name: updated.name, ownerAgentId, scheduledBy }, meta: { label: updated.name },
            });
        }

        return NextResponse.json({ pipeline: updated });
    } catch (error) {
        console.error("Pipeline PATCH error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// DELETE /api/pipelines/[id] - soft-delete a registry entry from the operator UI.
export async function DELETE(
    _req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const auth = await getMembership();
        if (auth.error) return auth.error;
        const membership = auth.membership;
        const { id } = await params;

        const [pipeline] = await db.select().from(pipelines).where(
            and(eq(pipelines.id, id), eq(pipelines.companyId, membership.companyId), isNull(pipelines.deletedAt))
        ).limit(1);
        if (!pipeline || !(await memberMaySeeRecord(membership.companyId, membership.scope, pipeline))) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }
        const denied = await recordsWriteDenied(membership, [pipeline], "member", "Pipeline");
        if (denied) return denied;

        const [deleted] = await db.update(pipelines).set({
            status: "retired",
            deletedAt: new Date(),
            updatedAt: new Date(),
        }).where(eq(pipelines.id, pipeline.id)).returning();

        return NextResponse.json({ pipeline: deleted });
    } catch (error) {
        console.error("Pipeline DELETE error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
