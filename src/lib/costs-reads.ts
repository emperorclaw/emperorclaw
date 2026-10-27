import { and, eq, gte, inArray, lt, sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agentRuns, agents, customers, llmPricing, projects, tasks } from "@/db/schema";
import { getScopedAgentIds, getScopedCustomerIds, type MemberScope } from "@/lib/member-scope";
import { projectTitle } from "@/lib/project-title";
import {
    aggregateCosts,
    dailySeries,
    filterFacts,
    groupIdentity,
    OTHER_AGENTS_KEY,
    type CostBreakdown,
    type CostDimension,
    type CostFact,
    type CostFilter,
    type CostHint,
    type CostPrice,
    type CostRange,
} from "@/lib/costs";

/** Who is reading: the company and the restricted member's scope (null = everything). */
export type CostViewer = { companyId: string; scope: MemberScope | null };

/**
 * Which runs a viewer may count. Owners/admins: every run of the company.
 * A restricted member: runs on tasks of their in-scope clients, plus the
 * no-task (chat) runs of their in-scope agents. A run whose task is gone
 * cannot be proven in scope, so it is left out for them.
 */
function scopeCondition(scope: MemberScope | null): SQL | undefined {
    if (!scope) return undefined;
    const customerIds = getScopedCustomerIds(scope) ?? [];
    const agentIds = getScopedAgentIds(scope) ?? [];
    const onTask = customerIds.length ? sql`(${agentRuns.taskId} is not null and ${inArray(customers.id, customerIds)})` : sql`false`;
    const inChat = agentIds.length ? sql`(${agentRuns.taskId} is null and ${inArray(agentRuns.agentId, agentIds)})` : sql`false`;
    return sql`(${onTask} or ${inChat})`;
}

/**
 * agent_runs started in [from, to), rolled up per (UTC day, agent, task,
 * model, provider, cost hint). Joins are company-bound so a task id can never
 * pull in another company's names. Private chats contribute only numbers: no
 * thread id or message is ever selected.
 */
export async function loadCostFacts(viewer: CostViewer, range: Pick<CostRange, "from" | "to">): Promise<CostFact[]> {
    const tokens = sql`coalesce(${agentRuns.inputTokens}, 0) + coalesce(${agentRuns.outputTokens}, 0)`;
    const rows = await db
        .select({
            day: sql<string>`to_char(date_trunc('day', ${agentRuns.startedAt}), 'YYYY-MM-DD')`,
            agentId: agentRuns.agentId,
            taskId: agentRuns.taskId,
            model: agentRuns.model,
            provider: agentRuns.provider,
            hint: sql<CostHint>`case when ${agentRuns.costCents} is null then 'none' when ${agentRuns.costCents} = 0 and ${tokens} > 0 then 'zero' else 'reported' end`,
            agentName: sql<string | null>`min(${agents.name})`,
            taskFound: sql<boolean>`bool_or(${tasks.id} is not null)`,
            taskTitle: sql<string | null>`min(coalesce(nullif(trim(${tasks.inputJson}->>'title'), ''), ${tasks.taskType}))`,
            projectId: sql<string | null>`min(${projects.id}::text)`,
            projectGoal: sql<string | null>`min(${projects.goal})`,
            customerId: sql<string | null>`min(${customers.id}::text)`,
            customerName: sql<string | null>`min(${customers.name})`,
            runs: sql<number>`count(*)::float8`,
            inputTokens: sql<number>`coalesce(sum(${agentRuns.inputTokens}), 0)::float8`,
            outputTokens: sql<number>`coalesce(sum(${agentRuns.outputTokens}), 0)::float8`,
            cacheReadTokens: sql<number>`coalesce(sum(${agentRuns.cacheReadTokens}), 0)::float8`,
            reasoningTokens: sql<number>`coalesce(sum(${agentRuns.reasoningTokens}), 0)::float8`,
            reportedCents: sql<number>`coalesce(sum(${agentRuns.costCents}), 0)::float8`,
        })
        .from(agentRuns)
        .leftJoin(agents, and(eq(agents.id, agentRuns.agentId), eq(agents.companyId, agentRuns.companyId)))
        .leftJoin(tasks, and(eq(tasks.id, agentRuns.taskId), eq(tasks.companyId, agentRuns.companyId)))
        .leftJoin(projects, and(eq(projects.id, tasks.projectId), eq(projects.companyId, agentRuns.companyId)))
        .leftJoin(customers, and(eq(customers.id, projects.customerId), eq(customers.companyId, agentRuns.companyId)))
        .where(and(
            eq(agentRuns.companyId, viewer.companyId),
            gte(agentRuns.startedAt, range.from),
            lt(agentRuns.startedAt, range.to),
            scopeCondition(viewer.scope),
        ))
        .groupBy(sql`1`, sql`2`, sql`3`, sql`4`, sql`5`, sql`6`);

    const allowedAgents = viewer.scope ? new Set(getScopedAgentIds(viewer.scope) ?? []) : null;
    return rows.map((row) => {
        // A restricted member sees in-scope work done by agents outside their
        // scope as one "Other agents" row, never those agents' names.
        const hidden = allowedAgents !== null && Boolean(row.agentId) && !allowedAgents.has(row.agentId!);
        const taskFound = Boolean(row.taskFound);
        return {
            day: row.day,
            agentId: hidden ? OTHER_AGENTS_KEY : row.agentId,
            agentName: hidden ? null : row.agentName,
            taskId: row.taskId,
            taskFound,
            taskTitle: taskFound ? row.taskTitle : null,
            projectId: row.projectId,
            projectName: row.projectGoal ? projectTitle({ goal: row.projectGoal }).name : null,
            customerId: row.customerId,
            customerName: row.customerName,
            model: row.model,
            provider: row.provider,
            hint: row.hint,
            runs: Number(row.runs),
            inputTokens: Number(row.inputTokens),
            outputTokens: Number(row.outputTokens),
            cacheReadTokens: Number(row.cacheReadTokens),
            reasoningTokens: Number(row.reasoningTokens),
            reportedCents: Number(row.reportedCents),
        };
    });
}

/** Active llm_pricing rows (the table is instance-wide). */
export async function loadCostPrices(): Promise<CostPrice[]> {
    const rows = await db.select({
        provider: llmPricing.provider, model: llmPricing.model,
        inputCentsPer1M: llmPricing.inputPricePer1k, outputCentsPer1M: llmPricing.outputPricePer1k,
    }).from(llmPricing).where(eq(llmPricing.active, true));
    return rows;
}

export type CostsView = CostBreakdown & {
    dimension: CostDimension;
    series: { day: string; costCents: number; runs: number }[];
    /** Labels of the active drill-down filters (falls back to "Selected …" when nothing matched). */
    filterLabels: Partial<Record<keyof CostFilter, string>>;
};

/** Everything the Costs page and its CSV need for one dimension, range and drill-down. */
export async function loadCostsView(viewer: CostViewer, dimension: CostDimension, range: CostRange, filter: CostFilter): Promise<CostsView> {
    const [facts, prices] = await Promise.all([loadCostFacts(viewer, range), loadCostPrices()]);
    const visible = filterFacts(facts, filter);
    const breakdown = aggregateCosts(visible, prices, dimension);
    const filterLabels: CostsView["filterLabels"] = {};
    const dims: Record<keyof CostFilter, CostDimension> = { customer: "customer", project: "project", model: "model", agent: "agent" };
    for (const key of Object.keys(dims) as (keyof CostFilter)[]) {
        if (filter[key] === undefined) continue;
        const match = visible.find((fact) => groupIdentity(fact, dims[key]).key === filter[key]);
        filterLabels[key] = match ? groupIdentity(match, dims[key]).label : `Selected ${key === "customer" ? "client" : key}`;
    }
    return { ...breakdown, dimension, series: dailySeries(visible, prices, range), filterLabels };
}
