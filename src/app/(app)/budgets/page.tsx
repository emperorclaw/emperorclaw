import { redirect } from "next/navigation";
import { getCompanyId } from "@/lib/auth";
import { db } from "@/db";
import { agents, llmPricing, tokenUsageLog } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import { BudgetClient } from "@/components/budget-client";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allAgents = await db.select({
        id: agents.id, name: agents.name, role: agents.role,
        llmProvider: agents.llmProvider, llmModel: agents.llmModel,
        status: agents.status,
        monthlyBudgetCents: agents.monthlyBudgetCents,
        monthlyTokenUsage: agents.monthlyTokenUsage,
        monthlyCostCents: agents.monthlyCostCents,
        budgetStatus: agents.budgetStatus,
    }).from(agents).where(
        and(eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).orderBy(sql`${agents.monthlyCostCents} DESC`);

    const pricing = await db.select().from(llmPricing).where(eq(llmPricing.active, true))
        .orderBy(llmPricing.provider, llmPricing.model);

    // 7-day spend
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const [weekly] = await db.select({ total: sql<number>`COALESCE(SUM(${tokenUsageLog.costCents}), 0)`.mapWith(Number) })
        .from(tokenUsageLog).where(and(eq(tokenUsageLog.companyId, companyId), sql`${tokenUsageLog.reportedAt} >= ${sevenDaysAgo}`));

    return (
        <div className="mx-auto max-w-[1400px] space-y-6 animate-in fade-in duration-500">
            <PageHeader eyebrow="Finance" title="Budget & Usage"
                description="Click limit or model to edit inline. Toggle ✓ to disable models. Budgets auto-enforce: 80% warning, 100% pause." />
            <BudgetClient initialAgents={allAgents} initialPricing={pricing} initialWeeklyCost={weekly?.total ?? 0} />
        </div>
    );
}
