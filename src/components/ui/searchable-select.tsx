"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { IconCheck, IconChevronDown, IconSearch } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

export type SearchableSelectOption = {
    value: string;
    label: string;
    description?: string | null;
};

export function SearchableSelect({
    value,
    options,
    placeholder,
    searchPlaceholder = "Search...",
    onChange,
    className,
}: {
    value: string;
    options: SearchableSelectOption[];
    placeholder: string;
    searchPlaceholder?: string;
    onChange: (value: string) => void;
    className?: string;
}) {
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const rootRef = useRef<HTMLDivElement>(null);
    const selected = options.find((option) => option.value === value);
    const filtered = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return options;
        return options.filter((option) => `${option.label} ${option.description || ""}`.toLowerCase().includes(normalized));
    }, [options, query]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
                setQuery("");
            }
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
                setQuery("");
            }
        };
        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
        };
    }, [open]);

    return (
        <div ref={rootRef} className={cn("relative min-w-[220px]", className)}>
            <button
                type="button"
                onClick={() => setOpen((current) => !current)}
                className="flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 text-left text-sm text-zinc-100 outline-none transition-colors hover:border-zinc-700 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
            >
                <span className={cn("truncate", !selected && "text-zinc-400")}>{selected?.label || placeholder}</span>
                <IconChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
            </button>
            {open && (
                <div className="absolute z-50 mt-2 w-full overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40">
                    <label className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-sm text-zinc-400">
                        <IconSearch className="h-4 w-4" />
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={searchPlaceholder}
                            className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500"
                        />
                    </label>
                    <div className="max-h-72 overflow-y-auto p-1">
                        {filtered.length === 0 ? (
                            <div className="px-3 py-6 text-center text-sm text-zinc-500">No matches</div>
                        ) : (
                            filtered.map((option) => (
                                <button
                                    key={option.value}
                                    type="button"
                                    onMouseDown={(event) => event.preventDefault()}
                                    onClick={() => {
                                        onChange(option.value);
                                        setOpen(false);
                                        setQuery("");
                                    }}
                                    className={cn(
                                        "flex w-full cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-900",
                                        option.value === value ? "text-cyan-100" : "text-zinc-200",
                                    )}
                                >
                                    <IconCheck className={cn("mt-0.5 h-4 w-4 shrink-0", option.value === value ? "text-cyan-300" : "text-transparent")} />
                                    <span className="min-w-0">
                                        <span className="block truncate font-medium">{option.label}</span>
                                        {option.description ? <span className="mt-0.5 block truncate text-xs text-zinc-500">{option.description}</span> : null}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}
