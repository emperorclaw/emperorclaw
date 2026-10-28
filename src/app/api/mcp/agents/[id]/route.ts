import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { resolveAgentId, verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { mcpAgentUpdateDenial, mcpRouteAccess } from "@/lib/mcp-access";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { parseJsonBody, optionalString } from "@/lib/validation";
import { readAgentBudget } from "@/lib/agent-budget";
import { AgentInputError, updateAgentForCompany } from "@/lib/agents-crud";
import { mcpActor, recordAudit } from "@/lib/audit";
import { normalizeAppearance } from "@/lib/character/model";
import { NAME_MAX } from "@/lib/input-limits";

const updateAgentSchema = z.object({
    name: z.string().min(1).max(NAME_MAX, `name must be at most ${NAME_MAX} characters`).optional(),
    role: optionalString.optional(),
    avatarUrl: optionalString.optional(),
    // null clears the drawn override; anything else must be a valid appearance.
    avatarAppearance: z.unknown().refine((v) => v === undefined || v === null || normalizeAppearance(v) !== null, { message: "Invalid avatarAppearance" }).optional(),
    skillsJson: z.array(z.unknown()).optional(),
    memory: optionalString.optional(),
    modelPolicyJson: z.record(z.string(), z.unknown()).optional(),
    concurrencyLimit: z.number().int().min(0).optional(),
}).loose();

/** Runtime preflight: authoritative spend check and monthly rollover. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    try {
        const { id } = await params;
        // An agent reads only agents it may work with (always itself).
        const reach = await mcpRouteAccess(auth.companyToken!.companyId, auth.companyToken!, null);
        if (reach.response) return reach.response;
        // Resolve once: the scope check and the read must target the same agent.
        const agentId = await resolveAgentId(auth.companyToken!.companyId, id).catch(() => null);
        if (!agentId) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        const allowed = reach.access.allowedAgentIds;
        if (allowed && !allowed.has(agentId)) {
            return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        }
        const agent = await readAgentBudget(auth.companyToken!.companyId, agentId);
        if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
        return NextResponse.json({ agent }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
        console.error("Agent budget check failed:", error);
        return NextResponse.json({ error: "Budget check unavailable" }, { status: 503 });
    }
}

export async function PATCH(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;
    const endpoint = `/api/mcp/agents/${agentId}`;

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const parsed = await parseJsonBody(req, updateAgentSchema);
        if (parsed.error !== undefined) {
            return NextResponse.json({ error: parsed.error }, { status: 400 });
        }
        const body = parsed.data as Record<string, unknown>;
        // An agent token may only update itself, and never its budget/model/scope.
        const denial = await mcpAgentUpdateDenial(companyId, auth.companyToken!, agentId, body);
        if (denial) return NextResponse.json({ error: denial }, { status: 403 });
        const { name, role, skillsJson, memory, modelPolicyJson, concurrencyLimit, avatarUrl, avatarAppearance } = body as {
            name?: string; role?: string; skillsJson?: unknown[]; memory?: string;
            modelPolicyJson?: Record<string, unknown>; concurrencyLimit?: number; avatarUrl?: string; avatarAppearance?: unknown;
        };

        // Ensure we actually have something to update
        const hasBudget = typeof body.monthlyBudgetCents === "number" || typeof body.monthlyCostCents === "number" || typeof body.monthlyTokenUsage === "number" || (typeof body.budgetStatus === "string" && ["active","warning","paused"].includes(body.budgetStatus));
        const hasLLM = typeof body.llmProvider === "string" || typeof body.llmModel === "string";
        if (name === undefined && role === undefined && skillsJson === undefined && memory === undefined && modelPolicyJson === undefined && concurrencyLimit === undefined && avatarUrl === undefined && avatarAppearance === undefined && !hasBudget && !hasLLM) {
            return NextResponse.json({ error: "At least one field to update must be provided" }, { status: 400 });
        }

        const [existing] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Agent not found or unauthorized." }, { status: 404 });
        }

        const updatedAgent = await updateAgentForCompany({
            companyId,
            agentId,
            name,
            role,
            skillsJson,
            memory,
            modelPolicyJson,
            concurrencyLimit,
            avatarUrl,
            avatarAppearance,
            monthlyBudgetCents: typeof body.monthlyBudgetCents === "number" ? body.monthlyBudgetCents : undefined,
            monthlyCostCents: typeof body.monthlyCostCents === "number" ? body.monthlyCostCents : undefined,
            monthlyTokenUsage: typeof body.monthlyTokenUsage === "number" ? body.monthlyTokenUsage : undefined,
            budgetStatus: typeof body.budgetStatus === "string" ? body.budgetStatus as "active" | "warning" | "paused" : undefined,
            llmProvider: typeof body.llmProvider === "string" ? body.llmProvider : undefined,
            llmModel: typeof body.llmModel === "string" ? body.llmModel : undefined,
            actor: mcpActor(auth.companyToken!.agentId, auth.companyToken!.id),
        });

        const res = { message: `Agent ${agentId} updated successfully`, agent: updatedAgent };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        if (err instanceof AgentInputError) return NextResponse.json({ error: err.message }, { status: 400 });
        console.error(`Error updating agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}

export async function DELETE(
    req: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const auth = await verifyMcpToken(req);
    if (auth.error) {
        return NextResponse.json({ error: auth.error }, { status: auth.status });
    }

    const companyId = auth.companyToken!.companyId;
    const { id: agentId } = await params;
    const endpoint = `/api/mcp/agents/${agentId}`;
    // Deleting an agent is an owner/admin action: agent tokens never do it, not even to themselves.
    if (auth.companyToken!.agentId) {
        return NextResponse.json({ error: "Access denied: agents cannot delete agents" }, { status: 403 });
    }

    const { requestHash, cachedResponse, error, status } = await checkIdempotency(req, companyId, endpoint);
    if (error) return NextResponse.json({ error }, { status });
    if (cachedResponse) return NextResponse.json(cachedResponse);

    try {
        const [existing] = await db.select().from(agents).where(
            and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))
        ).limit(1);

        if (!existing) {
            return NextResponse.json({ error: "Agent not found or already deleted." }, { status: 404 });
        }

        const [deletedItem] = await db.update(agents).set({
            deletedAt: new Date(),
        }).where(eq(agents.id, agentId)).returning();
        await recordAudit({ companyId, actor: mcpActor(null, auth.companyToken!.id), action: "agent.deleted", target: { type: "agent", id: agentId }, before: existing });

        const res = { message: `Agent ${agentId} archived successfully`, agent: deletedItem };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
