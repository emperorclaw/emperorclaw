import { and, eq, isNull, inArray } from "drizzle-orm";
import { pricingModelRefs } from "@/lib/pricing-model-refs";
import { db } from "@/db";
import { agents, llmPricing } from "@/db/schema";
import { nextBudgetStatus, type BudgetStatus } from "@/lib/billing";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Serialize month rollover, spend increments and status changes per agent. */
export async function lockAgentBudget(tx: Transaction, companyId: string, agentId: string) {
    const [agent] = await tx.select().from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId), isNull(agents.deletedAt)))
        .for("update").limit(1);
    if (!agent) return null;
    const month = new Date().toISOString().slice(0, 7);
    if (agent.lastResetMonth !== month) {
        const reset = agent.lastResetMonth ? {
            monthlyTokenUsage: 0, monthlyCostCents: 0, budgetStatus: "active",
        } : {};
        // Individual usage rows already preserve the previous month's history.
        await tx.update(agents).set({ ...reset, lastResetMonth: month }).where(eq(agents.id, agentId));
        Object.assign(agent, reset, { lastResetMonth: month });
    }
    return agent;
}

/** Never substitute the cheapest provider model for an unknown model. */
export async function lookupUsagePricing(tx: Transaction, model: string) {
    const refs = pricingModelRefs(model);
    if (!refs.length) return null;
    const rows = await tx.select().from(llmPricing)
        .where(and(inArray(llmPricing.model, refs), eq(llmPricing.active, true)));
    for (const ref of refs) {
        const matches = rows.filter((row) => row.model === ref);
        if (!matches.length) continue;
        // Conflicting tariffs for an ambiguous model must remain unpriced.
        if (matches.some((row) => row.inputPricePer1k !== matches[0].inputPricePer1k || row.outputPricePer1k !== matches[0].outputPricePer1k)) return null;
        return matches[0];
    }
    return null;
}

export async function readAgentBudget(companyId: string, agentId: string) {
    return db.transaction(async (tx) => {
        const agent = await lockAgentBudget(tx, companyId, agentId);
        if (!agent) return null;
        const pricing = agent.llmModel ? await lookupUsagePricing(tx, agent.llmModel) : null;
        const budgetStatus = nextBudgetStatus({
            spentCents: agent.monthlyCostCents,
            budgetCents: agent.monthlyBudgetCents,
            current: agent.budgetStatus as BudgetStatus,
        });
        if (budgetStatus !== agent.budgetStatus) {
            await tx.update(agents).set({ budgetStatus }).where(eq(agents.id, agentId));
        }
        // Return only the fields needed by runtime guards, never credentials.
        return {
            id: agent.id, monthlyBudgetCents: agent.monthlyBudgetCents,
            monthlyCostCents: agent.monthlyCostCents, monthlyTokenUsage: agent.monthlyTokenUsage,
            lastResetMonth: agent.lastResetMonth, budgetStatus,
            executionAllowed: budgetStatus !== "paused" && (agent.monthlyBudgetCents <= 0 || Boolean(pricing)),
            budgetBlockReason: budgetStatus === "paused" ? "Budget exhausted" :
                agent.monthlyBudgetCents > 0 && !pricing ? "Active model pricing required for capped agents" : null,
        };
    });
}
