"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { ModelSearchSelect, type ModelOption, type ModelSelection } from "@/components/model-search-select";
import { DisabledReason } from "@/components/ui/disabled-reason";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

/** Providers offered when adding a price (brand names: never translated). */
const PRICING_PROVIDERS = [["openai", "OpenAI"], ["anthropic", "Anthropic"], ["google", "Google"], ["deepseek", "DeepSeek"], ["grok", "Grok"], ["openrouter", "OpenRouter"]] as const;
/** Input hints for a model id and a price (technical, never translated). */
const MODEL_ID_HINT = "model-id";
const PRICE_HINT = "0.00";

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

async function patchAgent(agentId: string, patch: Record<string, unknown>, failed: string) {
    const response = await fetch(`/api/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || failed);
    return body.agent as AgentRow;
}

async function savePricing(patch: {
    provider: string;
    model: string;
    label: string;
    inputPricePer1k: number;
    outputPricePer1k: number;
    active?: boolean;
}, failed: string) {
    const response = await fetch("/api/ui/pricing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || failed);
}

function BudgetCell({ agentId, value, updateAgent, canEdit }: { agentId: string; value: number; updateAgent: (id: string, p: Partial<AgentRow>) => void; canEdit: boolean }) {
    const t = useTranslations("budget");
    const [editing, setEditing] = useState(false);
    const [input, setInput] = useState(value > 0 ? String(value / 100) : "");
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        try {
            const parsed = Number.parseFloat(input);
            const cents = input && Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
            const updated = await patchAgent(agentId, { monthlyBudgetCents: cents, budgetStatus: "active" }, t("agentSaveFailed"));
            updateAgent(agentId, updated);
            setEditing(false);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("budgetSaveFailed"));
        } finally {
            setSaving(false);
        }
    };
    if (!canEdit) return <span className="text-foreground/70 font-mono text-xs">{value > 0 ? `$${(value / 100).toFixed(2)}` : <span className="text-muted-foreground">∞</span>}</span>;
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

function ModelCell({ agent, options, updateAgent, canEdit }: { agent: AgentRow; options: ModelOption[]; updateAgent: (id: string, p: Partial<AgentRow>) => void; canEdit: boolean }) {
    const t = useTranslations("budget");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const select = async (selection: ModelSelection) => {
        setSaving(true);
        setError(null);
        try {
            const updated = await patchAgent(agent.id, {
                llmProvider: selection.provider,
                llmModel: selection.model,
            }, t("agentSaveFailed"));
            updateAgent(agent.id, updated);
        } catch (saveError) {
            const message = saveError instanceof Error ? saveError.message : t("modelSaveFailed");
            setError(message);
            toast.error(message);
        } finally {
            setSaving(false);
        }
    };

    return (
        <DisabledReason reason={canEdit ? null : t("modelOwnersOnly")} className="block">
            <ModelSearchSelect
                options={options}
                value={agent.llmModel || ""}
                provider={agent.llmProvider || ""}
                onChange={select}
                saving={saving}
                disabled={saving || !canEdit}
                error={error}
                compact
            />
        </DisabledReason>
    );
}

/* ============ PRICING TABLE ============ */

function PricingRow({ p, onSaved, canEdit }: { p: PricingRow; onSaved: () => void; canEdit: boolean }) {
    const t = useTranslations("budget");
    const [editing, setEditing] = useState(false);
    const [inP, setInP] = useState(String(p.inputPricePer1k / 100));
    const [outP, setOutP] = useState(String(p.outputPricePer1k / 100));
    const [saving, setSaving] = useState(false);
    const save = async () => {
        setSaving(true);
        try {
            await savePricing({ provider: p.provider, model: p.model, label: p.label, inputPricePer1k: Math.round(parseFloat(inP) * 100), outputPricePer1k: Math.round(parseFloat(outP) * 100) }, t("pricingSaveFailed"));
            setEditing(false);
            onSaved();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("pricingSaveFailed"));
        } finally {
            setSaving(false);
        }
    };
    const toggle = async () => {
        try {
            await savePricing({ provider: p.provider, model: p.model, label: p.label, inputPricePer1k: p.inputPricePer1k, outputPricePer1k: p.outputPricePer1k, active: !p.active }, t("pricingSaveFailed"));
            onSaved();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("availabilityFailed"));
        }
    };
    if (!canEdit) return (
        <tr className={cn("text-xs", !p.active && "opacity-40")}>
            <td className="sticky left-0 bg-zinc-950 px-5 py-1.5 text-muted-foreground capitalize">{p.provider}</td>
            <td className="px-5 py-1.5 text-foreground font-mono">{p.model}</td>
            <td className="px-5 py-1.5 text-right text-muted-foreground font-mono">${(p.inputPricePer1k / 100).toFixed(2)}</td>
            <td className="px-5 py-1.5 text-right text-muted-foreground font-mono">${(p.outputPricePer1k / 100).toFixed(2)}</td>
            <td className="px-3 py-1.5 text-center text-[10px] text-muted-foreground">{p.active ? "✓" : "—"}</td>
        </tr>
    );
    if (!editing) return (
        <tr className={cn("text-xs group hover:bg-accent/50", !p.active && "opacity-40")}>
            <td className="sticky left-0 bg-zinc-950 px-5 py-1.5 text-muted-foreground capitalize">{p.provider}</td>
            <td className="px-5 py-1.5 text-foreground font-mono">{p.model}</td>
            <td className="px-5 py-1.5 text-right text-muted-foreground font-mono"><button onClick={() => setEditing(true)} className="hover:text-primary">${(p.inputPricePer1k / 100).toFixed(2)}</button></td>
            <td className="px-5 py-1.5 text-right text-muted-foreground font-mono"><button onClick={() => setEditing(true)} className="hover:text-primary">${(p.outputPricePer1k / 100).toFixed(2)}</button></td>
            <td className="px-3 py-1.5 text-center"><button onClick={toggle} className="text-[10px] text-muted-foreground hover:text-emerald-400" title={p.active ? t("disable") : t("enable")}>{p.active ? "✓" : "—"}</button></td>
        </tr>
    );
    return (
        <tr className="text-xs bg-primary/5">
            <td className="sticky left-0 bg-zinc-950 px-5 py-1.5 text-muted-foreground capitalize">{p.provider}</td>
            <td className="px-5 py-1.5 text-foreground font-mono">{p.model}</td>
            <td className="px-5 py-1.5 text-right"><input type="number" step="0.01" min="0" autoFocus className="w-16 bg-muted border border-border rounded px-1 py-0.5 text-[10px] text-foreground text-right outline-none focus:border-primary" value={inP} onChange={e => setInP(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} /></td>
            <td className="px-5 py-1.5 text-right"><span className="inline-flex items-center gap-1"><input type="number" step="0.01" min="0" className="w-16 bg-muted border border-border rounded px-1 py-0.5 text-[10px] text-foreground text-right outline-none focus:border-primary" value={outP} onChange={e => setOutP(e.target.value)} onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} /><button onClick={save} disabled={saving} className="text-[10px] px-1 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white">✓</button><button onClick={() => setEditing(false)} className="text-[10px] px-1 py-0.5 rounded bg-muted hover:bg-accent text-foreground">✕</button></span></td>
            <td className="px-3" />
        </tr>
    );
}

function AddModelRow({ onSaved }: { onSaved: () => void }) {
    const t = useTranslations("budget");
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
            await savePricing({ provider: prov, model, label, inputPricePer1k: Math.round(parseFloat(inP || "0") * 100), outputPricePer1k: Math.round(parseFloat(outP || "0") * 100) }, t("pricingSaveFailed"));
            setOpen(false);
            setModel("");
            setLabel("");
            setInP("");
            setOutP("");
            onSaved();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("pricingAddFailed"));
        } finally {
            setSaving(false);
        }
    };
    if (!open) return (<tr className="text-xs"><td colSpan={5} className="px-5 py-2"><button onClick={() => setOpen(true)} className="text-zinc-500 hover:text-cyan-300 text-xs">{t("addPricing")}</button></td></tr>);
    return (
        <tr className="text-xs bg-emerald-500/5">
            <td className="px-3 py-1.5"><select value={prov} onChange={e => setProv(e.target.value)} className="bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-cyan-400">{PRICING_PROVIDERS.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></td>
            <td className="px-3 py-1.5"><input type="text" placeholder={MODEL_ID_HINT} value={model} onChange={e => setModel(e.target.value)} className="w-28 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600" /></td>
            <td className="px-3 py-1.5"><input type="text" placeholder={t("labelPlaceholder")} value={label} onChange={e => setLabel(e.target.value)} className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600" /></td>
            <td className="px-3 py-1.5"><input type="number" step="0.01" min="0" placeholder={PRICE_HINT} value={inP} onChange={e => setInP(e.target.value)} className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400 placeholder:text-zinc-600" /></td>
            <td className="px-3 py-1.5"><span className="inline-flex items-center gap-1"><input type="number" step="0.01" min="0" placeholder={PRICE_HINT} value={outP} onChange={e => setOutP(e.target.value)} className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-1 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400 placeholder:text-zinc-600" /><button onClick={save} disabled={saving} className="text-[10px] px-1.5 py-1 rounded bg-emerald-600 hover:bg-emerald-500 text-white">✓</button><button onClick={() => setOpen(false)} className="text-[10px] px-1.5 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-white">✕</button></span></td>
        </tr>
    );
}

/* ============ MAIN ============ */

export function BudgetClient({ initialAgents, initialPricing, initialWeeklyCost, canEdit = true, canEditPricing = true }: {
    initialAgents: AgentRow[]; initialPricing: PricingRow[]; initialWeeklyCost: number;
    /** member and up: budgets, models, reactivation (viewers only read). */
    canEdit?: boolean;
    /** owner/admin: the model pricing table. */
    canEditPricing?: boolean;
}) {
    const t = useTranslations("budget");
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
            const updated = await patchAgent(agent.id, { budgetStatus: "active" }, t("agentSaveFailed"));
            updateAgent(agent.id, updated);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : t("reactivateFailed"));
        }
    };

    return (
        <>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <div className="emperor-panel rounded-2xl p-4 sm:p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{t("stats.monthlySpend")}</div><div className="text-xl font-bold text-zinc-100 sm:text-2xl">${(totalCostCents / 100).toFixed(2)}</div><div className="text-xs text-zinc-500 mt-1">{t("stats.kTokens", { count: (totalTokens / 1000).toFixed(0) })}</div></div>
                <div className="emperor-panel rounded-2xl p-4 sm:p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{t("stats.budget")}</div><div className="text-xl font-bold text-zinc-100 sm:text-2xl">{totalBudgetCents > 0 ? `$${(totalBudgetCents / 100).toFixed(0)}` : t("stats.unlimited")}</div><div className="text-xs text-zinc-500 mt-1">{t("stats.capped", { count: capped })}</div></div>
                <div className="emperor-panel rounded-2xl p-4 sm:p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{t("stats.weeklySpend")}</div><div className="text-xl font-bold text-zinc-100 sm:text-2xl">${(initialWeeklyCost / 100).toFixed(2)}</div><div className="text-xs text-zinc-500 mt-1">{t("stats.last7Days")}</div></div>
                <div className="emperor-panel rounded-2xl p-4 sm:p-5"><div className="text-xs text-zinc-500 uppercase tracking-wider mb-1">{t("stats.alerts")}</div><div className="text-xl font-bold text-rose-400 sm:text-2xl">{t("stats.paused", { count: paused })}</div><div className="text-xs text-zinc-500 mt-1">{t("stats.warning", { count: warned })}</div></div>
            </div>

            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80 flex items-center justify-between"><h2 className="text-sm font-semibold text-zinc-200">{t("agentBudgets")}</h2><span className="text-xs text-zinc-500">{t("agentCount", { count: agents.length })}</span></div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wider"><th className="sticky left-0 z-10 bg-zinc-950 text-left px-5 py-3 font-medium">{t("columns.agent")}</th><th className="text-left px-5 py-3 font-medium">{t("columns.model")}</th><th className="text-right px-5 py-3 font-medium">{t("columns.tokens")}</th><th className="text-right px-5 py-3 font-medium">{t("columns.cost")}</th><th className="text-right px-5 py-3 font-medium">{t("columns.limit")}</th><th className="text-right px-5 py-3 font-medium">{t("columns.status")}</th></tr></thead>
                    <tbody className="divide-y divide-zinc-800/50">
                        {agents.map(a => {
                            const b = a.monthlyBudgetCents ?? 0, c = a.monthlyCostCents ?? 0, tokens = a.monthlyTokenUsage ?? 0;
                            const pct = b > 0 ? Math.min(100, (c / b) * 100) : 0;
                            return (<tr key={a.id} className="hover:bg-zinc-900/50 transition-colors">
                                <td className="sticky left-0 bg-zinc-950 px-5 py-3"><Link href={`/agents?agent=${a.id}`} className="text-zinc-200 hover:text-cyan-300 font-medium">{a.name}</Link><div className="text-xs text-zinc-500">{a.role}</div></td>
                                <td className="px-5 py-3"><ModelCell agent={a} options={models} updateAgent={updateAgent} canEdit={canEdit} /></td>
                                <td className="px-5 py-3 text-right font-mono text-xs text-zinc-400">{tokens > 0 ? `${(tokens / 1000).toFixed(1)}K` : "—"}</td>
                                <td className="px-5 py-3 text-right"><span className="flex items-center justify-end gap-2">{b > 0 && <div className="w-16 h-1.5 rounded-full bg-zinc-800 overflow-hidden"><div className={cn("h-full rounded-full", a.budgetStatus === "paused" ? "bg-rose-500" : a.budgetStatus === "warning" ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${pct}%` }} /></div>}<span className="text-zinc-200 font-mono text-xs">${(c / 100).toFixed(4)}</span></span></td>
                                <td className="px-5 py-3 text-right"><BudgetCell agentId={a.id} value={b} updateAgent={updateAgent} canEdit={canEdit} /></td>
                                <td className="px-5 py-3 text-right">{b <= 0 ? <span className="text-zinc-500 text-xs">—</span> : a.budgetStatus === "paused" ? !canEdit ? <span className="text-rose-400 text-xs font-medium bg-rose-500/10 px-2 py-0.5 rounded">⏸ {t("pausedBadge")}</span> : <button onClick={() => void reactivateAgent(a)} className="text-rose-400 text-xs font-medium bg-rose-500/10 px-2 py-0.5 rounded hover:bg-rose-500/20 cursor-pointer" title={t("exhaustedTitle")}>⏸ {t("pausedBadge")}</button> : a.budgetStatus === "warning" ? !canEdit ? <span className="text-amber-400 text-xs font-medium bg-amber-500/10 px-2 py-0.5 rounded">⚠ {Math.round(pct)}%</span> : <button onClick={() => void reactivateAgent(a)} className="text-amber-400 text-xs font-medium bg-amber-500/10 px-2 py-0.5 rounded hover:bg-amber-500/20 cursor-pointer" title={t("nearingTitle")}>⚠ {Math.round(pct)}%</button> : <span className="text-emerald-400 text-xs font-medium bg-emerald-500/10 px-2 py-0.5 rounded">{Math.round(pct)}%</span>}</td>
                            </tr>);
                        })}
                    </tbody></table></div>
                {agents.length === 0 && <div className="p-8 text-center text-sm text-zinc-500">{t("noAgents")}</div>}
            </div>

            <div className="emperor-panel rounded-2xl overflow-hidden">
                <div className="px-5 py-3 border-b border-zinc-800/80"><h2 className="text-sm font-semibold text-zinc-200">{t("pricingTitle")}</h2><p className="text-xs text-zinc-500 mt-0.5">{canEditPricing ? t("pricingEditHint") : t("pricingReadHint")}</p></div>
                <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-zinc-800 text-xs text-zinc-500 uppercase tracking-wider"><th className="sticky left-0 z-10 bg-zinc-950 text-left px-5 py-2 font-medium">{t("pricingColumns.provider")}</th><th className="text-left px-5 py-2 font-medium">{t("pricingColumns.modelId")}</th><th className="text-right px-5 py-2 font-medium">{t("pricingColumns.input")}</th><th className="text-right px-5 py-2 font-medium">{t("pricingColumns.output")}</th><th className="text-center px-3 py-2 font-medium w-8">{t("pricingColumns.on")}</th></tr></thead>
                    <tbody className="divide-y divide-zinc-800/50">
                        {pricing.filter(p => p.active).map(p => <PricingRow key={p.id} p={p} onSaved={refreshPricing} canEdit={canEditPricing} />)}
                        {pricing.filter(p => !p.active).map(p => <PricingRow key={p.id} p={p} onSaved={refreshPricing} canEdit={canEditPricing} />)}
                        {canEditPricing && <AddModelRow onSaved={refreshPricing} />}
                    </tbody></table></div>
            </div>
        </>
    );
}
