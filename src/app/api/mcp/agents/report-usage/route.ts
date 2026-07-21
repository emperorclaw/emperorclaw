import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { agents, tokenUsageLog, llmPricing } from "@/db/schema";
import { and, eq, isNull, sql, desc } from "drizzle-orm";
import { z } from "zod";

const reportSchema = z.object({
    agentId: z.string().min(1),
    tokensUsed: z.number().int().min(0).optional(),       // legacy
    model: z.string().optional(),                           // which model
    inputTokens: z.number().int().min(0).optional(),        // input token count
    outputTokens: z.number().int().min(0).optional(),       // output token count
});

type PricingRow = {
    provider: string; model: string;
    inputPricePer1k: number; outputPricePer1k: number;
};

/**
 * POST /api/mcp/agents/report-usage
 *
 * Model-aware cost tracking:
 * - Legacy: { agentId, tokensUsed } → splits 80/20, uses agent's configured model
 * - Full: { agentId, model, inputTokens, outputTokens } → exact pricing
 *
 * Calculates cost from llm_pricing, logs to token_usage_log,
 * and enforces budget limits (warning at 80%, paused at 100%).
 */
export async function POST(req: NextRequest) {
    const auth = await verifyMcpToken(req);
    if (auth.error) return NextResponse.json({ error: auth.error }, { status: auth.status });
    const companyId = auth.companyToken!.companyId;

    try {
        const body = await req.json();
        const parsed = reportSchema.safeParse(body);
        if (!parsed.success) return NextResponse.json({ error: "agentId and token count required" }, { status: 400 });

        const { agentId, tokensUsed, model, inputTokens, outputTokens } = parsed.data;

        // Monthly reset: if month changed, archive & reset counters
        const currentMonth = new Date().toISOString().slice(0, 7); // "2026-07"
        const [agent] = await db.select({ lastResetMonth: agents.lastResetMonth, monthlyTokenUsage: agents.monthlyTokenUsage, monthlyCostCents: agents.monthlyCostCents })
            .from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);

        if (agent && agent.lastResetMonth && agent.lastResetMonth !== currentMonth) {
            // Archive previous month in token_usage_log as a summary row
            await db.insert(tokenUsageLog).values({
                companyId, agentId,
                model: "monthly-reset",
                inputTokens: agent.monthlyTokenUsage ?? 0,
                outputTokens: 0,
                costCents: agent.monthlyCostCents ?? 0,
                reportedAt: new Date(`${agent.lastResetMonth}-01T00:00:00Z`),
            });
            // Reset counters
            await db.update(agents).set({
                monthlyTokenUsage: 0,
                monthlyCostCents: 0,
                lastResetMonth: currentMonth,
                budgetStatus: "active", // Reset budget status for new month
            }).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
        } else if (agent && !agent.lastResetMonth) {
            // First time: set the month marker without resetting
            await db.update(agents).set({ lastResetMonth: currentMonth })
                .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
        }

        const totalTokens = (inputTokens ?? 0) + (outputTokens ?? 0) || tokensUsed || 0;
        if (totalTokens <= 0) return NextResponse.json({ ok: true, agentId, monthlyTokenUsage: 0 });

        // Resolve model
        let resolvedModel = model || null;
        if (!resolvedModel) {
            const [a] = await db.select({ m: agents.llmModel, p: agents.llmProvider })
                .from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt))).limit(1);
            resolvedModel = a?.m || a?.p || "deepseek-chat";
        }

        const inputT = inputTokens ?? Math.round(totalTokens * 0.8);
        const outputT = outputTokens ?? Math.round(totalTokens * 0.2);

        // Cost: (inputT * pricePer1k + outputT * pricePer1k) / 100000
        // pricePer1k is in cents × 100 (micro-cents). Result is in cents.
        const pricing = await lookupPricing(resolvedModel);
        const costCents = pricing
            ? Math.round((inputT * pricing.inputPricePer1k + outputT * pricing.outputPricePer1k) / 100000)
            : 0;

        const [updated] = await db.update(agents).set({
            monthlyTokenUsage: sql`COALESCE(monthly_token_usage, 0) + ${totalTokens}`,
            monthlyCostCents: sql`COALESCE(monthly_cost_cents, 0) + ${costCents}`,
            llmModel: resolvedModel,
        }).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt)))
            .returning({ id: agents.id, monthlyTokenUsage: agents.monthlyTokenUsage, monthlyCostCents: agents.monthlyCostCents, monthlyBudgetCents: agents.monthlyBudgetCents, budgetStatus: agents.budgetStatus });

        if (!updated) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

        // Log
        await db.insert(tokenUsageLog).values({ companyId, agentId, model: resolvedModel, inputTokens: inputT, outputTokens: outputT, costCents });

        // Budget enforcement
        let bs = updated.budgetStatus;
        const budget = updated.monthlyBudgetCents ?? 0;
        const spent = updated.monthlyCostCents ?? 0;
        if (budget > 0) {
            const pct = spent / budget;
            if (pct >= 1.0 && bs !== "paused") bs = "paused";
            else if (pct >= 0.8 && bs === "active") bs = "warning";
            if (bs !== updated.budgetStatus) {
                await db.update(agents).set({ budgetStatus: bs }).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
            }
        }

        return NextResponse.json({ ok: true, agentId: updated.id, monthlyTokenUsage: updated.monthlyTokenUsage, monthlyCostCents: updated.monthlyCostCents, budgetStatus: bs, model: resolvedModel, costCents });
    } catch (error) {
        console.error("report-usage error:", error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}

async function lookupPricing(model: string): Promise<PricingRow | null> {
    const [exact] = await db.select({ provider: llmPricing.provider, model: llmPricing.model, inputPricePer1k: llmPricing.inputPricePer1k, outputPricePer1k: llmPricing.outputPricePer1k })
        .from(llmPricing).where(and(eq(llmPricing.model, model), eq(llmPricing.active, true))).limit(1);
    if (exact) return exact;
    const [byProv] = await db.select({ provider: llmPricing.provider, model: llmPricing.model, inputPricePer1k: llmPricing.inputPricePer1k, outputPricePer1k: llmPricing.outputPricePer1k })
        .from(llmPricing).where(and(eq(llmPricing.provider, model), eq(llmPricing.active, true))).orderBy(desc(llmPricing.createdAt)).limit(1);
    return byProv ?? null;
}
