"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function BudgetInlineEdit({
    agentId, value, onSaved
}: {
    agentId: string; value: number; // cents
    onSaved: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [input, setInput] = useState(value > 0 ? String(value / 100) : "");
    const [saving, setSaving] = useState(false);

    const save = async () => {
        setSaving(true);
        const cents = input ? Math.round(parseFloat(input) * 100) : 0;
        await fetch(`/api/agents/${agentId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ monthlyBudgetCents: cents }),
        });
        setSaving(false);
        setEditing(false);
        onSaved();
    };

    if (!editing) {
        return (
            <button onClick={() => setEditing(true)} className="text-zinc-300 font-mono text-xs hover:text-cyan-300 cursor-pointer">
                {value > 0 ? `$${(value / 100).toFixed(2)}` : <span className="text-zinc-600">∞</span>}
            </button>
        );
    }

    return (
        <div className="flex items-center gap-1">
            <span className="text-zinc-400 text-xs">$</span>
            <input
                type="number" min="0" step="0.01"
                className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-xs text-zinc-100 outline-none focus:border-cyan-400"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                autoFocus
            />
            <Button size="sm" onClick={save} disabled={saving}
                className="h-5 text-[10px] px-1.5 bg-emerald-600 hover:bg-emerald-500">✓</Button>
            <Button size="sm" onClick={() => setEditing(false)}
                className="h-5 text-[10px] px-1.5 bg-zinc-700 hover:bg-zinc-600">✕</Button>
        </div>
    );
}

export function ModelInlineSelect({
    agentId, currentModel, options, onSaved
}: {
    agentId: string; currentModel: string | null;
    options: { model: string; label: string; provider: string }[];
    onSaved: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [selected, setSelected] = useState(currentModel || "");
    const [saving, setSaving] = useState(false);

    const save = async () => {
        setSaving(true);
        await fetch(`/api/agents/${agentId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ llmModel: selected || null }),
        });
        setSaving(false);
        setEditing(false);
        onSaved();
    };

    if (!editing) {
        return (
            <button onClick={() => setEditing(true)}
                className={cn("text-xs font-mono hover:text-cyan-300 cursor-pointer",
                    currentModel ? "text-zinc-400" : "text-zinc-600")}>
                {currentModel || "—"}
            </button>
        );
    }

    return (
        <div className="flex items-center gap-1">
            <select value={selected} onChange={e => setSelected(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-100 outline-none focus:border-cyan-400 max-w-[140px]">
                <option value="">—</option>
                {options.map(o => (
                    <option key={o.model} value={o.model}>{o.label} ({o.provider})</option>
                ))}
            </select>
            <Button size="sm" onClick={save} disabled={saving}
                className="h-5 text-[10px] px-1.5 bg-emerald-600 hover:bg-emerald-500">✓</Button>
            <Button size="sm" onClick={() => setEditing(false)}
                className="h-5 text-[10px] px-1.5 bg-zinc-700 hover:bg-zinc-600">✕</Button>
        </div>
    );
}

export function PricingInlineEdit({
    pricing, onSaved
}: {
    pricing: { id: string; provider: string; model: string; label: string; inputPricePer1k: number; outputPricePer1k: number };
    onSaved: () => void;
}) {
    const [editing, setEditing] = useState(false);
    const [inputPrice, setInputPrice] = useState(String(pricing.inputPricePer1k / 100000));
    const [outputPrice, setOutputPrice] = useState(String(pricing.outputPricePer1k / 100000));
    const [saving, setSaving] = useState(false);

    const save = async () => {
        setSaving(true);
        await fetch("/api/mcp/pricing", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                provider: pricing.provider,
                model: pricing.model,
                label: pricing.label,
                inputPricePer1k: Math.round(parseFloat(inputPrice) * 100000),
                outputPricePer1k: Math.round(parseFloat(outputPrice) * 100000),
            }),
        });
        setSaving(false);
        setEditing(false);
        onSaved();
    };

    if (!editing) {
        return (
            <tr className="text-xs group hover:bg-zinc-900/30">
                <td className="px-5 py-1.5 text-zinc-400 capitalize">{pricing.provider}</td>
                <td className="px-5 py-1.5 text-zinc-300 font-mono">{pricing.model}</td>
                <td className="px-5 py-1.5 text-right text-zinc-400 font-mono">
                    <button onClick={() => setEditing(true)} className="hover:text-cyan-300">
                        ${(pricing.inputPricePer1k / 100000).toFixed(2)}
                    </button>
                </td>
                <td className="px-5 py-1.5 text-right text-zinc-400 font-mono">
                    <button onClick={() => setEditing(true)} className="hover:text-cyan-300">
                        ${(pricing.outputPricePer1k / 100000).toFixed(2)}
                    </button>
                </td>
            </tr>
        );
    }

    return (
        <tr className="text-xs bg-cyan-500/5">
            <td className="px-5 py-1.5 text-zinc-400 capitalize">{pricing.provider}</td>
            <td className="px-5 py-1.5 text-zinc-300 font-mono">{pricing.model}</td>
            <td className="px-5 py-1.5 text-right">
                <input type="number" step="0.01" min="0"
                    className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400"
                    value={inputPrice} onChange={e => setInputPrice(e.target.value)}
                    onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }}
                    autoFocus />
            </td>
            <td className="px-5 py-1.5 text-right">
                <div className="flex items-center justify-end gap-1">
                    <input type="number" step="0.01" min="0"
                        className="w-16 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-[10px] text-zinc-100 text-right outline-none focus:border-cyan-400"
                        value={outputPrice} onChange={e => setOutputPrice(e.target.value)}
                        onKeyDown={e => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(false); }} />
                    <Button size="sm" onClick={save} disabled={saving}
                        className="h-5 text-[10px] px-1.5 bg-emerald-600 hover:bg-emerald-500">✓</Button>
                    <Button size="sm" onClick={() => setEditing(false)}
                        className="h-5 text-[10px] px-1.5 bg-zinc-700 hover:bg-zinc-600">✕</Button>
                </div>
            </td>
        </tr>
    );
}
