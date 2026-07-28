"use client";

import { useEffect, useRef, useState } from "react";
import { IconChevronDown, IconChevronUp, IconLoader2 } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export type ModelOption = {
    model: string;
    label: string;
    provider: string;
    inputPricePer1k: number;
    outputPricePer1k: number;
    active?: boolean;
};

export type ModelSelection = {
    provider: string;
    model: string;
};

/**
 * Shared model configuration control for agent creation, agent details, and
 * budgets. A model is always selected together with its provider so the two
 * configuration fields cannot silently contradict one another.
 */
export function ModelSearchSelect({
    options,
    value,
    provider = "",
    onChange,
    placeholder = "Not set — uses provider default",
    disabled = false,
    saving = false,
    error,
    compact = false,
}: {
    options: ModelOption[];
    value: string;
    provider?: string;
    onChange: (selection: ModelSelection) => void | Promise<void>;
    placeholder?: string;
    disabled?: boolean;
    saving?: boolean;
    error?: string | null;
    compact?: boolean;
}) {
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const ref = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (open) inputRef.current?.focus();
        const close = (event: MouseEvent) => {
            if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener("mousedown", close);
        return () => document.removeEventListener("mousedown", close);
    }, [open]);

    const modelMatches = options.filter((option) => option.model === value);
    const selected =
        modelMatches.find((option) => option.provider === provider) ||
        (modelMatches.length === 1 ? modelMatches[0] : undefined);
    const currentUnavailable = Boolean(value) && (!selected || selected.active === false);
    const selectableOptions = options.filter((option) => option.active !== false);
    const normalizedSearch = search.trim().toLowerCase();
    const filtered = normalizedSearch
        ? selectableOptions.filter((option) =>
            option.label.toLowerCase().includes(normalizedSearch) ||
            option.model.toLowerCase().includes(normalizedSearch) ||
            option.provider.toLowerCase().includes(normalizedSearch))
        : selectableOptions;

    const choose = async (selection: ModelSelection) => {
        setOpen(false);
        setSearch("");
        await onChange(selection);
    };

    const currentLabel = selected
        ? `${selected.provider}/${selected.label}`
        : value
            ? `${provider ? `${provider}/` : ""}${value}`
            : placeholder;

    return (
        <div ref={ref} className="relative">
            <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                disabled={disabled || saving}
                aria-expanded={open}
                aria-haspopup="listbox"
                className={cn(
                    "flex w-full items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900 text-left text-xs outline-none transition-colors focus:border-cyan-400 focus:ring-2 focus:ring-cyan-400/10 disabled:cursor-not-allowed disabled:opacity-50",
                    compact ? "min-h-8 min-w-[150px] px-2" : "min-h-10 px-3",
                    currentUnavailable && "border-amber-500/30",
                )}
            >
                <span className={cn("min-w-0 truncate", value ? "text-zinc-200" : "text-zinc-500")}>
                    {currentLabel}
                    {currentUnavailable && <span className="ml-1.5 text-amber-400">(unavailable)</span>}
                </span>
                <span className="ml-2 shrink-0 text-zinc-500">
                    {saving
                        ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" />
                        : open
                            ? <IconChevronUp className="h-3.5 w-3.5" />
                            : <IconChevronDown className="h-3.5 w-3.5" />}
                </span>
            </button>
            {error && <p className="mt-1 text-xs text-rose-400" role="alert">{error}</p>}
            {open && (
                <div className="absolute left-0 right-0 top-full z-50 mt-1 min-w-72 overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-xl">
                    <div className="border-b border-zinc-800 p-1.5">
                        <input
                            ref={inputRef}
                            type="search"
                            placeholder="Search models…"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Escape") {
                                    setOpen(false);
                                    setSearch("");
                                }
                                if (event.key === "Enter" && filtered.length === 1) {
                                    void choose({ provider: filtered[0].provider, model: filtered[0].model });
                                }
                            }}
                            className="h-9 w-full rounded border border-zinc-700 bg-zinc-800 px-2 text-xs text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-cyan-400"
                        />
                    </div>
                    <div className="max-h-60 overflow-y-auto" role="listbox">
                        <button
                            type="button"
                            onClick={() => void choose({ provider, model: "" })}
                            className={cn(
                                "w-full px-3 py-2 text-left text-xs hover:bg-zinc-800",
                                !value ? "bg-cyan-500/10 text-cyan-300" : "text-zinc-500",
                            )}
                        >
                            {placeholder}
                        </button>
                        {currentUnavailable && (
                            <div className="border-y border-amber-500/10 bg-amber-500/5 px-3 py-2 text-xs text-amber-300">
                                Current: {currentLabel} — disabled or missing from pricing
                            </div>
                        )}
                        {filtered.map((option) => {
                            const isSelected = option.model === value && (!provider || option.provider === provider);
                            return (
                                <button
                                    key={`${option.provider}:${option.model}`}
                                    type="button"
                                    role="option"
                                    aria-selected={isSelected}
                                    onClick={() => void choose({ provider: option.provider, model: option.model })}
                                    className={cn(
                                        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-xs hover:bg-zinc-800",
                                        isSelected ? "bg-cyan-500/10 text-cyan-300" : "text-zinc-300",
                                    )}
                                >
                                    <span className="min-w-0 truncate">
                                        <span className="text-zinc-500">{option.provider}</span>
                                        <span className="mx-1.5 text-zinc-600">/</span>
                                        {option.label}
                                    </span>
                                    <span className="shrink-0 font-mono text-[10px] text-zinc-600">
                                        ${(option.inputPricePer1k / 100).toFixed(2)}/1M
                                    </span>
                                </button>
                            );
                        })}
                        {filtered.length === 0 && (
                            <div className="px-3 py-3 text-center text-xs text-zinc-500">No active models match</div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
