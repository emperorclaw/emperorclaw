import { NextRequest, NextResponse } from "next/server";
import { verifyMcpToken } from "@/lib/mcp";
import { db } from "@/db";
import { agents, tokenUsageLog } from "@/db/schema";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { lockAgentBudget, lookupUsagePricing } from "@/lib/agent-budget";
import { splitLegacyTokens, priceUsageCents, nextBudgetStatus, type BudgetStatus } from "@/lib/billing";

const reportSchema = z.object({
    agentId: z.string().min(1),
    tokensUsed: z.number().int().min(0).optional(),       // legacy
    model: z.string().optional(),                           // which model
    inputTokens: z.number().int().min(0).optional(),        // input token count
    outputTokens: z.number().int().min(0).optional(),       // output token count
});

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

        return await db.transaction(async (tx) => {
            const agent = await lockAgentBudget(tx, companyId, agentId);
            if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
            const hasSplit = inputTokens !== undefined || outputTokens !== undefined;
            const split = hasSplit ? { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 }
                : splitLegacyTokens(tokensUsed ?? 0);
            const totalTokens = split.inputTokens + split.outputTokens;
            // Price the reported runtime model without overwriting admin configuration.
            const pricingLookupModel = model || agent.llmModel || "";
            const pricing = totalTokens > 0 ? await lookupUsagePricing(tx, pricingLookupModel) : null;
            if (totalTokens > 0 && !pricing) {
                // Keep the sample unacknowledged so bridges retain it and stop dispatching.
                return NextResponse.json({ error: "Active pricing required for reported model", model: pricingLookupModel }, { status: 422 });
            }
            const costCents = pricing ? priceUsageCents({
                ...split, inputCentsPer1M: pricing.inputPricePer1k,
                outputCentsPer1M: pricing.outputPricePer1k,
            }) : 0;
            const monthlyTokenUsage = agent.monthlyTokenUsage + totalTokens;
            const monthlyCostCents = agent.monthlyCostCents + costCents;
            const budgetStatus = nextBudgetStatus({
                spentCents: monthlyCostCents, budgetCents: agent.monthlyBudgetCents,
                current: agent.budgetStatus as BudgetStatus,
            });
            await tx.update(agents).set({ monthlyTokenUsage, monthlyCostCents, budgetStatus })
                .where(eq(agents.id, agentId));
            if (totalTokens > 0) {
                await tx.insert(tokenUsageLog).values({ companyId, agentId, model: pricingLookupModel,
                    ...split, costCents });
            }
            return NextResponse.json({ ok: true, agentId, monthlyTokenUsage, monthlyCostCents,
                budgetStatus, model: pricingLookupModel, costCents });
        });
    } catch (error) {
        console.error("report-usage error:", error);
        return NextResponse.json({ error: "Internal error" }, { status: 500 });
    }
}
