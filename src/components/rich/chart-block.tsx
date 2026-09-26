"use client";

import React, { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ChartSpec, formatChartValue, niceTicks } from "@/lib/rich-blocks";
import { RichBlockCard } from "./rich-block-card";

// The app's own chart tokens first (they follow light/dark), then a few more
// hues so a 12-series chart never repeats a color.
const PALETTE = [
    "var(--chart-1)",
    "var(--chart-2)",
    "var(--chart-3)",
    "var(--chart-4)",
    "var(--chart-5)",
    "oklch(0.72 0.13 195)",
    "oklch(0.74 0.15 130)",
    "oklch(0.70 0.17 350)",
    "oklch(0.76 0.12 95)",
    "oklch(0.66 0.14 265)",
    "oklch(0.72 0.12 50)",
    "oklch(0.70 0.08 220)",
];

const AXIS_FONT = 11;

function seriesColor(spec: ChartSpec, index: number): string {
    return spec.series[index]?.color || PALETTE[index % PALETTE.length];
}

function useWidth<T extends HTMLElement>(fallback = 560): [React.RefObject<T | null>, number] {
    const ref = useRef<T | null>(null);
    const [width, setWidth] = useState(fallback);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const update = () => setWidth(Math.max(220, Math.floor(el.getBoundingClientRect().width)));
        update();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);
    return [ref, width];
}

interface Hover {
    index: number;
    x: number;
    y: number;
}

function Tooltip({ spec, hover, width, sliceIndex }: { spec: ChartSpec; hover: Hover; width: number; sliceIndex?: number }) {
    const isPie = spec.type === "pie" || spec.type === "donut";
    const rows = isPie
        ? [{ name: spec.labels[hover.index], value: spec.series[0].data[hover.index], color: seriesColor(spec, 0), sliceColor: PALETTE[hover.index % PALETTE.length] }]
        : spec.series.map((s, i) => ({ name: s.name, value: s.data[hover.index], color: seriesColor(spec, i), sliceColor: undefined }));
    const total = isPie ? spec.series[0].data.reduce((a, b) => a + Math.max(0, b), 0) : 0;
    const left = Math.min(Math.max(hover.x + 12, 8), width - 188);
    return (
        <div
            role="status"
            className="pointer-events-none absolute z-10 min-w-[140px] max-w-[200px] rounded-lg border border-zinc-700/80 bg-zinc-900/95 px-3 py-2 text-xs shadow-xl backdrop-blur"
            style={{ left, top: Math.max(hover.y - 12, 0) }}
        >
            {!isPie && <div className="mb-1 font-semibold text-zinc-100">{spec.labels[hover.index]}</div>}
            {rows.map((row, i) => (
                <div key={i} className="flex items-center justify-between gap-3 text-zinc-300">
                    <span className="flex min-w-0 items-center gap-1.5">
                        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: row.sliceColor ?? row.color }} />
                        <span className="truncate">{row.name}</span>
                    </span>
                    <span className="font-mono tabular-nums text-zinc-100">{formatChartValue(row.value, spec.prefix, spec.unit)}</span>
                </div>
            ))}
            {isPie && total > 0 && sliceIndex !== undefined && (
                <div className="mt-0.5 text-[11px] text-zinc-500">{((Math.max(0, rows[0].value) / total) * 100).toFixed(1)}% of total</div>
            )}
        </div>
    );
}

function Legend({ items }: { items: { name: string; color: string; detail?: string }[] }) {
    if (items.length < 2) return null;
    return (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-zinc-400">
            {items.map((item, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: item.color }} />
                    <span className="text-zinc-300">{item.name}</span>
                    {item.detail && <span className="font-mono tabular-nums text-zinc-500">{item.detail}</span>}
                </span>
            ))}
        </div>
    );
}

function estimateTextWidth(text: string): number {
    return text.length * AXIS_FONT * 0.6;
}

// ─── Cartesian (bar / line / area) ─────────────────────────────────────────

function CartesianChart({ spec, width }: { spec: ChartSpec; width: number }) {
    const gradientId = useId().replace(/:/g, "");
    const [hover, setHover] = useState<Hover | null>(null);
    const n = spec.labels.length;
    const isBar = spec.type === "bar";
    const horizontal = isBar && spec.horizontal;
    const stacked = spec.stacked && spec.series.length > 1;

    const { min, max } = useMemo(() => {
        let lo = 0;
        let hi = 0;
        for (let i = 0; i < n; i++) {
            if (stacked) {
                let pos = 0;
                let neg = 0;
                for (const s of spec.series) {
                    if (s.data[i] >= 0) pos += s.data[i];
                    else neg += s.data[i];
                }
                hi = Math.max(hi, pos);
                lo = Math.min(lo, neg);
            } else {
                for (const s of spec.series) {
                    hi = Math.max(hi, s.data[i]);
                    lo = Math.min(lo, s.data[i]);
                }
            }
        }
        // Line charts don't need a zero baseline when every value is far from it.
        if (!isBar && lo >= 0) {
            const all = spec.series.flatMap((s) => s.data);
            const dataMin = Math.min(...all);
            if (dataMin > 0 && dataMin > hi * 0.4) lo = dataMin - (hi - dataMin) * 0.15;
        }
        return { min: lo, max: hi };
    }, [isBar, n, spec.series, stacked]);

    const ticks = niceTicks(min, max, horizontal ? 4 : 4);
    const tMin = ticks[0];
    const tMax = ticks[ticks.length - 1];
    const tickLabels = ticks.map((t) => formatChartValue(t, spec.prefix, spec.unit, true));

    // Horizontal bars size to their rows instead of stretching into slabs.
    const height = horizontal && !spec.explicitHeight ? Math.max(120, Math.min(640, n * (spec.series.length > 1 && !stacked ? 30 : 26) + 44)) : spec.height;
    const categoryLabelWidth = horizontal
        ? Math.min(160, Math.max(40, ...spec.labels.map(estimateTextWidth)) + 10)
        : 0;
    const margin = {
        top: 10,
        right: horizontal ? 16 : 12,
        bottom: horizontal ? 24 : 30,
        left: horizontal ? categoryLabelWidth : Math.max(28, ...tickLabels.map(estimateTextWidth)) + 10,
    };
    const plotW = Math.max(60, width - margin.left - margin.right);
    const plotH = Math.max(60, height - margin.top - margin.bottom);
    const scaleV = (v: number) => ((v - tMin) / (tMax - tMin || 1)) * (horizontal ? plotW : plotH);
    const zero = scaleV(Math.max(tMin, Math.min(0, tMax)));

    // Thin category labels so they never overlap.
    const maxLabelChars = Math.max(1, ...spec.labels.map((l) => l.length));
    const slot = (horizontal ? plotH : plotW) / Math.max(1, n);
    const labelEvery = horizontal
        ? Math.max(1, Math.ceil(16 / slot))
        : Math.max(1, Math.ceil((Math.min(maxLabelChars, 14) * AXIS_FONT * 0.62 + 8) / slot));
    const clip = (label: string) => (!horizontal && label.length > 14 ? `${label.slice(0, 13)}…` : horizontal && estimateTextWidth(label) > categoryLabelWidth - 10 ? `${label.slice(0, Math.floor((categoryLabelWidth - 14) / (AXIS_FONT * 0.6)))}…` : label);

    const xOf = (i: number) => (isBar ? slot * i + slot / 2 : n <= 1 ? plotW / 2 : (plotW * i) / (n - 1));

    const onMove = (event: React.MouseEvent<SVGRectElement>) => {
        const rect = event.currentTarget.getBoundingClientRect();
        const along = horizontal ? event.clientY - rect.top : event.clientX - rect.left;
        const span = horizontal ? rect.height : rect.width;
        const index = isBar
            ? Math.min(n - 1, Math.max(0, Math.floor((along / span) * n)))
            : Math.min(n - 1, Math.max(0, Math.round((along / span) * (n - 1))));
        const rel = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
        setHover({ index, x: event.clientX - rel.left, y: event.clientY - rel.top });
    };

    const bars: React.ReactNode[] = [];
    if (isBar) {
        const groupPad = Math.min(0.28, 0.12 + n * 0.004);
        const inner = slot * (1 - groupPad);
        const count = stacked ? 1 : spec.series.length;
        const barGap = count > 1 ? Math.min(3, inner * 0.06) : 0;
        const barW = Math.max(1, Math.min(horizontal ? 22 : 64, (inner - barGap * (count - 1)) / count));
        const radius = Math.min(4, barW / 3);
        for (let i = 0; i < n; i++) {
            let posAcc = 0;
            let negAcc = 0;
            spec.series.forEach((s, si) => {
                const v = s.data[i];
                let from: number;
                let to: number;
                if (stacked) {
                    from = v >= 0 ? posAcc : negAcc;
                    to = from + v;
                    if (v >= 0) posAcc = to;
                    else negAcc = to;
                } else {
                    from = 0;
                    to = v;
                }
                const a = scaleV(Math.max(tMin, Math.min(tMax, from)));
                const b = scaleV(Math.max(tMin, Math.min(tMax, to)));
                const lo = Math.min(a, b);
                const len = Math.max(v === 0 ? 0 : 1, Math.abs(b - a));
                const used = count * barW + barGap * (count - 1);
                const offset = slot * i + (slot - used) / 2 + (stacked ? 0 : si * (barW + barGap));
                const dim = hover && hover.index !== i ? 0.45 : 1;
                const style: React.CSSProperties = { opacity: dim, transition: "opacity 120ms", animationDelay: `${Math.min(i * 18, 400)}ms` };
                bars.push(horizontal ? (
                    <rect key={`${i}-${si}`} className="ec-chart-grow-x" x={lo} y={offset} width={len} height={barW} rx={radius} fill={seriesColor(spec, si)} style={{ ...style, transformOrigin: v < 0 ? "right" : "left" }} />
                ) : (
                    <rect key={`${i}-${si}`} className="ec-chart-grow-y" x={offset} y={plotH - lo - len} width={barW} height={len} rx={radius} fill={seriesColor(spec, si)} style={{ ...style, transformOrigin: v < 0 ? "top" : "bottom" }} />
                ));
            });
        }
    }

    const lines = !isBar ? spec.series.map((s, si) => {
        const points = s.data.map((v, i) => [xOf(i), plotH - scaleV(v)] as const);
        const d = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
        const area = spec.type === "area" && points.length > 1
            ? `${d}L${points[points.length - 1][0].toFixed(1)},${(plotH - zero).toFixed(1)}L${points[0][0].toFixed(1)},${(plotH - zero).toFixed(1)}Z`
            : null;
        return (
            <g key={si}>
                {area && <path d={area} fill={`url(#${gradientId}-${si})`} />}
                <path d={d} fill="none" stroke={seriesColor(spec, si)} strokeWidth={2.25} strokeLinejoin="round" strokeLinecap="round" className="ec-chart-draw" pathLength={1} />
                {(n <= 24 || hover) && points.map(([x, y], i) => (hover ? hover.index === i : n <= 24) && (
                    <circle key={i} cx={x} cy={y} r={hover?.index === i ? 4.5 : 2.75} fill="var(--card)" stroke={seriesColor(spec, si)} strokeWidth={2} />
                ))}
            </g>
        );
    }) : null;

    return (
        <div className="relative">
            <svg width={width} height={height} className="block overflow-visible" role="img" aria-label={spec.title || "Chart"}>
                <defs>
                    {spec.series.map((_, si) => (
                        <linearGradient key={si} id={`${gradientId}-${si}`} x1="0" x2="0" y1="0" y2="1">
                            <stop offset="0%" stopColor={seriesColor(spec, si)} stopOpacity={0.35} />
                            <stop offset="100%" stopColor={seriesColor(spec, si)} stopOpacity={0.02} />
                        </linearGradient>
                    ))}
                </defs>
                <g transform={`translate(${margin.left},${margin.top})`}>
                    {/* value grid + axis labels */}
                    {ticks.map((t, i) => {
                        const p = scaleV(t);
                        return horizontal ? (
                            <g key={i}>
                                <line x1={p} x2={p} y1={0} y2={plotH} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "3 4"} />
                                <text x={p} y={plotH + 16} textAnchor="middle" fontSize={AXIS_FONT} fill="var(--muted-foreground)" className="tabular-nums">{tickLabels[i]}</text>
                            </g>
                        ) : (
                            <g key={i}>
                                <line x1={0} x2={plotW} y1={plotH - p} y2={plotH - p} stroke="var(--border)" strokeDasharray={t === 0 ? undefined : "3 4"} />
                                <text x={-8} y={plotH - p + 4} textAnchor="end" fontSize={AXIS_FONT} fill="var(--muted-foreground)" className="tabular-nums">{tickLabels[i]}</text>
                            </g>
                        );
                    })}
                    {/* category labels */}
                    {spec.labels.map((label, i) => i % labelEvery === 0 && (
                        horizontal ? (
                            <text key={i} x={-8} y={slot * i + slot / 2 + 4} textAnchor="end" fontSize={AXIS_FONT} fill={hover?.index === i ? "var(--foreground)" : "var(--muted-foreground)"}>{clip(label)}</text>
                        ) : (
                            <text key={i} x={xOf(i)} y={plotH + 18} textAnchor={!isBar && i === 0 ? "start" : !isBar && i === n - 1 ? "end" : "middle"} fontSize={AXIS_FONT} fill={hover?.index === i ? "var(--foreground)" : "var(--muted-foreground)"}>{clip(label)}</text>
                        )
                    ))}
                    {!isBar && hover && <line x1={xOf(hover.index)} x2={xOf(hover.index)} y1={0} y2={plotH} stroke="var(--muted-foreground)" strokeOpacity={0.4} />}
                    {isBar && hover && (horizontal
                        ? <rect x={0} y={slot * hover.index} width={plotW} height={slot} fill="var(--foreground)" fillOpacity={0.04} />
                        : <rect x={slot * hover.index} y={0} width={slot} height={plotH} fill="var(--foreground)" fillOpacity={0.04} />)}
                    {bars}
                    {lines}
                    <rect x={0} y={0} width={plotW} height={plotH} fill="transparent" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
                </g>
            </svg>
            {hover && <Tooltip spec={spec} hover={hover} width={width} />}
        </div>
    );
}

// ─── Pie / donut ───────────────────────────────────────────────────────────

function PieChart({ spec, width }: { spec: ChartSpec; width: number }) {
    const [hover, setHover] = useState<Hover | null>(null);
    const values = spec.series[0].data.map((v) => Math.max(0, v));
    const total = values.reduce((a, b) => a + b, 0);
    const size = Math.min(spec.height, width < 420 ? width : width * 0.5);
    const r = size / 2 - 6;
    const inner = spec.type === "donut" ? r * 0.62 : 0;
    const cx = size / 2;
    const cy = size / 2;

    const slices = values.reduce<{ i: number; v: number; start: number; end: number; sweep: number }[]>((acc, v, i) => {
        const sweep = total > 0 ? (v / total) * Math.PI * 2 : 0;
        const start = acc.length ? acc[acc.length - 1].end : -Math.PI / 2;
        acc.push({ i, v, start, end: start + sweep, sweep });
        return acc;
    }, []);

    const arc = (start: number, end: number, outer: number, innerR: number) => {
        const large = end - start > Math.PI ? 1 : 0;
        const p = (a: number, rad: number) => `${(cx + Math.cos(a) * rad).toFixed(2)},${(cy + Math.sin(a) * rad).toFixed(2)}`;
        if (end - start >= Math.PI * 2 - 1e-6) end = start + Math.PI * 2 - 1e-4;
        if (innerR <= 0) return `M${cx},${cy}L${p(start, outer)}A${outer},${outer} 0 ${large} 1 ${p(end, outer)}Z`;
        return `M${p(start, outer)}A${outer},${outer} 0 ${large} 1 ${p(end, outer)}L${p(end, innerR)}A${innerR},${innerR} 0 ${large} 0 ${p(start, innerR)}Z`;
    };

    const stacked = width < 420;
    return (
        <div className={stacked ? "flex flex-col items-center gap-3" : "flex items-center gap-6"}>
            <div className="relative shrink-0" style={{ width: size, height: size }}>
                <svg width={size} height={size} role="img" aria-label={spec.title || "Chart"} className="ec-chart-pop">
                    {total === 0 && <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={r - inner || r} />}
                    {slices.map((s) => s.sweep > 0 && (
                        <path
                            key={s.i}
                            d={arc(s.start, s.end, hover?.index === s.i ? r + 4 : r, inner)}
                            fill={PALETTE[s.i % PALETTE.length]}
                            stroke="var(--card)"
                            strokeWidth={slices.length > 1 ? 2 : 0}
                            style={{ opacity: hover && hover.index !== s.i ? 0.55 : 1, transition: "opacity 120ms" }}
                            onMouseMove={(e) => {
                                const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
                                setHover({ index: s.i, x: e.clientX - rect.left, y: e.clientY - rect.top });
                            }}
                            onMouseLeave={() => setHover(null)}
                        />
                    ))}
                    {spec.type === "donut" && (
                        <>
                            <text x={cx} y={cy - 2} textAnchor="middle" fontSize={Math.max(14, r * 0.26)} fontWeight={650} fill="var(--foreground)" className="tabular-nums">
                                {formatChartValue(hover ? values[hover.index] : total, spec.prefix, spec.unit, true)}
                            </text>
                            <text x={cx} y={cy + Math.max(14, r * 0.2)} textAnchor="middle" fontSize={11} fill="var(--muted-foreground)">
                                {hover ? spec.labels[hover.index].slice(0, 18) : "Total"}
                            </text>
                        </>
                    )}
                </svg>
                {hover && spec.type === "pie" && <Tooltip spec={spec} hover={hover} width={size + 200} sliceIndex={hover.index} />}
            </div>
            <div className="grid min-w-0 flex-1 gap-1.5 text-xs">
                {slices.map((s) => (
                    <div
                        key={s.i}
                        className={`flex items-center justify-between gap-3 rounded-md px-2 py-1 transition-colors ${hover?.index === s.i ? "bg-zinc-800/60" : ""}`}
                        onMouseEnter={() => setHover({ index: s.i, x: cx, y: cy })}
                        onMouseLeave={() => setHover(null)}
                    >
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="h-2.5 w-2.5 shrink-0 rounded-[3px]" style={{ background: PALETTE[s.i % PALETTE.length] }} />
                            <span className="truncate text-zinc-300">{spec.labels[s.i]}</span>
                        </span>
                        <span className="flex shrink-0 items-baseline gap-2 font-mono tabular-nums">
                            <span className="text-zinc-100">{formatChartValue(s.v, spec.prefix, spec.unit, true)}</span>
                            <span className="w-11 text-right text-zinc-500">{total > 0 ? `${((s.v / total) * 100).toFixed(s.v / total < 0.1 ? 1 : 0)}%` : "—"}</span>
                        </span>
                    </div>
                ))}
            </div>
        </div>
    );
}

export function ChartBlock({ spec, source }: { spec: ChartSpec; source: string }) {
    const [ref, width] = useWidth<HTMLDivElement>();
    const isPie = spec.type === "pie" || spec.type === "donut";
    return (
        <RichBlockCard kind="chart" title={spec.title} subtitle={spec.subtitle} source={source} sourceLanguage="json">
            <div ref={ref} className="w-full min-w-0">
                {isPie ? <PieChart spec={spec} width={width} /> : <CartesianChart spec={spec} width={width} />}
            </div>
            {!isPie && <Legend items={spec.series.map((s, i) => ({ name: s.name, color: seriesColor(spec, i) }))} />}
        </RichBlockCard>
    );
}
