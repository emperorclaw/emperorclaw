import { redirect } from "next/navigation";
import { getCompanyId } from "@/lib/auth";
import { db } from "@/db";
import { agents, tokenUsageLog, llmPricing } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import Link from "next/link";

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

    const totalBudgetCents = allAgents.reduce((s, a) => s + (a.monthlyBudgetCents ?? 0), 0);
    const totalCostCents = allAgents.reduce((s, a) => s + (a.monthlyCostCents ?? 0), 0);
    const totalTokens = allAgents.reduce((s, a) => s + (a.monthlyTokenUsage ?? 0), 0);
    const agentsWithBudget = allAgents.filter(a => (a.monthlyBudgetCents ?? 0) > 0);

    // 7-day spend
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const recentUsage = await db.select({
        total: sql<number>`COALESCE(SUM(${tokenUsageLog.costCents}), 0)`.mapWith(Number),
    }).from(tokenUsageLog).where(and(
        eq(tokenUsageLog.companyId, companyId),
        sql`${tokenUsageLog.reportedAt} >= ${sevenDaysAgo}`
    ));
    const weeklyCostCents = recentUsage[0]?.total ?? 0;

    return (
        <div className="mx-auto max-w-[1400px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Finance"
                title="Budget & Usage"
                description="Real-time cost tracking with per-model pricing. Budgets auto-enforce: warning at 80%, pause at 100%."
            />

            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Monthly Spend</div>
                    <div className="text-2xl font-bold text-zinc-100">${(totalCostCents / 100).toFixed(2)}</div>
                    <div className="text-xs text-zinc-500 mt-1">{(totalTokens / 1000).toFixed(0)}K tokens</div>
                </div>
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Monthly Budget</div>
                    <div className="text-2xl font-bold text-zinc-100">
                        {totalBudgetCents > 0 ? `$${(totalBudgetCents / 100).toFixed(0)}` : "Unlimited"}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">{agentsWithBudget.length} agents capped</div>
                </div>
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">7-Day Spend</div>
                    <div className="text-2xl font-bold text-zinc-100">${(weeklyCostCents / 100).toFixed(2)}</div>
                    <div className="text-xs text-zinc-500 mt-1">last 7 days</div>
                </div>
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Status</div>
                    <div className="text-2xl font-bold text-rose-400">
                        {allAgents.filter(a => a.budgetStatus === "paused").length} paused
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                        {allAgents.filter(a => a.budgetStatus === "warning").length} at warning
                    </div>
                </div>
            </div>

            {/* Agent table */}
            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-zinc-200">Agent Budgets</h2>
                    <span className="text-xs text-zinc-500">{allAgents.length} agents</span>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wider">
                                <th className="text-left px-5 py-3 font-medium">Agent</th>
                                <th className="text-left px-5 py-3 font-medium">Model</th>
                                <th className="text-right px-5 py-3 font-medium">Tokens</th>
                                <th className="text-right px-5 py-3 font-medium">Cost</th>
                                <th className="text-right px-5 py-3 font-medium">Limit</th>
                                <th className="text-right px-5 py-3 font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50">
                            {allAgents.map((agent) => {
                                const budget = agent.monthlyBudgetCents ?? 0;
                                const cost = agent.monthlyCostCents ?? 0;
                                const tokens = agent.monthlyTokenUsage ?? 0;
                                const pct = budget > 0 ? Math.min(100, (cost / budget) * 100) : 0;
                                const model = agent.llmModel || agent.llmProvider || "—";
                                return (
                                    <tr key={agent.id} className="hover:bg-zinc-900/50 transition-colors">
                                        <td className="px-5 py-3">
                                            <Link href={`/agents/${agent.id}`} className="text-zinc-200 hover:text-cyan-300 font-medium">{agent.name}</Link>
                                            <div className="text-xs text-zinc-500">{agent.role}</div>
                                        </td>
                                        <td className="px-5 py-3 text-zinc-400 text-xs font-mono">{model}</td>
                                        <td className="px-5 py-3 text-right font-mono text-xs text-zinc-400">
                                            {tokens > 0 ? `${(tokens / 1000).toFixed(1)}K` : "—"}
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                {budget > 0 && (
                                                    <div className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                                                        <div className={cn(
                                                            "h-full rounded-full",
                                                            agent.budgetStatus === "paused" ? "bg-rose-500" :
                                                            agent.budgetStatus === "warning" ? "bg-amber-500" : "bg-emerald-500"
                                                        )} style={{ width: `${pct}%` }} />
                                                    </div>
                                                )}
                                                <span className="text-zinc-200 font-mono text-xs">${(cost / 100).toFixed(4)}</span>
                                            </div>
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            {budget > 0 ? (
                                                <span className="text-zinc-300 font-mono text-xs">${(budget / 100).toFixed(2)}</span>
                                            ) : <span className="text-zinc-600 text-xs">∞</span>}
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            {budget <= 0 ? <span className="text-zinc-500 text-xs">—</span> :
                                             agent.budgetStatus === "paused" ? <span className="text-rose-400 text-xs font-medium bg-rose-500/10 px-2 py-0.5 rounded">Paused</span> :
                                             agent.budgetStatus === "warning" ? <span className="text-amber-400 text-xs font-medium bg-amber-500/10 px-2 py-0.5 rounded">⚠ {Math.round(pct)}%</span> :
                                             <span className="text-emerald-400 text-xs font-medium bg-emerald-500/10 px-2 py-0.5 rounded">{Math.round(pct)}%</span>}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                {allAgents.length === 0 && <div className="p-8 text-center text-sm text-zinc-500">No agents found.</div>}
            </div>

            {/* Pricing reference */}
            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80">
                    <h2 className="text-sm font-semibold text-zinc-200">Model Pricing Reference</h2>
                    <p className="text-xs text-zinc-500 mt-0.5">Prices per 1M tokens. Used for real-time cost calculation.</p>
                </div>
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wider">
                                <th className="text-left px-5 py-2 font-medium">Provider</th>
                                <th className="text-left px-5 py-2 font-medium">Model</th>
                                <th className="text-right px-5 py-2 font-medium">Input /1M</th>
                                <th className="text-right px-5 py-2 font-medium">Output /1M</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50">
                            {pricing.map((p) => (
                                <tr key={p.id} className="text-xs">
                                    <td className="px-5 py-1.5 text-zinc-400 capitalize">{p.provider}</td>
                                    <td className="px-5 py-1.5 text-zinc-300 font-mono">{p.model}</td>
                                    <td className="px-5 py-1.5 text-right text-zinc-400 font-mono">${(p.inputPricePer1k / 100000).toFixed(2)}</td>
                                    <td className="px-5 py-1.5 text-right text-zinc-400 font-mono">${(p.outputPricePer1k / 100000).toFixed(2)}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

function cn(...classes: (string | boolean | undefined | null)[]) {
    return classes.filter(Boolean).join(" ");
}
