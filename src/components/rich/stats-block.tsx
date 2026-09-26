"use client";

import React from "react";
import { IconArrowDownRight, IconArrowRight, IconArrowUpRight } from "@tabler/icons-react";
import type { StatItem } from "@/lib/rich-blocks";
import { cn } from "@/lib/utils";

const TONE = {
    positive: { chip: "bg-emerald-500/12 text-emerald-400 ring-emerald-500/20", stroke: "var(--chart-2)" },
    negative: { chip: "bg-rose-500/12 text-rose-400 ring-rose-500/20", stroke: "var(--chart-5)" },
    neutral: { chip: "bg-zinc-500/12 text-zinc-400 ring-zinc-500/20", stroke: "var(--chart-1)" },
} as const;

function Sparkline({ values, color }: { values: number[]; color: string }) {
    const w = 96;
    const h = 28;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 2 - ((v - min) / span) * (h - 4)] as const);
    const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
    return (
        <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="h-7 w-full min-w-10 max-w-24 overflow-visible" aria-hidden>
            <path d={`${d}L${w},${h}L0,${h}Z`} fill={color} fillOpacity={0.1} />
            <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" className="ec-chart-draw" pathLength={1} />
        </svg>
    );
}

export function StatsBlock({ items }: { items: StatItem[] }) {
    const columns = items.length === 1 ? "grid-cols-1" : items.length === 2 || items.length === 4 ? "grid-cols-2" : "grid-cols-2 sm:grid-cols-3";
    return (
        <div className={cn("not-prose my-3 grid w-full min-w-0 gap-2", columns)}>
            {items.map((item, i) => {
                const tone = TONE[item.tone];
                const Arrow = item.trend === "up" ? IconArrowUpRight : item.trend === "down" ? IconArrowDownRight : IconArrowRight;
                return (
                    <div
                        key={i}
                        className="ec-rich-rise relative min-w-0 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60 px-3.5 py-3"
                        style={{ animationDelay: `${i * 45}ms` }}
                    >
                        <div className="truncate text-[11px] font-medium uppercase tracking-wider text-zinc-500">{item.label}</div>
                        <div className="mt-1 flex items-end justify-between gap-2">
                            <div className="min-w-0 truncate text-2xl font-semibold leading-tight tracking-tight text-zinc-50 tabular-nums">{item.value}</div>
                            {item.spark && <div className="flex min-w-0 flex-1 justify-end"><Sparkline values={item.spark} color={tone.stroke} /></div>}
                        </div>
                        {(item.delta || item.hint) && (
                            <div className="mt-1.5 flex min-w-0 items-center gap-2 text-xs">
                                {item.delta && (
                                    <span className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium ring-1 ring-inset tabular-nums", tone.chip)}>
                                        {item.trend && <Arrow className="h-3 w-3" />}
                                        {item.delta}
                                    </span>
                                )}
                                {item.hint && <span className="truncate text-zinc-500">{item.hint}</span>}
                            </div>
                        )}
                        {item.progress !== undefined && (
                            <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-zinc-800" role="progressbar" aria-valuenow={Math.round(item.progress)} aria-valuemin={0} aria-valuemax={100}>
                                <div className="ec-chart-grow-x h-full rounded-full" style={{ width: `${item.progress}%`, background: tone.stroke, transformOrigin: "left" }} />
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
}
