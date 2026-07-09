import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { pipelines, projects, customers } from "@/db/schema";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse, resolveAgentId } from "@/lib/mcp";
import { and, desc, eq, isNull } from "drizzle-orm";
import { generateMermaid, parsePipelineContextConfig, parsePipelineSteps, validateForActivation, PIPELINE_STATUSES, PipelineStatus } from "@/lib/pipelines";

// GET /api/mcp/pipelines — list registered pipelines.
// Filters: ?name= ?status= ?projectId=
export async function GET(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { searchParams } = new URL(req.url);
    const limit = Math.min(parseInt(searchParams.get("limit") || "100", 10), 500);
    const name = searchParams.get("name");
    const status = searchParams.get("status");
    const projectId = searchParams.get("projectId");

    try {
        const conditions = [eq(pipelines.companyId, companyId), isNull(pipelines.deletedAt)];
        if (name) conditions.push(eq(pipelines.name, name));
        if (status) conditions.push(eq(pipelines.status, status));
        if (projectId) conditions.push(eq(pipelines.projectId, projectId));

        const rows = await db.select()
            .from(pipelines)
            .where(and(...conditions))
            .orderBy(desc(pipelines.updatedAt))
            .limit(limit);

        return NextResponse.json({ pipelines: rows });
    } catch (err) {
        console.error("Error fetching pipelines:", err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

// POST /api/mcp/pipelines — register (or re-register) a pipeline.
//
// Agent-first contract: the agent builds the pipeline in its own runtime,
// then registers it here. Registration is an UPSERT by (company, name) so an
// agent can safely re-register on every boot without creating duplicates.
//
// Body: {
//   name (required), purpose, docMarkdown,
//   trigger: 'cron' | 'event' | 'manual', triggerConfig: { cron | event },
//   steps: [{ name, agentRef?, taskType?, description?, gate? }],
//   runtimeRef, projectId?, customerId?, agentId? (caller — becomes owner),
//   status? ('draft' | 'active' | 'paused' | 'retired')
// }
// diagramMermaid is ALWAYS generated server-side. Activation requires
// purpose + docMarkdown + at least one step.
export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const endpoint = "/api/mcp/pipelines";

    const { requestHash, cachedResponse, error: idempError, status: idempStatus } = await checkIdempotency(req, companyId, endpoint);
    if (idempError) return NextResponse.json({ error: idempError }, { status: idempStatus });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const body = await req.json();
        const {
            name, purpose, docMarkdown,
            trigger = "manual", triggerConfig = {},
            steps: rawSteps = [],
            contextQuery, contextResourceIds, contextTagFilters, contextMaxChars,
            runtimeRef, projectId, customerId, agentId,
            status: requestedStatus,
        } = body;

        if (!name || typeof name !== "string" || !name.trim()) {
            return NextResponse.json({ error: "name is required" }, { status: 400 });
        }
        if (!["cron", "event", "manual"].includes(trigger)) {
            return NextResponse.json({ error: "trigger must be one of: cron, event, manual" }, { status: 400 });
        }
        if (requestedStatus && !PIPELINE_STATUSES.includes(requestedStatus as PipelineStatus)) {
            return NextResponse.json({ error: `status must be one of: ${PIPELINE_STATUSES.join(", ")}` }, { status: 400 });
        }

        const { steps, error: stepsError } = parsePipelineSteps(rawSteps);
        if (stepsError) {
            return NextResponse.json({ error: stepsError }, { status: 400 });
        }

        let ownerAgentId: string | null = null;
        if (agentId) {
            try {
                ownerAgentId = await resolveAgentId(companyId, agentId);
            } catch {
                return NextResponse.json({ error: `Agent not found: ${agentId}` }, { status: 404 });
            }
        }

        if (projectId) {
            const [project] = await db.select({ id: projects.id }).from(projects).where(
                and(eq(projects.id, projectId), eq(projects.companyId, companyId), isNull(projects.deletedAt))
            ).limit(1);
            if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });
        }
        if (customerId) {
            const [customer] = await db.select({ id: customers.id }).from(customers).where(
                and(eq(customers.id, customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt))
            ).limit(1);
            if (!customer) return NextResponse.json({ error: "Customer not found" }, { status: 404 });
        }

        const diagramMermaid = generateMermaid(trigger, triggerConfig, steps);
        const contextConfig = parsePipelineContextConfig({
            contextQuery,
            contextResourceIds,
            contextTagFilters,
            contextMaxChars,
        });

        const [existing] = await db.select().from(pipelines).where(
            and(eq(pipelines.companyId, companyId), eq(pipelines.name, name.trim()), isNull(pipelines.deletedAt))
        ).limit(1);

        const candidate = {
            purpose: purpose ?? existing?.purpose ?? null,
            docMarkdown: docMarkdown ?? existing?.docMarkdown ?? null,
            stepsJson: steps,
        };
        const status = (requestedStatus as PipelineStatus | undefined) ?? existing?.status ?? "draft";
        if (status === "active") {
            const activationError = validateForActivation(candidate);
            if (activationError) {
                return NextResponse.json({ error: activationError }, { status: 422 });
            }
        }

        let row;
        let created = false;
        if (existing) {
            [row] = await db.update(pipelines).set({
                purpose: candidate.purpose,
                docMarkdown: candidate.docMarkdown,
                trigger,
                triggerConfig,
                stepsJson: steps,
                diagramMermaid,
                contextQuery: contextQuery !== undefined ? contextConfig.contextQuery : existing.contextQuery,
                contextResourceIds: contextResourceIds !== undefined ? contextConfig.contextResourceIds : existing.contextResourceIds,
                contextTagFilters: contextTagFilters !== undefined ? contextConfig.contextTagFilters : existing.contextTagFilters,
                contextMaxChars: contextMaxChars !== undefined ? contextConfig.contextMaxChars : existing.contextMaxChars,
                runtimeRef: runtimeRef ?? existing.runtimeRef,
                projectId: projectId ?? existing.projectId,
                customerId: customerId ?? existing.customerId,
                ownerAgentId: ownerAgentId ?? existing.ownerAgentId,
                status,
                updatedAt: new Date(),
            }).where(eq(pipelines.id, existing.id)).returning();
        } else {
            created = true;
            [row] = await db.insert(pipelines).values({
                companyId,
                name: name.trim(),
                purpose: candidate.purpose,
                docMarkdown: candidate.docMarkdown,
                trigger,
                triggerConfig,
                stepsJson: steps,
                diagramMermaid,
                contextQuery: contextConfig.contextQuery,
                contextResourceIds: contextConfig.contextResourceIds,
                contextTagFilters: contextConfig.contextTagFilters,
                contextMaxChars: contextConfig.contextMaxChars,
                runtimeRef: runtimeRef ?? null,
                projectId: projectId ?? null,
                customerId: customerId ?? null,
                ownerAgentId,
                status,
                createdByType: "agent",
                createdById: ownerAgentId,
            }).returning();
        }

        const warnings: string[] = [];
        if (status !== "active") {
            const activationError = validateForActivation(candidate);
            if (activationError) warnings.push(`Not activatable yet: ${activationError}`);
        }

        const res = {
            message: created ? "Pipeline registered" : "Pipeline re-registered (updated)",
            pipeline: row,
            warnings,
        };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: created ? 201 : 200 });
    } catch (e) {
        console.error("Pipelines POST Error:", e);
        return NextResponse.json({ error: "Internal server error" }, { status: 500 });
    }
}
