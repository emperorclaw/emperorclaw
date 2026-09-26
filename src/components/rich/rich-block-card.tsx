"use client";

import React, { useState } from "react";
import { IconChartBar, IconCheck, IconCode, IconCopy, IconLayoutGrid, IconSparkles } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

const KIND_ICON = {
    chart: IconChartBar,
    stats: IconLayoutGrid,
    widget: IconSparkles,
} as const;

/**
 * Shared chrome for rich message blocks: a titled card with "view source" and
 * "copy" so the data behind every chart or widget stays inspectable — an
 * operator should always be able to see exactly what the agent sent.
 */
export function RichBlockCard({
    kind,
    title,
    subtitle,
    source,
    sourceLanguage,
    actions,
    bleed = false,
    children,
}: {
    kind: keyof typeof KIND_ICON;
    title?: string;
    subtitle?: string;
    source: string;
    sourceLanguage: string;
    actions?: React.ReactNode;
    /** Let the body run edge to edge (widgets draw their own padding). */
    bleed?: boolean;
    children: React.ReactNode;
}) {
    const [showSource, setShowSource] = useState(false);
    const [copied, setCopied] = useState(false);
    const Icon = KIND_ICON[kind];

    const copy = async () => {
        try {
            await navigator.clipboard.writeText(source);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
        } catch {
            /* clipboard blocked — nothing useful to do */
        }
    };

    return (
        <figure className="not-prose group/rich my-3 w-full min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 shadow-sm">
            <figcaption className="flex items-start gap-2.5 border-b border-zinc-800/80 px-3.5 py-2.5">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-zinc-800/80 text-zinc-400">
                    <Icon className="h-3.5 w-3.5" />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-semibold leading-6 text-zinc-100">
                        {title || (kind === "chart" ? "Chart" : kind === "stats" ? "Overview" : "Interactive widget")}
                    </span>
                    {subtitle && <span className="-mt-0.5 block text-xs leading-snug text-zinc-500">{subtitle}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover/rich:opacity-100 focus-within:opacity-100">
                    {actions}
                    <button
                        type="button"
                        onClick={() => setShowSource((v) => !v)}
                        aria-pressed={showSource}
                        aria-label={showSource ? "Hide source" : "View source"}
                        title={showSource ? "Hide source" : "View source"}
                        className={cn(
                            "inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200",
                            showSource && "bg-zinc-800 text-zinc-200",
                        )}
                    >
                        <IconCode className="h-3.5 w-3.5" />
                    </button>
                    <button
                        type="button"
                        onClick={copy}
                        aria-label="Copy source"
                        title="Copy source"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
                    >
                        {copied ? <IconCheck className="h-3.5 w-3.5 text-emerald-400" /> : <IconCopy className="h-3.5 w-3.5" />}
                    </button>
                </span>
            </figcaption>
            {showSource ? (
                <pre className="max-h-[420px] overflow-auto bg-zinc-950/60 p-3.5 font-mono text-xs leading-relaxed text-zinc-300">
                    <code data-language={sourceLanguage}>{source}</code>
                </pre>
            ) : (
                <div className={bleed ? "" : "px-3.5 py-3"}>{children}</div>
            )}
        </figure>
    );
}
