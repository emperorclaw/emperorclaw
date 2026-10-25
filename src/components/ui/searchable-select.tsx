"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconCheck, IconChevronDown, IconSearch } from "@tabler/icons-react";
import { placeMenu, type MenuPosition } from "@/lib/menu-position";
import { cn } from "@/lib/utils";

export type SearchableSelectOption = {
    value: string;
    label: string;
    description?: string | null;
    /** Extra text the search matches but the list does not show (a project's description). */
    keywords?: string | null;
};

/** The option list's own cap (max-h-72); the viewport can make it smaller. */
const LIST_MAX_HEIGHT = 288;
/** Used for the first placement, before the open menu can be measured. */
const ESTIMATED_MENU_HEIGHT = 330;

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
    const [position, setPosition] = useState<(MenuPosition & { listMaxHeight: number }) | null>(null);
    const rootRef = useRef<HTMLDivElement>(null);
    // The menu renders in a portal on document.body so board columns and cards
    // (their own stacking contexts) can never paint over it.
    const menuRef = useRef<HTMLDivElement>(null);
    const headerRef = useRef<HTMLLabelElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const selected = options.find((option) => option.value === value);
    const filtered = useMemo(() => {
        const normalized = query.trim().toLowerCase();
        if (!normalized) return options;
        return options.filter((option) => `${option.label} ${option.description || ""} ${option.keywords || ""}`.toLowerCase().includes(normalized));
    }, [options, query]);

    const close = useCallback(() => {
        setOpen(false);
        setQuery("");
        setPosition(null);
    }, []);

    /** Place the menu against the trigger; `menuHeight` defaults to the open menu's natural height. */
    const reposition = useCallback((menuHeight?: number) => {
        const root = rootRef.current;
        if (!root) return;
        // The trigger was hidden (a breakpoint swap): nothing to anchor to.
        if (root.getClientRects().length === 0) { close(); return; }
        const header = headerRef.current;
        const list = listRef.current;
        const natural = menuHeight ?? (header && list ? header.offsetHeight + Math.min(list.scrollHeight, LIST_MAX_HEIGHT) + 2 : ESTIMATED_MENU_HEIGHT);
        const rect = root.getBoundingClientRect();
        const placed = placeMenu({
            trigger: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
            menuHeight: natural,
            viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
        });
        // The search row keeps its height; the option list gives up what does not fit.
        const headerHeight = header?.offsetHeight ?? 41;
        setPosition({ ...placed, listMaxHeight: Math.max(0, Math.min(LIST_MAX_HEIGHT, placed.maxHeight - headerHeight - 2)) });
    }, [close]);

    // Re-measure once the menu is in the DOM and whenever the list length changes, before paint.
    useLayoutEffect(() => {
        // Measuring the rendered menu is the point: the position depends on its DOM height.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        if (open) reposition();
    }, [open, filtered.length, reposition]);

    useEffect(() => {
        if (!open) return;
        const handlePointerDown = (event: PointerEvent) => {
            const target = event.target as Node;
            if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) close();
        };
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") close();
        };
        let frame = 0;
        const schedule = (event?: Event) => {
            // Scrolling the option list itself does not move the menu.
            if (event && menuRef.current?.contains(event.target as Node)) return;
            if (frame) return;
            frame = window.requestAnimationFrame(() => { frame = 0; reposition(); });
        };
        document.addEventListener("pointerdown", handlePointerDown);
        document.addEventListener("keydown", handleKeyDown);
        window.addEventListener("scroll", schedule, true);
        window.addEventListener("resize", schedule);
        return () => {
            document.removeEventListener("pointerdown", handlePointerDown);
            document.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("scroll", schedule, true);
            window.removeEventListener("resize", schedule);
            if (frame) window.cancelAnimationFrame(frame);
        };
    }, [open, close, reposition]);

    return (
        <div ref={rootRef} className={cn("relative min-w-[220px]", className)}>
            <button
                type="button"
                onClick={() => {
                    if (open) { close(); return; }
                    setOpen(true);
                    reposition(ESTIMATED_MENU_HEIGHT);
                }}
                className="flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border border-zinc-800 bg-zinc-950/80 px-3 text-left text-sm text-zinc-100 outline-none transition-colors hover:border-zinc-700 focus:border-cyan-400 focus:ring-1 focus:ring-cyan-400/60"
            >
                <span title={selected?.label} className={cn("truncate", !selected && "text-zinc-400")}>{selected?.label || placeholder}</span>
                <IconChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
            </button>
            {open && position && createPortal(
                <div
                    ref={menuRef}
                    data-placement={position.placement}
                    style={{ position: "fixed", top: position.top, bottom: position.bottom, left: position.left, width: position.width }}
                    className="z-[60] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl shadow-black/40"
                >
                    <label ref={headerRef} className="flex items-center gap-2 border-b border-zinc-800 px-3 py-2 text-sm text-zinc-400">
                        <IconSearch className="h-4 w-4" />
                        <input
                            autoFocus
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={searchPlaceholder}
                            className="w-full bg-transparent text-zinc-100 outline-none placeholder:text-zinc-500"
                        />
                    </label>
                    <div ref={listRef} style={{ maxHeight: position.listMaxHeight }} className="overflow-y-auto p-1">
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
                                        close();
                                    }}
                                    className={cn(
                                        "flex w-full cursor-pointer items-start gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-zinc-900",
                                        option.value === value ? "text-cyan-100" : "text-zinc-200",
                                    )}
                                >
                                    <IconCheck className={cn("mt-0.5 h-4 w-4 shrink-0", option.value === value ? "text-cyan-300" : "text-transparent")} />
                                    <span className="min-w-0">
                                        <span title={option.label} className="block truncate font-medium">{option.label}</span>
                                        {option.description ? <span className="mt-0.5 block truncate text-xs text-zinc-500">{option.description}</span> : null}
                                    </span>
                                </button>
                            ))
                        )}
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
