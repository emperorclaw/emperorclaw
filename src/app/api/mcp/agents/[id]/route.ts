import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { verifyMcpToken, checkIdempotency, saveIdempotencyResponse } from "@/lib/mcp";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq, and, isNull } from "drizzle-orm";
import { parseJsonBody, optionalString } from "@/lib/validation";
import { updateAgentForCompany } from "@/lib/agents-crud";

const updateAgentSchema = z.object({
    name: z.string().min(1).optional(),
    role: optionalString.optional(),
    avatarUrl: optionalString.optional(),
    skillsJson: z.array(z.unknown()).optional(),
    memory: optionalString.optional(),
    modelPolicyJson: z.record(z.string(), z.unknown()).optional(),
    concurrencyLimit: z.number().int().min(0).optional(),
}).loose();

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
        const { name, role, skillsJson, memory, modelPolicyJson, concurrencyLimit, avatarUrl } = body as {
            name?: string; role?: string; skillsJson?: unknown[]; memory?: string;
            modelPolicyJson?: Record<string, unknown>; concurrencyLimit?: number; avatarUrl?: string;
        };

        // Ensure we actually have something to update
        const hasBudget = typeof body.monthlyBudgetCents === "number" || typeof body.monthlyCostCents === "number" || typeof body.monthlyTokenUsage === "number" || (typeof body.budgetStatus === "string" && ["active","warning","paused"].includes(body.budgetStatus));
        const hasLLM = typeof body.llmProvider === "string" || typeof body.llmModel === "string";
        if (name === undefined && role === undefined && skillsJson === undefined && memory === undefined && modelPolicyJson === undefined && concurrencyLimit === undefined && avatarUrl === undefined && !hasBudget && !hasLLM) {
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
            monthlyBudgetCents: typeof body.monthlyBudgetCents === "number" ? body.monthlyBudgetCents : undefined,
            monthlyCostCents: typeof body.monthlyCostCents === "number" ? body.monthlyCostCents : undefined,
            monthlyTokenUsage: typeof body.monthlyTokenUsage === "number" ? body.monthlyTokenUsage : undefined,
            budgetStatus: typeof body.budgetStatus === "string" ? body.budgetStatus as "active" | "warning" | "paused" : undefined,
            llmProvider: typeof body.llmProvider === "string" ? body.llmProvider : undefined,
            llmModel: typeof body.llmModel === "string" ? body.llmModel : undefined,
        });

        const res = { message: `Agent ${agentId} updated successfully`, agent: updatedAgent };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
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

        const res = { message: `Agent ${agentId} archived successfully`, agent: deletedItem };
        await saveIdempotencyResponse(companyId, endpoint, requestHash!, res);
        return NextResponse.json(res, { status: 200 });

    } catch (err) {
        console.error(`Error deleting agent ${agentId}:`, err);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
