import { redirect } from "next/navigation";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, llmPricing, tokenUsageLog } from "@/db/schema";
import { requireCompanyAccess } from "@/lib/company-access";
import { getPlatformAdminSession } from "@/lib/platform-admin";
import { canWrite } from "@/lib/role-matrix";
import { getScopedAgentIds, type MemberScope } from "@/lib/member-scope";
import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { BudgetClient } from "@/components/budget-client";
import { costsSearch, drillDown, isoDay, parseCostsQuery, DAY_MS } from "@/lib/costs";
import { loadCostsView } from "@/lib/costs-reads";
import { CostsClient, CostsTabs } from "./costs-client";

export const dynamic = "force-dynamic";

/**
 * Costs (roadmap 11.2): spend by client, project, model and agent for a date
 * range, plus the agent budget controls that used to be the whole /budgets
 * page. Readable by every member (as /budgets was); a restricted member only
 * sees their in-scope clients, projects and agents.
 */
export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const access = await requireCompanyAccess("viewer").catch(() => null);
    if (!access) redirect("/login");
    const query = parseCostsQuery(await searchParams, new Date());
    const rangeView = { preset: query.range.preset, from: isoDay(query.range.from), to: isoDay(new Date(query.range.to.getTime() - DAY_MS)), days: query.range.days };

    let body: React.ReactNode;
    if (query.tab === "budgets" || !query.dimension) {
        const data = await loadBudgets(access.companyId, access.scope);
        // Model pricing is instance-wide: only platform admins edit it (POST /api/ui/pricing).
        const canEditPricing = (await getPlatformAdminSession())?.isPlatformAdmin === true;
        body = (
            <BudgetClient initialAgents={data.agents} initialPricing={data.pricing} initialWeeklyCost={data.weeklyCost}
                canEdit={canWrite(access.role)} canEditPricing={canEditPricing} />
        );
    } else {
        const view = await loadCostsView({ companyId: access.companyId, scope: access.scope }, query.dimension, query.range, query.filter);
        const dimension = query.dimension;
        body = (
            <CostsClient
                tab={query.tab}
                dimension={dimension}
                range={rangeView}
                filter={query.filter}
                filterLabels={view.filterLabels}
                total={view.total}
                series={view.series}
                groups={view.groups.map((group) => ({ ...group, href: drillDown(group, dimension, query.range) }))}
                exportHref={`/api/costs/export?${costsSearch({ tab: query.tab, range: query.range, filter: query.filter })}`}
                clearFilterHref={`/costs?${costsSearch({ tab: query.tab, range: query.range })}`}
                restricted={Boolean(access.scope)}
            />
        );
    }

    const t = await getTranslations("costs");
    return (
        <div className="mx-auto max-w-[1400px] space-y-6 animate-in fade-in duration-500">
            <PageHeader eyebrow={t("eyebrow")} title={t("title")}
                description={query.tab === "budgets" ? t("budgetsDescription") : t("description")} />
            <CostsTabs active={query.tab} range={rangeView} />
            {body}
        </div>
    );
}

/** The agent budget table (the former /budgets page), limited to a restricted member's agents. */
async function loadBudgets(companyId: string, scope: MemberScope | null) {
    const scopedAgentIds = getScopedAgentIds(scope);
    const agentRows = scopedAgentIds && scopedAgentIds.length === 0 ? [] : await db.select({
        id: agents.id, name: agents.name, role: agents.role,
        llmProvider: agents.llmProvider, llmModel: agents.llmModel,
        status: agents.status,
        monthlyBudgetCents: agents.monthlyBudgetCents,
        monthlyTokenUsage: agents.monthlyTokenUsage,
        monthlyCostCents: agents.monthlyCostCents,
        budgetStatus: agents.budgetStatus,
    }).from(agents).where(and(
        eq(agents.companyId, companyId), isNull(agents.deletedAt),
        scopedAgentIds ? inArray(agents.id, scopedAgentIds) : undefined,
    )).orderBy(sql`${agents.monthlyCostCents} DESC`);

    // Include disabled rows so an agent's existing selection remains visible
    // and can be identified as unavailable instead of appearing unset.
    const pricing = await db.select().from(llmPricing)
        .orderBy(llmPricing.provider, llmPricing.model);

    // 7-day spend (of the agents shown).
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS).toISOString();
    const [weekly] = scopedAgentIds && scopedAgentIds.length === 0 ? [{ total: 0 }] : await db.select({ total: sql<number>`COALESCE(SUM(${tokenUsageLog.costCents}), 0)`.mapWith(Number) })
        .from(tokenUsageLog).where(and(
            eq(tokenUsageLog.companyId, companyId), sql`${tokenUsageLog.reportedAt} >= ${sevenDaysAgo}`,
            scopedAgentIds ? inArray(tokenUsageLog.agentId, scopedAgentIds) : undefined,
        ));

    return { agents: agentRows, pricing, weeklyCost: weekly?.total ?? 0 };
}
