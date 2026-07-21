"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { BudgetInlineEdit, ModelInlineSelect, PricingInlineEdit } from "@/components/budget-inline-edit";
import { cn } from "@/lib/utils";

type AgentRow = {
    id: string; name: string; role: string | null;
    llmProvider: string | null; llmModel: string | null;
    status: string | null;
    monthlyBudgetCents: number | null;
    monthlyTokenUsage: number | null;
    monthlyCostCents: number | null;
    budgetStatus: string | null;
};

type PricingRow = {
    id: string; provider: string; model: string; label: string;
    inputPricePer1k: number; outputPricePer1k: number; active: boolean;
};

export function BudgetClient({ initialAgents, initialPricing }: {
    initialAgents: AgentRow[];
    initialPricing: PricingRow[];
}) {
    const [agents, setAgents] = useState(initialAgents);
    const [pricing, setPricing] = useState(initialPricing);
    const [refreshKey, setRefreshKey] = useState(0);

    const refresh = () => setRefreshKey(k => k + 1);

    useEffect(() => {
        fetch("/api/mcp/pricing").then(r => r.json()).then(d => {
            if (d.pricing) setPricing(d.pricing);
        }).catch(() => {});
    }, [refreshKey]);

    const totalBudgetCents = agents.reduce((s, a) => s + (a.monthlyBudgetCents ?? 0), 0);
    const totalCostCents = agents.reduce((s, a) => s + (a.monthlyCostCents ?? 0), 0);
    const totalTokens = agents.reduce((s, a) => s + (a.monthlyTokenUsage ?? 0), 0);
    const agentsWithBudget = agents.filter(a => (a.monthlyBudgetCents ?? 0) > 0);

    return (
        <>
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
                    <div className="text-2xl font-bold text-zinc-100">—</div>
                    <div className="text-xs text-zinc-500 mt-1">last 7 days</div>
                </div>
                <div className="emperor-panel rounded-2xl p-5">
                    <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Status</div>
                    <div className="text-2xl font-bold text-rose-400">
                        {agents.filter(a => a.budgetStatus === "paused").length} paused
                    </div>
                    <div className="text-xs text-zinc-500 mt-1">
                        {agents.filter(a => a.budgetStatus === "warning").length} at warning
                    </div>
                </div>
            </div>

            {/* Agent table */}
            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80 flex items-center justify-between">
                    <h2 className="text-sm font-semibold text-zinc-200">Agent Budgets</h2>
                    <span className="text-xs text-zinc-500">{agents.length} agents</span>
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
                            {agents.map((agent) => {
                                const budget = agent.monthlyBudgetCents ?? 0;
                                const cost = agent.monthlyCostCents ?? 0;
                                const tokens = agent.monthlyTokenUsage ?? 0;
                                const pct = budget > 0 ? Math.min(100, (cost / budget) * 100) : 0;
                                return (
                                    <tr key={agent.id} className="hover:bg-zinc-900/50 transition-colors">
                                        <td className="px-5 py-3">
                                            <Link href={`/agents/${agent.id}`} className="text-zinc-200 hover:text-cyan-300 font-medium">{agent.name}</Link>
                                            <div className="text-xs text-zinc-500">{agent.role}</div>
                                        </td>
                                        <td className="px-5 py-3">
                                            <ModelInlineSelect
                                                agentId={agent.id}
                                                currentModel={agent.llmModel}
                                                options={pricing.map(p => ({ model: p.model, label: p.label, provider: p.provider }))}
                                                onSaved={refresh}
                                            />
                                        </td>
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
                                            <BudgetInlineEdit agentId={agent.id} value={budget} onSaved={refresh} />
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
                {agents.length === 0 && <div className="p-8 text-center text-sm text-zinc-500">No agents found.</div>}
            </div>

            {/* Pricing reference */}
            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80">
                    <h2 className="text-sm font-semibold text-zinc-200">Model Pricing Reference</h2>
                    <p className="text-xs text-zinc-500 mt-0.5">Click prices to edit. Changes apply immediately to cost calculations.</p>
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
                                <PricingInlineEdit key={p.id} pricing={p} onSaved={refresh} />
                            ))}
                        </tbody>
                    </table>
                </div>
            </div>
        </>
    );
}
