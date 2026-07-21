"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

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
type ModelOption = { model: string; label: string; provider: string; inputPricePer1k: number; outputPricePer1k: number };

/* ============ INLINE CELLS ============ */

function BudgetCell({ agentId, value, updateAgent }: { agentId: string; value: number; updateAgent: (id: string, p: Partial<AgentRow>) => void }) {
    const [editing, setEditing] = useState(false);
    const [input, setInput] = useState(value > 0 ? String(value / 100) : "");
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        const cents = input ? Math.round(parseFloat(input) * 100) : 0;
        updateAgent(agentId, { monthlyBudgetCents: cents, budgetStatus: "active" });
        await fetch(`/api/agents/${agentId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ monthlyBudgetCents: cents, budgetStatus: "active" }) });
        setSaving(false); setEditing(false);
    };
    if (!editing) return <button onClick={() => setEditing(true)} className="text-zinc-300 font-mono text-xs hover:text-cyan-300">{value > 0 ? `$${(value / 100).toFixed(2)}` : <span className="text-zinc-600">∞</span>}</button>;
    return (
        <span className="inline-flex items-center gap-1">
            <span className="text-zinc-400 text-xs">$</span>
            <input type="number" min="0" step="0.01" autoFocus className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-cyan-400"
                value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
            <button onClick={save} disabled={saving} className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">✓</button>
            <button onClick={() => setEditing(false)} className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">✕</button>
        </span>
    );
}

function ModelCell({ agentId, currentModel, options, updateAgent }: { agentId: string; currentModel: string | null; options: ModelOption[]; updateAgent: (id: string, p: Partial<AgentRow>) => void }) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => {
        if (open) inputRef.current?.focus();
        const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);
    const filtered = search ? options.filter(o => o.label.toLowerCase().includes(search.toLowerCase()) || o.model.toLowerCase().includes(search.toLowerCase()) || o.provider.toLowerCase().includes(search.toLowerCase())) : options;
    const sel = options.find(o => o.model === currentModel);
    const select = async (m: string | null) => {
        updateAgent(agentId, { llmModel: m });
        setOpen(false); setSearch("");
        await fetch(`/api/agents/${agentId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ llmModel: m || null }) });
    };
    return (
        <div ref={ref} className="relative">
            <button onClick={() => setOpen(!open)} className={cn("text-xs rounded px-1.5 py-0.5 cursor-pointer text-left min-w-[90px] transition-colors",
                sel ? "text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800" : "text-zinc-500 bg-zinc-800/30 hover:bg-zinc-800/50 border border-dashed border-zinc-700")}>
                {sel ? <span>{sel.provider}<span className="text-zinc-600 mx-1">/</span>{sel.label}</span> : <span>Set model…</span>}
            </button>
            {open && (
                <div className="absolute z-50 top-full mt-1 left-0 w-72 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden">
                    <div className="p-1.5 border-b border-zinc-800">
                        <input ref={inputRef} type="text" placeholder="Search models…" value={search} onChange={e => setSearch(e.target.value)}
                            onKeyDown={e => { if (e.key === "Escape") { setOpen(false); setSearch(""); } if (e.key === "Enter" && filtered.length === 1) select(filtered[0].model); }}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600" />
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                        <button onClick={() => select(null)} className={cn("w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800", !currentModel ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-500")}>Not set — uses provider default</button>
                        {filtered.map(o => (
                            <button key={o.model} onClick={() => select(o.model)} className={cn("w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 flex items-center justify-between", o.model === currentModel ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-300")}>
                                <span><span className="text-zinc-500">{o.provider}</span><span className="text-zinc-600 mx-1.5">/</span>{o.label}</span>
                                <span className="text-[10px] text-zinc-600 font-mono shrink-0">${(o.inputPricePer1k / 100).toFixed(2)}/1M</span>
                            </button>
                        ))}
                        {filtered.length === 0 && <div className="px-3 py-3 text-xs text-zinc-600 text-center">No models match</div>}
                    </div>
                </div>
            )}
        </div>
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
        await fetch("/api/mcp/pricing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: p.provider, model: p.model, label: p.label, inputPricePer1k: Math.round(parseFloat(inP) * 100), outputPricePer1k: Math.round(parseFloat(outP) * 100) }) });
        setSaving(false); setEditing(false); onSaved();
    };
    const toggle = async () => {
        await fetch("/api/mcp/pricing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: p.provider, model: p.model, label: p.label, inputPricePer1k: p.inputPricePer1k, outputPricePer1k: p.outputPricePer1k, active: !p.active }) });
        onSaved();
    };
    if (!editing) return (
        <tr className={cn("text-xs group hover:bg-zinc-900/30", !p.active && "opacity-40")}>
            <td className="px-5 py-1.5 text-zinc-400 capitalize">{p.provider}</td>
            <td className="px-5 py-1.5 text-zinc-300 font-mono">{p.model}</td>
            <td className="px-5 py-1.5 text-right text-zinc-400 font-mono"><button onClick={() => setEditing(true)} className="hover:text-cyan-300">${(p.inputPricePer1k / 100).toFixed(2)}</button></td>
            <td className="px-5 py-1.5 text-right text-zinc-400 font-mono"><button onClick={() => setEditing(true)} className="hover:text-cyan-300">${(p.outputPricePer1k / 100).toFixed(2)}</button></td>
            <td className="px-3 py-1.5 text-center"><button onClick={toggle} className="text-[10px] text-zinc-600 hover:text-emerald-400" title={p.active ? "Disable" : "Enable"}>{p.active ? "✓" : "—"}</button></td>
        </tr>
    );
    return (
        <tr className="text-xs bg-cyan-500/5">
            <td className="px-5 py-1.5 text-zinc-400 capitalize">{p.provider}</td>
            <td className="px-5 py-1.5 text-zinc-300 font-mono">{p.model}</td>
            <td className="px-5 py-1.5 text-right"><input type="number" step="0.01" min="0" autoFocus className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400" value={inP} onChange={e => setInP(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} /></td>
            <td className="px-5 py-1.5 text-right"><span className="inline-flex items-center gap-1"><input type="number" step="0.01" min="0" className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400" value={outP} onChange={e => setOutP(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} /><button onClick={save} disabled={saving} className="text-[10px] px-1 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">✓</button><button onClick={() => setEditing(false)} className="text-[10px] px-1 py-0.5 rounded bg-zinc-700 hover:bg-zinc-600 text-white">✕</button></span></td>
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
        await fetch("/api/mcp/pricing", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ provider: prov, model, label, inputPricePer1k: Math.round(parseFloat(inP || "0") * 100), outputPricePer1k: Math.round(parseFloat(outP || "0") * 100) }) });
        setSaving(false); setOpen(false); setModel(""); setLabel(""); setInP(""); setOutP(""); onSaved();
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
        fetch("/api/mcp/pricing").then(r => r.json()).then(d => { if (d.pricing) setPricing(d.pricing); }).catch(() => {});
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

    const models: ModelOption[] = pricing.filter(p => p.active).map(p => ({
        model: p.model, label: p.label, provider: p.provider,
        inputPricePer1k: p.inputPricePer1k, outputPricePer1k: p.outputPricePer1k,
    }));

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
                                <td className="px-5 py-3"><ModelCell agentId={a.id} currentModel={a.llmModel} options={models} updateAgent={updateAgent} /></td>
                                <td className="px-5 py-3 text-right font-mono text-xs text-zinc-400">{t > 0 ? `${(t / 1000).toFixed(1)}K` : "—"}</td>
                                <td className="px-5 py-3 text-right"><span className="flex items-center justify-end gap-2">{b > 0 && <div className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden"><div className={cn("h-full rounded-full", a.budgetStatus === "paused" ? "bg-rose-500" : a.budgetStatus === "warning" ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} /></div>}<span className="text-zinc-200 font-mono text-xs">${(c / 100).toFixed(4)}</span></span></td>
                                <td className="px-5 py-3 text-right"><BudgetCell agentId={a.id} value={b} updateAgent={updateAgent} /></td>
                                <td className="px-5 py-3 text-right">{b <= 0 ? <span className="text-zinc-500 text-xs">—</span> : a.budgetStatus === "paused" ? <button onClick={async () => { updateAgent(a.id, { budgetStatus: "active" }); await fetch(`/api/agents/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budgetStatus: "active" }) }); }} className="text-rose-400 text-xs font-medium bg-rose-500/10 px-2 py-0.5 rounded hover:bg-rose-500/20 cursor-pointer" title="Budget exhausted. Click to reactivate.">⏸ Paused</button> : a.budgetStatus === "warning" ? <button onClick={async () => { updateAgent(a.id, { budgetStatus: "active" }); await fetch(`/api/agents/${a.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ budgetStatus: "active" }) }); }} className="text-amber-400 text-xs font-medium bg-amber-500/10 px-2 py-0.5 rounded hover:bg-amber-500/20 cursor-pointer" title="Nearing limit. Click to dismiss.">⚠ {Math.round(pct)}%</button> : <span className="text-emerald-400 text-xs font-medium bg-emerald-500/10 px-2 py-0.5 rounded">{Math.round(pct)}%</span>}</td>
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
