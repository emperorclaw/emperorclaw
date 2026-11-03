export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";
import { companyRouteAccess } from "@/lib/company-access";
import { memberMaySeeRecord } from "@/lib/member-scope";
import { memberMayUseAgent } from "@/lib/agent-access-server";
import { recordsWriteDenied } from "@/lib/resource-access";
import { db } from "@/db";
import { agents, pipelines, scopedResources, users } from "@/db/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import {
    generateMermaid, isPipelineScheduler, parsePipelineContextConfig, parsePipelineSteps, validateForActivation,
    PIPELINE_SCHEDULERS, PIPELINE_STATUSES, type PipelineStatus, type PipelineStep,
} from "@/lib/pipelines";
import { closeScheduleStreak, companyTimezone, emperorScheduleProblemFor, nextRunAtFor } from "@/lib/pipeline-runs";
import { cronExpression, describeCron, isValidCron, isValidTimezone, scheduleTimezone } from "@/lib/pipeline-schedule";
import {
    DOC_MARKDOWN_MAX, operatorEditMessage, operatorFieldsOf, PURPOSE_MAX, scheduleHandBackMessage, withOperatorFields, type OperatorField, type ScheduleSnapshot,
} from "@/lib/pipeline-operator-edits";
import { appendThreadMessage, ensureDirectThread } from "@/lib/control-plane";
import { broadcastMcpEvent } from "@/lib/pubsub";
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

type ScheduleEdit = { cron: string; timezone: string | null } | null;

/** The schedule a request sets: undefined = unchanged, null = no schedule (manual), else a cron Emperor can read. */
function parseScheduleEdit(body: Record<string, unknown>): { value?: ScheduleEdit; error?: string } {
    if (!Object.prototype.hasOwnProperty.call(body, "schedule")) return {};
    if (body.schedule === null) return { value: null };
    const raw = body.schedule as { cron?: unknown; timezone?: unknown } | undefined;
    if (typeof raw !== "object" || raw === null || typeof raw.cron !== "string" || !raw.cron.trim()) {
        return { error: "schedule must be { cron, timezone? } or null" };
    }
    const cron = raw.cron.trim().replace(/\s+/g, " ");
    if (cron.length > 120 || !isValidCron(cron)) {
        return { error: `Invalid schedule: "${cron.slice(0, 120)}" is not a cron expression Emperor can read.` };
    }
    const timezone = typeof raw.timezone === "string" && raw.timezone.trim() ? raw.timezone.trim() : null;
    if (raw.timezone !== undefined && raw.timezone !== null && raw.timezone !== "" && !isValidTimezone(timezone)) {
        return { error: `Unknown time zone: ${String(raw.timezone).slice(0, 80)}` };
    }
    return { value: { cron, timezone } };
}

/** A text field of the request: undefined = unchanged, null = cleared. */
function parseText(body: Record<string, unknown>, key: string, max: number): { value?: string | null; error?: string } {
    if (!Object.prototype.hasOwnProperty.call(body, key)) return {};
    const raw = body[key];
    if (raw === null) return { value: null };
    if (typeof raw !== "string") return { error: `${key} must be text` };
    if (raw.length > max) return { error: `${key} is too long (at most ${max} characters)` };
    return { value: raw.trim() ? raw.trim() : null };
}

const CONTEXT_KEYS = ["contextQuery", "contextResourceIds", "contextTagFilters", "contextMaxChars"] as const;
const EDIT_KEYS = ["schedule", "purpose", "docMarkdown", "steps", ...CONTEXT_KEYS] as const;

function scheduleSnapshot(trigger: string, triggerConfig: unknown, companyTz: string | null): ScheduleSnapshot {
    const cron = trigger === "cron" ? cronExpression(triggerConfig) : null;
    return { cron, timezone: cron ? scheduleTimezone(triggerConfig, companyTz) : null, description: cron ? describeCron(cron) : null };
}

/**
 * One system message in the runner agent's direct thread about what the
 * person did (queued, so its runtime acts on it): an edit, or the schedule
 * handed back. Best effort: the change is saved either way. True when sent.
 */
async function tellRunner(input: {
    companyId: string;
    agentId: string;
    userId: string;
    text: (editorName: string) => string;
    metadata: Record<string, unknown>;
}): Promise<boolean> {
    try {
        const [person] = await db.select({ displayName: users.displayName, email: users.email }).from(users).where(eq(users.id, input.userId)).limit(1);
        const editorName = person?.displayName?.trim() || person?.email?.split("@")[0] || "A teammate";
        const thread = await ensureDirectThread(input.companyId, input.agentId, null);
        await appendThreadMessage({
            companyId: input.companyId,
            threadId: thread.id,
            senderType: "system",
            targetAgentId: input.agentId,
            text: input.text(editorName),
            deliveryState: "queued",
            metadataJson: input.metadata,
        });
        return true;
    } catch (error) {
        console.warn("[pipelines] could not tell the agent about a change:", error instanceof Error ? error.message : error);
        return false;
    }
}

/** Company Brain resources of this company among `ids`; the ids that are not (or are not ids at all). */
async function unknownResourceIds(companyId: string, ids: string[]): Promise<string[]> {
    const wellFormed = ids.filter((id) => UUID_RE.test(id));
    const found = wellFormed.length > 0
        ? new Set((await db.select({ id: scopedResources.id }).from(scopedResources)
            .where(and(eq(scopedResources.companyId, companyId), inArray(scopedResources.id, wellFormed)))).map((row) => row.id))
        : new Set<string>();
    return ids.filter((id) => !found.has(id));
}

// PATCH /api/pipelines/[id] - UI changes: status (pause / activate / retire),
// the agent that runs it (ownerAgentId, null = none), who schedules a cron
// automation (scheduledBy: agent | emperor), and the operator's edits of the
// automation itself: schedule ({ cron, timezone } or null for no schedule),
// purpose, docMarkdown, steps and the context pack. Any subset.
//
// An edited field becomes operator-owned (lib/pipeline-operator-edits.ts):
// agents can no longer overwrite it. A schedule set here is kept by Emperor
// (scheduledBy 'emperor'), and the runner agent gets one message saying what
// changed. The name is the agents' registration key and can't be changed.
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
        const hasEdits = EDIT_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));

        if (status === undefined && !hasOwner && !hasScheduler && !hasEdits && body.name === undefined) {
            return NextResponse.json({ error: "Nothing to change: send status, ownerAgentId, scheduledBy, schedule, purpose, docMarkdown, steps or the context pack" }, { status: 400 });
        }
        if (status !== undefined && !PIPELINE_STATUSES.includes(status as PipelineStatus)) {
            return NextResponse.json({ error: `status must be one of: ${PIPELINE_STATUSES.join(", ")}` }, { status: 400 });
        }
        if (hasScheduler && !isPipelineScheduler(body.scheduledBy)) {
            return NextResponse.json({ error: `scheduledBy must be one of: ${PIPELINE_SCHEDULERS.join(", ")}` }, { status: 400 });
        }
        const scheduleEdit = parseScheduleEdit(body);
        if (scheduleEdit.error) return NextResponse.json({ error: scheduleEdit.error }, { status: 400 });
        const purposeEdit = parseText(body, "purpose", PURPOSE_MAX);
        if (purposeEdit.error) return NextResponse.json({ error: purposeEdit.error }, { status: 400 });
        const docEdit = parseText(body, "docMarkdown", DOC_MARKDOWN_MAX);
        if (docEdit.error) return NextResponse.json({ error: docEdit.error }, { status: 400 });
        const stepsEdit = body.steps !== undefined ? parsePipelineSteps(body.steps) : null;
        if (stepsEdit?.error) return NextResponse.json({ error: stepsEdit.error }, { status: 400 });

        const [pipeline] = await db.select().from(pipelines).where(
            and(eq(pipelines.id, id), eq(pipelines.companyId, membership.companyId), isNull(pipelines.deletedAt))
        ).limit(1);
        if (!pipeline || !(await memberMaySeeRecord(membership.companyId, membership.scope, pipeline))) {
            return NextResponse.json({ error: "Pipeline not found" }, { status: 404 });
        }
        const denied = await recordsWriteDenied(membership, [pipeline], "member", "Pipeline");
        if (denied) return denied;

        // The name is how the agent re-registers it (upsert by name): renaming
        // here would make the agent create a duplicate on its next boot.
        if (body.name !== undefined && body.name !== pipeline.name) {
            return NextResponse.json({ error: "The name can't be changed: the agent registers this automation by its name." }, { status: 400 });
        }
        if (scheduleEdit.value !== undefined && pipeline.trigger === "event") {
            return NextResponse.json({ error: "This automation runs when an event happens; its schedule can't be set here." }, { status: 400 });
        }

        // ─── What the person edited ────────────────────────────────────────
        let trigger = pipeline.trigger;
        let triggerConfig: unknown = pipeline.triggerConfig;
        if (scheduleEdit.value !== undefined) {
            const rest = Object.fromEntries(Object.entries((pipeline.triggerConfig && typeof pipeline.triggerConfig === "object" ? pipeline.triggerConfig : {}) as Record<string, unknown>)
                .filter(([key]) => key !== "cron" && key !== "timezone"));
            trigger = scheduleEdit.value ? "cron" : "manual";
            triggerConfig = scheduleEdit.value
                ? { ...rest, cron: scheduleEdit.value.cron, ...(scheduleEdit.value.timezone ? { timezone: scheduleEdit.value.timezone } : {}) }
                : rest;
        }
        const scheduleEdited = trigger !== pipeline.trigger || JSON.stringify(triggerConfig) !== JSON.stringify(pipeline.triggerConfig);
        const purpose = purposeEdit.value !== undefined ? purposeEdit.value : pipeline.purpose;
        const docMarkdown = docEdit.value !== undefined ? docEdit.value : pipeline.docMarkdown;
        const stepsJson: unknown = stepsEdit ? stepsEdit.steps : pipeline.stepsJson;
        for (const key of ["contextResourceIds", "contextTagFilters"] as const) {
            if (body[key] !== undefined && body[key] !== null && !Array.isArray(body[key])) {
                return NextResponse.json({ error: `${key} must be a list (or null to clear it)` }, { status: 400 });
            }
        }
        // A sent key replaces the stored value; null or [] clears it.
        const pick = <K extends (typeof CONTEXT_KEYS)[number]>(key: K) => (body[key] !== undefined ? body[key] : pipeline[key]);
        const context = CONTEXT_KEYS.some((key) => body[key] !== undefined)
            ? parsePipelineContextConfig({
                contextQuery: pick("contextQuery"),
                contextResourceIds: pick("contextResourceIds"),
                contextTagFilters: pick("contextTagFilters"),
                contextMaxChars: body.contextMaxChars !== undefined && body.contextMaxChars !== null ? body.contextMaxChars : pipeline.contextMaxChars,
            })
            : { contextQuery: pipeline.contextQuery, contextResourceIds: pipeline.contextResourceIds, contextTagFilters: pipeline.contextTagFilters, contextMaxChars: pipeline.contextMaxChars };
        // Pinned sources must be this company's Company Brain resources.
        const pinned = Array.isArray(context.contextResourceIds) ? context.contextResourceIds as string[] : [];
        if (Array.isArray(body.contextResourceIds) && pinned.length > 0) {
            const unknown = await unknownResourceIds(membership.companyId, pinned);
            if (unknown.length > 0) {
                return NextResponse.json({ error: `Unknown Company Brain resources: ${unknown.slice(0, 5).join(", ")}` }, { status: 400 });
            }
        }
        const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const edited: OperatorField[] = [];
        if (scheduleEdited) edited.push("schedule");
        if (purpose !== pipeline.purpose) edited.push("purpose");
        if (docMarkdown !== pipeline.docMarkdown) edited.push("docMarkdown");
        if (!sameJson(stepsJson, pipeline.stepsJson)) edited.push("steps");
        if (context.contextQuery !== pipeline.contextQuery || context.contextMaxChars !== pipeline.contextMaxChars
            || !sameJson(context.contextResourceIds, pipeline.contextResourceIds) || !sameJson(context.contextTagFilters, pipeline.contextTagFilters)) {
            edited.push("context");
        }

        const nextStatus = status ?? pipeline.status;
        // A schedule set in the app is Emperor's to keep: the agent's own
        // schedule (whatever it was) is no longer used.
        const scheduledBy = scheduleEdited && trigger === "cron" ? "emperor" : hasScheduler ? body.scheduledBy as string : pipeline.scheduledBy;

        // An active automation stays documented: purpose, docs and a step.
        if (nextStatus === "active" && (pipeline.status !== "active" || edited.length > 0)) {
            const activationError = validateForActivation({ purpose, docMarkdown, stepsJson });
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

        // Editing what an automation does changes the work its agent is
        // handed: only someone who may hand that agent work may edit it.
        if (edited.length > 0 && pipeline.ownerAgentId && !(await memberMayUseAgent(membership, pipeline.ownerAgentId))) {
            return NextResponse.json({ error: "You can't hand work to the agent that runs this automation, so you can't change when it runs or what it does." }, { status: 403 });
        }

        const now = new Date();

        // Emperor starting runs on schedule hands its agent a task each time:
        // the person must be allowed to hand that agent work, and the schedule
        // must be one Emperor keeps (readable, at most every 15 minutes). A
        // schedule set here is checked even on a draft, so it can be turned on.
        const emperorScheduled = scheduledBy === "emperor" && trigger === "cron" && nextStatus === "active";
        if (emperorScheduled && (scheduledBy !== pipeline.scheduledBy || nextStatus !== pipeline.status || ownerAgentId !== pipeline.ownerAgentId || scheduleEdited)) {
            if (ownerAgentId && !(await memberMayUseAgent(membership, ownerAgentId))) {
                return NextResponse.json({ error: "You can't hand work to the agent that runs this automation, so Emperor can't run it on schedule for you." }, { status: 403 });
            }
        }
        if (scheduledBy === "emperor" && trigger === "cron" && (scheduleEdited || (emperorScheduled && (scheduledBy !== pipeline.scheduledBy || nextStatus !== pipeline.status || ownerAgentId !== pipeline.ownerAgentId)))) {
            const problem = await emperorScheduleProblemFor(membership.companyId, { trigger, triggerConfig, scheduledBy });
            if (problem) return NextResponse.json({ error: problem }, { status: 422 });
        }

        // The next slot moves only when the schedule does (turned on or off,
        // who keeps it, or a new time); resuming starts from now, with no backlog.
        const scheduleChanged = nextStatus !== pipeline.status || scheduledBy !== pipeline.scheduledBy || scheduleEdited;
        const nextRunAt = scheduleChanged
            ? await nextRunAtFor(membership.companyId, { status: nextStatus, trigger, triggerConfig }, now)
            : pipeline.nextRunAt;

        // Choosing "the agent runs it" again hands the schedule back to the agent.
        const releaseSchedule = !scheduleEdited && scheduledBy === "agent" && pipeline.scheduledBy === "emperor";
        const operatorFields = edited.length > 0 || releaseSchedule
            ? withOperatorFields(pipeline.operatorFields, edited, releaseSchedule ? ["schedule"] : [])
            : operatorFieldsOf(pipeline.operatorFields);

        const [updated] = await db.update(pipelines).set({
            status: nextStatus,
            ownerAgentId,
            scheduledBy,
            nextRunAt,
            ...(nextStatus !== "paused" ? { pausedReason: null } : {}),
            ...(edited.length > 0 ? {
                trigger,
                triggerConfig,
                purpose,
                docMarkdown,
                stepsJson,
                contextQuery: context.contextQuery,
                contextResourceIds: context.contextResourceIds,
                contextTagFilters: context.contextTagFilters,
                contextMaxChars: context.contextMaxChars,
                diagramMermaid: edited.includes("schedule") || edited.includes("steps")
                    ? generateMermaid(trigger, triggerConfig, Array.isArray(stepsJson) ? stepsJson as PipelineStep[] : [])
                    : pipeline.diagramMermaid,
                operatorEditedAt: now,
                operatorEditedBy: membership.userId,
            } : {}),
            operatorFields,
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
        if (ownerAgentId !== pipeline.ownerAgentId || scheduledBy !== pipeline.scheduledBy || edited.length > 0) {
            // The activity log keeps which fields changed and the schedule, not the texts.
            const before: Record<string, unknown> = { ownerAgentId: pipeline.ownerAgentId, scheduledBy: pipeline.scheduledBy };
            const after: Record<string, unknown> = { name: updated.name, ownerAgentId, scheduledBy };
            if (edited.includes("schedule")) {
                const zoneOf = (config: unknown) => (config as { timezone?: unknown } | null)?.timezone ?? null;
                Object.assign(before, { trigger: pipeline.trigger, cron: cronExpression(pipeline.triggerConfig), timezone: zoneOf(pipeline.triggerConfig) });
                Object.assign(after, { trigger, cron: cronExpression(triggerConfig), timezone: zoneOf(triggerConfig) });
            }
            await recordAudit({
                companyId: membership.companyId, actor, target, action: "pipeline.updated",
                before, after, meta: { label: updated.name, ...(edited.length > 0 ? { fields: edited.join(", ") } : {}) },
            });
        }

        // The runner hears about it: one message for an edit, one when the
        // schedule is handed back (with the stored cron, which it now fires).
        let agentNotified = false;
        const handBack = releaseSchedule && trigger === "cron";
        if (ownerAgentId && (edited.length > 0 || handBack)) {
            const companyTz = edited.includes("schedule") || handBack ? await companyTimezone(membership.companyId) : null;
            const pipelineRef = { pipelineId: updated.id, pipelineName: updated.name };
            agentNotified = await tellRunner({
                companyId: membership.companyId,
                agentId: ownerAgentId,
                userId: membership.userId,
                text: (editorName) => edited.length > 0
                    ? operatorEditMessage({
                        ...pipelineRef, editorName, changed: edited,
                        schedule: edited.includes("schedule") ? {
                            before: scheduleSnapshot(pipeline.trigger, pipeline.triggerConfig, companyTz),
                            after: scheduleSnapshot(trigger, triggerConfig, companyTz),
                        } : null,
                    })
                    : scheduleHandBackMessage({ ...pipelineRef, editorName, schedule: scheduleSnapshot(trigger, triggerConfig, companyTz) }),
                metadata: edited.length > 0
                    ? { pipelineEdited: true, pipelineId: updated.id, operatorFields: edited }
                    : { pipelineScheduleHandedBack: true, pipelineId: updated.id },
            });
        }
        if (edited.length > 0 || releaseSchedule) {
            await broadcastMcpEvent(membership.companyId, { type: "pipeline_updated", pipelineId: pipeline.id, operatorFields: updated.operatorFields });
        }

        return NextResponse.json({ pipeline: updated, agentNotified });
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
