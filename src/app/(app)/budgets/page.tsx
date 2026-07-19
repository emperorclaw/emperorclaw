import { redirect } from "next/navigation";
import { getCompanyId } from "@/lib/auth";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { PageHeader } from "@/components/page-header";
import Link from "next/link";

export const dynamic = "force-dynamic";

export default async function BudgetsPage() {
    const companyId = await getCompanyId();
    if (!companyId) redirect("/login");

    const allAgents = await db.select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        provider: agents.provider,
        status: agents.status,
        deploymentMode: agents.deploymentMode,
        monthlyBudgetCents: agents.monthlyBudgetCents,
        monthlyTokenUsage: agents.monthlyTokenUsage,
        budgetStatus: agents.budgetStatus,
    }).from(agents).where(
        and(eq(agents.companyId, companyId), isNull(agents.deletedAt))
    ).orderBy(sql`${agents.monthlyBudgetCents} DESC`);

    const totalBudget = allAgents.reduce((sum, a) => sum + (a.monthlyBudgetCents ?? 0), 0);
    const totalUsage = allAgents.reduce((sum, a) => sum + (a.monthlyTokenUsage ?? 0), 0);
    const agentsWithBudget = allAgents.filter(a => (a.monthlyBudgetCents ?? 0) > 0);

    return (
        <div className="mx-auto max-w-[1400px] space-y-6 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Finance"
                title="Budget & Usage"
                description="Monthly spend per agent. Set limits to prevent runaway costs."
            />

            {/* Summary cards */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Total Monthly Budget</div>
                    <div className="text-2xl font-bold text-zinc-100">${(totalBudget / 100).toFixed(0)}</div>
                    <div className="text-xs text-zinc-500 mt-1">{agentsWithBudget.length} agents with limits</div>
                </div>
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Estimated Spend</div>
                    <div className="text-2xl font-bold text-zinc-100">
                        ${((totalUsage / 1_000_000) * 0.5).toFixed(2)}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">~{(totalUsage / 1000).toFixed(0)}K tokens used</div>
                </div>
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Agents Over Budget</div>
                    <div className="text-2xl font-bold text-rose-400">
                        {agentsWithBudget.filter(a => a.budgetStatus === "paused").length}
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                        {agentsWithBudget.filter(a => a.budgetStatus === "warning").length} at warning level
                    </div>
                </div>
            </div>

            {/* Per-agent table */}
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
                                <th className="text-left px-5 py-3 font-medium">Provider</th>
                                <th className="text-right px-5 py-3 font-medium">Monthly Limit</th>
                                <th className="text-right px-5 py-3 font-medium">Usage (est.)</th>
                                <th className="text-right px-5 py-3 font-medium">Status</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/50">
                            {allAgents.map((agent) => {
                                const budget = agent.monthlyBudgetCents ?? 0;
                                const usage = agent.monthlyTokenUsage ?? 0;
                                const estimatedCost = budget > 0 ? (usage / 1_000_000) * 0.5 : 0;
                                const pctUsed = budget > 0 ? Math.min(100, (estimatedCost / (budget / 100)) * 100) : 0;
                                return (
                                    <tr key={agent.id} className="hover:bg-zinc-900/50 transition-colors">
                                        <td className="px-5 py-3">
                                            <Link href={`/agents/${agent.id}`} className="text-zinc-200 hover:text-cyan-300 font-medium">
                                                {agent.name}
                                            </Link>
                                            <div className="text-xs text-zinc-500">{agent.role}</div>
                                        </td>
                                        <td className="px-5 py-3 text-zinc-400">
                                            {agent.provider === "hermes" ? "👑 Hermes" :
                                             agent.provider === "openclaw" ? "🦀 OpenClaw" :
                                             agent.provider === "codex" ? "🧠 Codex" : "🔌 MCP"}
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            {budget > 0 ? (
                                                <span className="text-zinc-200 font-mono">${(budget / 100).toFixed(2)}</span>
                                            ) : (
                                                <span className="text-zinc-600">Unlimited</span>
                                            )}
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <div className="w-20 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                                                    <div className={cn(
                                                        "h-full rounded-full",
                                                        agent.budgetStatus === "paused" ? "bg-rose-500" :
                                                        agent.budgetStatus === "warning" ? "bg-amber-500" : "bg-emerald-500"
                                                    )} style={{ width: `${pctUsed}%` }} />
                                                </div>
                                                <span className="text-zinc-400 font-mono text-xs">
                                                    ${estimatedCost.toFixed(2)}
                                                </span>
                                            </div>
                                        </td>
                                        <td className="px-5 py-3 text-right">
                                            {budget <= 0 ? (
                                                <span className="text-zinc-500 text-xs">—</span>
                                            ) : agent.budgetStatus === "paused" ? (
                                                <span className="text-rose-400 text-xs font-medium bg-rose-500/10 px-2 py-0.5 rounded">⏸ Paused</span>
                                            ) : agent.budgetStatus === "warning" ? (
                                                <span className="text-amber-400 text-xs font-medium bg-amber-500/10 px-2 py-0.5 rounded">⚠ Warning</span>
                                            ) : (
                                                <span className="text-emerald-400 text-xs font-medium bg-emerald-500/10 px-2 py-0.5 rounded">Active</span>
                                            )}
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
                {allAgents.length === 0 && (
                    <div className="p-8 text-center text-sm text-zinc-500">No agents found.</div>
                )}
            </div>
        </div>
    );
}

function cn(...classes: (string | boolean | undefined | null)[]) {
    return classes.filter(Boolean).join(" ");
}
