"use client";

import { useEffect, useState, type ReactNode } from "react";
import { IconArrowsMaximize, IconArrowsMinimize } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

/**
 * Wraps a panel (diagrams, graphs, canvases) with an Expand/Collapse toggle
 * that blows it up to a near-fullscreen overlay. Closes on Escape or backdrop click.
 */
export function ExpandablePanel({
    children,
    className,
    expandedClassName,
    label = "Expand",
}: {
    children: (expanded: boolean) => ReactNode;
    className?: string;
    expandedClassName?: string;
    label?: string;
}) {
    const [expanded, setExpanded] = useState(false);

    useEffect(() => {
        if (!expanded) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") setExpanded(false);
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [expanded]);

    return (
        <>
            {expanded ? (
                <div className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm" onClick={() => setExpanded(false)} />
            ) : null}
            <div className={cn("relative", expanded ? cn("fixed inset-4 z-50 flex flex-col", expandedClassName) : className)}>
                <button
                    type="button"
                    onClick={() => setExpanded((value) => !value)}
                    className="absolute right-3 top-3 z-10 inline-flex cursor-pointer items-center gap-2 rounded-full border border-zinc-700 bg-zinc-950/90 px-3 py-1.5 text-xs font-medium text-zinc-300 backdrop-blur transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
                >
                    {expanded ? <IconArrowsMinimize className="h-3.5 w-3.5" /> : <IconArrowsMaximize className="h-3.5 w-3.5" />}
                    {expanded ? "Collapse" : label}
                </button>
                {children(expanded)}
            </div>
        </>
    );
}
