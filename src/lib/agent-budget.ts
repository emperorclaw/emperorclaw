import { and, eq, isNull } from "drizzle-orm";
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
    const [pricing] = await tx.select().from(llmPricing)
        .where(and(eq(llmPricing.model, model), eq(llmPricing.active, true))).limit(1);
    return pricing ?? null;
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
