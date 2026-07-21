"use client";

import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

type ModelOption = { model: string; label: string; provider: string; inputPricePer1k: number; outputPricePer1k: number };

/** Searchable model selector for create-agent dialog */
export function ModelSearchSelect({
    options, value, onChange, placeholder = "Auto-detect"
}: {
    options: ModelOption[];
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

    const sel = options.find(o => o.model === value);

    return (
        <div ref={ref} className="relative">
            <button type="button" onClick={() => setOpen(!open)}
                className="h-8 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-xs text-left flex items-center justify-between outline-none focus:border-cyan-400">
                <span className={sel ? "text-zinc-200" : "text-zinc-500"}>
                    {sel ? `${sel.provider}/${sel.label}` : placeholder}
                </span>
                <span className="text-zinc-600 ml-2">{open ? "▲" : "▼"}</span>
            </button>
            {open && (
                <div className="absolute z-50 top-full mt-1 left-0 right-0 rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl overflow-hidden">
                    <div className="p-1.5 border-b border-zinc-800">
                        <input ref={inputRef} type="text" placeholder="Search models…" value={search}
                            onChange={e => setSearch(e.target.value)}
                            onKeyDown={e => { if (e.key === "Escape") { setOpen(false); setSearch(""); } }}
                            className="w-full bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 outline-none focus:border-cyan-400 placeholder:text-zinc-600" />
                    </div>
                    <div className="max-h-56 overflow-y-auto">
                        <button type="button" onClick={() => { onChange(""); setOpen(false); setSearch(""); }}
                            className={cn("w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800", !value ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-500")}>
                            {placeholder}
                        </button>
                        {filtered.map(o => (
                            <button key={o.model} type="button" onClick={() => { onChange(o.model); setOpen(false); setSearch(""); }}
                                className={cn("w-full text-left px-3 py-1.5 text-xs hover:bg-zinc-800 flex items-center justify-between",
                                    o.model === value ? "text-cyan-300 bg-cyan-500/10" : "text-zinc-300")}>
                                <span><span className="text-zinc-500">{o.provider}</span><span className="text-zinc-600 mx-1.5">/</span>{o.label}</span>
                                <span className="text-[10px] text-zinc-600 font-mono shrink-0">${(o.inputPricePer1k / 100000).toFixed(2)}/1M</span>
                            </button>
                        ))}
                        {filtered.length === 0 && <div className="px-3 py-3 text-xs text-zinc-600 text-center">No models match</div>}
                    </div>
                </div>
            )}
        </div>
    );
}
