"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ModelSearchSelect, type ModelOption, type ModelSelection } from "@/components/model-search-select";
import { toast } from "sonner";

type AgentRow = {
    id: string; name: string; role: string | null;
    llmProvider: string | null; llmModel: string | null;
    status: string | null; monthlyBudgetCents: number | null;
    monthlyTokenUsage: number | null; monthlyCostCents: number | null;
    budgetStatus: string | null;
};
type PricingRow = {
    id: string; provider: string; model: string; label: string;
    inputPricePer1k: number; outputPricePer1k: number; active: boolean;
};

/* ============ INLINE CELLS ============ */

async function patchAgent(agentId: string, patch: Record<string, unknown>) {
    const response = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not save agent settings");
    return body.agent as AgentRow;
}

async function savePricing(patch: {
    provider: string;
    model: string;
    label: string;
    inputPricePer1k: number;
    outputPricePer1k: number;
    active?: boolean;
}) {
    const response = await fetch("/api/ui/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not save model pricing");
}

function BudgetCell({ agentId, value, updateAgent }: { agentId: string; value: number; updateAgent: (id: string, p: Partial<AgentRow>) => void }) {
    const [editing, setEditing] = useState(false);
    const [input, setInput] = useState(value > 0 ? String(value / 100) : "");
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        try {
            const parsed = Number.parseFloat(input);
            const cents = input && Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
            const updated = await patchAgent(agentId, { monthlyBudgetCents: cents, budgetStatus: "active" });
            updateAgent(agentId, updated);
            setEditing(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not save the budget");
        } finally {
            setSaving(false);
        }
    };
    if (!editing) return <button onClick={() => setEditing(true)} className="text-foreground/70 font-mono text-xs hover:text-primary">{value > 0 ? `$${(value / 100).toFixed(2)}` : <span className="text-muted-foreground">∞</span>}</button>;
    return (
        <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground text-xs">$</span>
            <input type="number" min="0" step="0.01" autoFocus className="w-16 bg-muted border border-border rounded px-1.5 py-0.5 text-xs text-foreground outline-none focus:border-primary"
                value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
            <button onClick={() => void save()} disabled={saving} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white disabled:opacity-50">{saving ? "…" : "✓"}</button>
            <button onClick={() => setEditing(false)} className="text-[10px] px-1.5 py-0.5 rounded bg-muted hover:bg-accent text-foreground">✕</button>
        </span>
    );
}

function ModelCell({ agent, options, updateAgent }: { agent: AgentRow; options: ModelOption[]; updateAgent: (id: string, p: Partial<AgentRow>) => void }) {
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const select = async (selection: ModelSelection) => {
        setSaving(true);
        setError(null);
        try {
            const updated = await patchAgent(agent.id, {
                llmProvider: selection.provider,
                llmModel: selection.model,
            });
            updateAgent(agent.id, updated);
        } catch (saveError) {
            const message = saveError instanceof Error ? saveError.message : "Could not save the model";
            setError(message);
            toast.error(message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <ModelSearchSelect
            options={options}
            value={agent.llmModel || ""}
            provider={agent.llmProvider || ""}
            onChange={select}
            saving={saving}
            disabled={saving}
            error={error}
            compact
        />
    );
}

/* ============ PRICING TABLE ============ */

function PricingRow({ p, onSaved }: { p: PricingRow; onSaved: () => void }) {
    const [editing, setEditing] = useState(false);
    const [inP, setInP] = useState(String(p.inputPricePer1k / 100));
    const [outP, setOutP] = useState(String(p.outputPricePer1k / 100));
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        try {
            await savePricing({ provider: p.provider, model: p.model, label: p.label, inputPricePer1k: Math.round(parseFloat(inP) * 100), outputPricePer1k: Math.round(parseFloat(outP) * 100) });
            setEditing(false);
            onSaved();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not save model pricing");
        } finally {
            setSaving(false);
        }
    };
    const toggle = async () => {
        try {
            await savePricing({ provider: p.provider, model: p.model, label: p.label, inputPricePer1k: p.inputPricePer1k, outputPricePer1k: p.outputPricePer1k, active: !p.active });
            onSaved();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not update model availability");
        }
    };
    if (!editing) return (
        <tr className={cn("text-xs group hover:bg-accent/50", !p.active && "opacity-40")}>
            <td className="px-5 py-1.5 text-muted-foreground capitalize">{p.provider}</td>
            <td className="px-5 py-1.5 text-foreground font-mono">{p.model}</td>
            <td className="px-5 py-1.5 text-right text-muted-foreground font-mono"><button onClick={() => setEditing(true)} className="hover:text-primary">${(p.inputPricePer1k / 100).toFixed(2)}</button></td>
            <td className="px-5 py-1.5 text-right text-muted-foreground font-mono"><button onClick={() => setEditing(true)} className="hover:text-primary">${(p.outputPricePer1k / 100).toFixed(2)}</button></td>
            <td className="px-3 py-1.5 text-center"><button onClick={toggle} className="text-[10px] text-muted-foreground hover:text-emerald-400" title={p.active ? "Disable" : "Enable"}>{p.active ? "✓" : "—"}</button></td>
        </tr>
    );
    return (
        <tr className="text-xs bg-primary/5">
            <td className="px-5 py-1.5 text-muted-foreground capitalize">{p.provider}</td>
            <td className="px-5 py-1.5 text-foreground font-mono">{p.model}</td>
            <td className="px-5 py-1.5 text-right"><input type="number" step="0.01" min="0" autoFocus className="w-16 bg-muted border border-border rounded px-1 py-0.5 text-[10px] text-foreground text-right outline-none focus:border-primary" value={inP} onChange={e => setInP(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} /></td>
            <td className="px-5 py-1.5 text-right"><span className="inline-flex items-center gap-1"><input type="number" step="0.01" min="0" className="w-16 bg-muted border border-border rounded px-1 py-0.5 text-[10px] text-foreground text-right outline-none focus:border-primary" value={outP} onChange={e => setOutP(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} /><button onClick={save} disabled={saving} className="text-[10px] px-1 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">✓</button><button onClick={() => setEditing(false)} className="text-[10px] px-1 py-0.5 rounded bg-muted hover:bg-accent text-foreground">✕</button></span></td>
            <td className="px-3" />
        </tr>
    );
}

function AddModelRow({ onSaved }: { onSaved: () => void }) {
    const [open, setOpen] = useState(false);
    const [prov, setProv] = useState("openai");
    const [model, setModel] = useState("");
    const [label, setLabel] = useState("");
    const [inP, setInP] = useState("");
    const [outP, setOutP] = useState("");
    const [saving, setSaving] = useState(false);
    const save = async () => {
        if (!model || !label) return;
        setSaving(true);
        try {
            await savePricing({ provider: prov, model, label, inputPricePer1k: Math.round(parseFloat(inP || "0") * 100), outputPricePer1k: Math.round(parseFloat(outP || "0") * 100) });
            setOpen(false);
            setModel("");
            setLabel("");
            setInP("");
            setOutP("");
            onSaved();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not add model pricing");
        } finally {
            setSaving(false);
        }
    };
    if (!open) return (<tr className="text-xs"><td colSpan={5} className="px-5 py-2"><button onClick={() => setOpen(true)} className="text-zinc-500 hover:text-cyan-300 text-xs">+ Add model pricing</button></td></tr>);
    return (
        <tr className="text-xs bg-emerald-500/5">
            <td className="px-3 py-1.5"><select value={prov} onChange={e => setProv(e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-cyan-400"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="google">Google</option><option value="deepseek">DeepSeek</option><option value="grok">Grok</option><option value="openrouter">OpenRouter</option></select></td>
            <td className="px-3 py-1.5"><input type="text" placeholder="model-id" value={model} onChange={e => setModel(e.target.value)} className="w-28 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600" /></td>
            <td className="px-3 py-1.5"><input type="text" placeholder="Label" value={label} onChange={e => setLabel(e.target.value)} className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600" /></td>
            <td className="px-3 py-1.5"><input type="number" step="0.01" min="0" placeholder="0.00" value={inP} onChange={e => setInP(e.target.value)} className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400 placeholder:text-zinc-600" /></td>
            <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1"><input type="number" step="0.01" min="0" placeholder="0.00" value={outP} onChange={e => setOutP(e.target.value)} className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400 placeholder:text-zinc-600" /><button onClick={save} disabled={saving} className="text-[10px] px-1.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white">✓</button><button onClick={() => setOpen(false)} className="text-[10px] px-1.5 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-white">✕</button></span></td>
        </tr>
    );
}

/* ============ MAIN ============ */

export function BudgetClient({ initialAgents, initialPricing, initialWeeklyCost }: {
    initialAgents: AgentRow[]; initialPricing: PricingRow[]; initialWeeklyCost: number;
}) {
    const [agents, setAgents] = useState(initialAgents);
    const [pricing, setPricing] = useState(initialPricing);
    const [key, setKey] = useState(0);
    const refreshPricing = () => setKey(k => k + 1);

    useEffect(() => {
        fetch("/api/ui/pricing").then(r => r.json()).then(d => { if (d.pricing) setPricing(d.pricing); }).catch(() => {});
    }, [key]);

    // Single source of truth for ALL inline edits
    const updateAgent = (id: string, patch: Partial<AgentRow>) => {
        setAgents(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a));
    };

    // Live totals from current state
    const totalCostCents = agents.reduce((s, a) => s + (a.monthlyCostCents ?? 0), 0);
    const totalTokens = agents.reduce((s, a) => s + (a.monthlyTokenUsage ?? 0), 0);
    const totalBudgetCents = agents.reduce((s, a) => s + (a.monthlyBudgetCents ?? 0), 0);
    const capped = agents.filter(a => (a.monthlyBudgetCents ?? 0) > 0).length;
    const paused = agents.filter(a => a.budgetStatus === "paused").length;
    const warned = agents.filter(a => a.budgetStatus === "warning").length;

    const models: ModelOption[] = pricing.map(p => ({
        model: p.model, label: p.label, provider: p.provider,
        inputPricePer1k: p.inputPricePer1k, outputPricePer1k: p.outputPricePer1k,
        active: p.active,
    }));

    const reactivateAgent = async (agent: AgentRow) => {
        try {
            const updated = await patchAgent(agent.id, { budgetStatus: "active" });
            updateAgent(agent.id, updated);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not reactivate the agent");
        }
    };

    return (
        <>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-4">
                <div className="emperor-panel rounded-2xl p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Monthly Spend</div><div className="text-2xl font-bold text-zinc-100">${(totalCostCents / 100).toFixed(2)}</div><div className="text-xs text-zinc-500 mt-1">{(totalTokens / 1000).toFixed(0)}K tokens</div></div>
                <div className="emperor-panel rounded-2xl p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Budget</div><div className="text-2xl font-bold text-zinc-100">{totalBudgetCents > 0 ? `$${(totalBudgetCents / 100).toFixed(0)}` : "Unlimited"}</div><div className="text-xs text-zinc-500 mt-1">{capped} agents capped</div></div>
                <div className="emperor-panel rounded-2xl p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">7-Day Spend</div><div className="text-2xl font-bold text-zinc-100">${(initialWeeklyCost / 100).toFixed(2)}</div><div className="text-xs text-zinc-500 mt-1">last 7 days</div></div>
                <div className="emperor-panel rounded-2xl p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">Alerts</div><div className="text-2xl font-bold text-rose-400">{paused} paused</div><div className="text-xs text-zinc-500 mt-1">{warned} at warning</div></div>
            </div>

            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80 flex items-center justify-between"><h2 className="text-sm font-semibold text-zinc-200">Agent Budgets</h2><span className="text-xs text-zinc-500">{agents.length} agents</span></div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wider"><th className="text-left px-5 py-3 font-medium">Agent</th><th className="text-left px-5 py-3 font-medium">Model</th><th className="text-right px-5 py-3 font-medium">Tokens</th><th className="text-right px-5 py-3 font-medium">Cost</th><th className="text-right px-5 py-3 font-medium">Limit</th><th className="text-right px-5 py-3 font-medium">Status</th></tr></thead>
                    <tbody className="divide-y divide-zinc-800/50">
                        {agents.map(a => {
                            const b = a.monthlyBudgetCents ?? 0, c = a.monthlyCostCents ?? 0, t = a.monthlyTokenUsage ?? 0;
                            const pct = b > 0 ? Math.min(100, (c / b) * 100) : 0;
                            return (<tr key={a.id} className="hover:bg-zinc-900/50 transition-colors">
                                <td className="px-5 py-3"><Link href={`/agents/${a.id}`} className="text-zinc-200 hover:text-cyan-300 font-medium">{a.name}</Link><div className="text-xs text-zinc-500">{a.role}</div></td>
                                <td className="px-5 py-3"><ModelCell agent={a} options={models} updateAgent={updateAgent} /></td>
                                <td className="px-5 py-3 text-right font-mono text-xs text-zinc-400">{t > 0 ? `${(t / 1000).toFixed(1)}K` : "—"}</td>
                                <td className="px-5 py-3 text-right"><span className="flex items-center justify-end gap-2">{b > 0 && <div className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden"><div className={cn("h-full rounded-full", a.budgetStatus === "paused" ? "bg-rose-500" : a.budgetStatus === "warning" ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} /></div>}<span className="text-zinc-200 font-mono text-xs">${(c / 100).toFixed(4)}</span></span></td>
                                <td className="px-5 py-3 text-right"><BudgetCell agentId={a.id} value={b} updateAgent={updateAgent} /></td>
                                <td className="px-5 py-3 text-right">{b <= 0 ? <span className="text-zinc-500 text-xs">—</span> : a.budgetStatus === "paused" ? <button onClick={() => void reactivateAgent(a)} className="text-rose-400 text-xs font-medium bg-rose-500/10 px-2 py-0.5 rounded hover:bg-rose-500/20 cursor-pointer" title="Budget exhausted. Click to reactivate.">⏸ Paused</button> : a.budgetStatus === "warning" ? <button onClick={() => void reactivateAgent(a)} className="text-amber-400 text-xs font-medium bg-amber-500/10 px-2 py-0.5 rounded hover:bg-amber-500/20 cursor-pointer" title="Nearing limit. Click to dismiss.">⚠ {Math.round(pct)}%</button> : <span className="text-emerald-400 text-xs font-medium bg-emerald-500/10 px-2 py-0.5 rounded">{Math.round(pct)}%</span>}</td>
                            </tr>);
                        })}
                    </tbody></table></div>
                {agents.length === 0 && <div className="p-8 text-center text-sm text-zinc-500">No agents found.</div>}
            </div>

            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80"><h2 className="text-sm font-semibold text-zinc-200">Model Pricing</h2><p className="text-xs text-zinc-500 mt-0.5">Click prices to edit. Toggle ✓ to disable. + to add new.</p></div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wider"><th className="text-left px-5 py-2 font-medium">Provider</th><th className="text-left px-5 py-2 font-medium">Model ID</th><th className="text-right px-5 py-2 font-medium">Input /1M</th><th className="text-right px-5 py-2 font-medium">Output /1M</th><th className="text-center px-3 py-2 font-medium w-8">On</th></tr></thead>
                    <tbody className="divide-y divide-zinc-800/50">
                        {pricing.filter(p => p.active).map(p => <PricingRow key={p.id} p={p} onSaved={refreshPricing} />)}
                        {pricing.filter(p => !p.active).map(p => <PricingRow key={p.id} p={p} onSaved={refreshPricing} />)}
                        <AddModelRow onSaved={refreshPricing} />
                    </tbody></table></div>
            </div>
        </>
    );
}
