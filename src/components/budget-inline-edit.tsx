"use client";

import { useState, useRef, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function BudgetInlineEdit({
    agentId, value, onSaved
}: {
    agentId: string; value: number;
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

type ModelOption = { model: string; label: string; provider: string; inputPricePer1k: number; outputPricePer1k: number };

export function ModelInlineSelect({
    agentId, currentModel, options, onSaved
}: {
    agentId: string; currentModel: string | null;
    options: ModelOption[];
    onSaved: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const [saving, setSaving] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) inputRef.current?.focus();
        const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);

    const filtered = search
        ? options.filter(o =>
            o.label.toLowerCase().includes(search.toLowerCase()) ||
            o.model.toLowerCase().includes(search.toLowerCase()) ||
            o.provider.toLowerCase().includes(search.toLowerCase()))
        : options;

    const selectedOption = options.find(o => o.model === currentModel);

    const select = async (model: string | null) => {
        setSaving(true);
        await fetch(`/api/agents/${agentId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ llmModel: model || null }),
        });
        setSaving(false);
        setOpen(false);
        setSearch("");
        onSaved();
    };

    return (
        <div ref={ref} className="relative">
            <button
                onClick={() => setOpen(!open)}
                className={cn(
                    "text-xs rounded px-1.5 py-0.5 cursor-pointer transition-colors text-left min-w-[80px]",
                    selectedOption
                        ? "text-zinc-200 bg-zinc-800/50 hover:bg-zinc-800"
                        : "text-zinc-500 bg-zinc-800/30 hover:bg-zinc-800/50 border border-dashed border-zinc-700"
                )}
            >
                {selectedOption ? (
                    <span className="flex items-center gap-1.5">
                        <span className="text-[10px] uppercase text-zinc-500">{selectedOption.provider}</span>
                        <span>{selectedOption.label}</span>
                    </span>
                ) : (
                    <span>Set model…</span>
                )}
            </button>

            {open && (
                <div className="absolute z-50 top-full mt-1 left-0 w-64 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden">
                    <div className="p-1.5 border-b border-zinc-800">
                        <input
                            ref={inputRef}
                            type="text"
                            placeholder="Search models…"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            onKeyDown={e => {
                                if (e.key === "Escape") { setOpen(false); setSearch(""); }
                                if (e.key === "Enter" && filtered.length === 1) select(filtered[0].model);
                            }}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600"
                        />
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                        <button
                            onClick={() => select(null)}
                            className={cn("w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 transition-colors",
                                !currentModel ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-500")}
                        >
                            None — auto-detect
                        </button>
                        {filtered.map(o => (
                            <button
                                key={o.model}
                                onClick={() => select(o.model)}
                                className={cn(
                                    "w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 transition-colors flex items-center justify-between",
                                    o.model === currentModel ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-300"
                                )}
                            >
                                <span className="flex items-center gap-2">
                                    <span className="text-[10px] uppercase text-zinc-500 w-10 shrink-0">{o.provider}</span>
                                    <span>{o.label}</span>
                                </span>
                                <span className="text-[10px] text-zinc-600 font-mono ml-2 shrink-0">
                                    ${(o.inputPricePer1k / 100000).toFixed(2)}/1M
                                </span>
                            </button>
                        ))}
                        {filtered.length === 0 && (
                            <div className="px-3 py-3 text-xs text-zinc-600 text-center">No models match</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

/** Reusable searchable model selector — for create dialogs, no auto-save */
export function ModelSearchSelect({
    options, value, onChange, placeholder = "Auto-detect"
}: {
    options: { model: string; label: string; provider: string; inputPricePer1k: number; outputPricePer1k: number }[];
    value: string;
    onChange: (model: string) => void;
    placeholder?: string;
}) {
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

    const filtered = search
        ? options.filter(o =>
            o.label.toLowerCase().includes(search.toLowerCase()) ||
            o.model.toLowerCase().includes(search.toLowerCase()) ||
            o.provider.toLowerCase().includes(search.toLowerCase()))
        : options;

    const selectedOption = options.find(o => o.model === value);

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen(!open)}
                className="h-8 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-left flex items-center justify-between outline-none focus:border-cyan-400"
            >
                <span className={selectedOption ? "text-zinc-200" : "text-zinc-500"}>
                    {selectedOption ? `${selectedOption.provider} / ${selectedOption.label}` : placeholder}
                </span>
                <span className="text-zinc-600 ml-2">{open ? "▲" : "▼"}</span>
            </button>

            {open && (
                <div className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden">
                    <div className="p-1.5 border-b border-zinc-800">
                        <input
                            ref={inputRef}
                            type="text"
                            placeholder="Search models…"
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            onKeyDown={e => { if (e.key === "Escape") { setOpen(false); setSearch(""); } }}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600"
                        />
                    </div>
                    <div className="max-h-48 overflow-y-auto">
                        <button
                            type="button"
                            onClick={() => { onChange(""); setOpen(false); setSearch(""); }}
                            className={cn("w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 transition-colors",
                                !value ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-500")}
                        >
                            {placeholder}
                        </button>
                        {filtered.map(o => (
                            <button
                                key={o.model}
                                type="button"
                                onClick={() => { onChange(o.model); setOpen(false); setSearch(""); }}
                                className={cn(
                                    "w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 transition-colors flex items-center justify-between",
                                    o.model === value ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-300"
                                )}
                            >
                                <span className="flex items-center gap-2">
                                    <span className="text-[10px] uppercase text-zinc-500 w-10 shrink-0">{o.provider}</span>
                                    <span>{o.label}</span>
                                </span>
                                <span className="text-[10px] text-zinc-600 font-mono ml-2 shrink-0">
                                    ${(o.inputPricePer1k / 100000).toFixed(2)}/1M
                                </span>
                            </button>
                        ))}
                        {filtered.length === 0 && (
                            <div className="px-3 py-3 text-xs text-zinc-600 text-center">No models match</div>
                        )}
                    </div>
                </div>
            )}
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
