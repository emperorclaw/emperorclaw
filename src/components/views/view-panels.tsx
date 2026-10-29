"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconArrowDownRight, IconArrowRight, IconArrowUpRight, IconMessageQuestion } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { CartesianChart, Legend, seriesColor, useWidth } from "@/components/rich/chart-block";
import { Sparkline } from "@/components/rich/stats-block";
import { MarkdownRenderer } from "@/components/markdown-renderer";
import { formatChartValue, type ChartSpec } from "@/lib/rich-blocks";
import {
    isSafeViewHref,
    type ChartPanelData, type ListPanelData, type MarkdownPanelData, type MetricPanelData, type ProgressPanelData, type TablePanelData,
    type ViewPanelData, type ViewPanelLayout,
} from "@/lib/view-spec";
import { cn } from "@/lib/utils";
import { viewStaleness } from "@/lib/view-access";

/** A panel as the page receives it (lib/views.ts ViewPanel, serialized). */
export type ViewPanelView = ViewPanelLayout & {
    data: ViewPanelData | null;
    updatedAt: string | null;
    updatedBy: { type: string; id: string | null; name: string | null } | null;
};

// Static class maps so Tailwind sees every span. Phones stack every panel.
const COL_SPAN: Record<number, string> = {
    1: "md:col-span-1", 2: "md:col-span-2", 3: "md:col-span-3", 4: "md:col-span-4", 5: "md:col-span-5", 6: "md:col-span-6",
    7: "md:col-span-7", 8: "md:col-span-8", 9: "md:col-span-9", 10: "md:col-span-10", 11: "md:col-span-11", 12: "md:col-span-12",
};
const ROW_SPAN: Record<number, string> = {
    1: "md:row-span-1", 2: "md:row-span-2", 3: "md:row-span-3", 4: "md:row-span-4",
    5: "md:row-span-5", 6: "md:row-span-6", 7: "md:row-span-7", 8: "md:row-span-8",
};
/** One grid row on md+ (panel heights are multiples of it). */
const ROW_PX = 92;

/** "just now", "5 min ago", "2 h ago", "3 d ago" (or "never"), in the person's language. */
export function useFormatAgo() {
    const t = useTranslations("views.ago");
    return useCallback((iso: string | null, nowMs: number): string => {
        if (!iso) return t("never");
        const minutes = Math.floor((nowMs - Date.parse(iso)) / 60_000);
        if (!Number.isFinite(minutes) || minutes < 1) return t("justNow");
        if (minutes < 60) return t("minutes", { count: minutes });
        if (minutes < 60 * 24) return t("hours", { count: Math.floor(minutes / 60) });
        return t("days", { count: Math.floor(minutes / 1440) });
    }, [t]);
}

/** Re-renders every minute so "Updated … ago" stays true while the page is open. */
export function useNowMs(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNow(Date.now()), 60_000);
        return () => window.clearInterval(id);
    }, []);
    return now;
}

export function ViewGrid({ panels, emptyHint, refreshEveryMinutes = null, since, onAsk }: {
    panels: ViewPanelView[];
    emptyHint?: React.ReactNode;
    /** The view's promised refresh interval: panels past 1.5x of it say they are overdue. */
    refreshEveryMinutes?: number | null;
    /** When the view was created (a panel with no value yet is measured from it). */
    since?: string;
    /** "Ask about this panel"; omitted when the person cannot chat with the maintaining agent. */
    onAsk?: (panel: ViewPanelView) => void;
}) {
    const t = useTranslations("views.panel");
    const now = useNowMs();
    if (panels.length === 0) {
        return (
            <div className="rounded-2xl border border-dashed border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
                {emptyHint ?? t("noPanels")}
            </div>
        );
    }
    return (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-12" style={{ gridAutoRows: `minmax(${ROW_PX}px, auto)` }}>
            {panels.map((panel) => <PanelCard key={panel.id} panel={panel} nowMs={now} refreshEveryMinutes={refreshEveryMinutes} since={since} onAsk={onAsk} />)}
        </div>
    );
}

function PanelCard({ panel, nowMs, refreshEveryMinutes, since, onAsk }: {
    panel: ViewPanelView; nowMs: number; refreshEveryMinutes: number | null; since?: string; onAsk?: (panel: ViewPanelView) => void;
}) {
    const t = useTranslations("views.panel");
    const formatAgo = useFormatAgo();
    const by = panel.updatedBy?.name ?? (panel.updatedBy?.type === "agent" ? t("anAgent") : panel.updatedBy ? t("someone") : null);
    const stale = viewStaleness({ lastAt: panel.updatedAt, since: since ?? panel.updatedAt ?? "", refreshEveryMinutes }, nowMs);
    const scrolls = panel.type === "table" || panel.type === "list" || panel.type === "markdown";
    return (
        <section
            aria-labelledby={`panel-${panel.id}`}
            className={cn("flex min-w-0 flex-col rounded-2xl border border-border bg-card p-4", COL_SPAN[panel.w] ?? "md:col-span-6", ROW_SPAN[panel.h] ?? "md:row-span-2")}
        >
            <header className="mb-2 flex min-w-0 items-start gap-2">
                <div className="min-w-0 flex-1">
                    <h2 id={`panel-${panel.id}`} className="truncate text-sm font-semibold text-foreground">{panel.title}</h2>
                    {panel.subtitle && <p className="truncate text-xs text-muted-foreground">{panel.subtitle}</p>}
                </div>
                {onAsk && (
                    <button type="button" onClick={() => onAsk(panel)} title={t("askTitle")} aria-label={t("askLabel", { title: panel.title })}
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                        <IconMessageQuestion className="h-4 w-4" aria-hidden />
                    </button>
                )}
            </header>
            <div className={cn("min-h-0 min-w-0 flex-1", scrolls && "max-h-[420px] overflow-auto md:max-h-none")}>
                {panel.data ? <PanelBody type={panel.type} data={panel.data} height={panel.h * ROW_PX} /> : (
                    <p className="text-sm text-muted-foreground">{t("noData")}</p>
                )}
            </div>
            <footer className={cn("mt-2 truncate text-[11px]", stale.overdue ? "font-medium text-amber-400" : "text-muted-foreground")} title={panel.updatedAt ?? undefined} suppressHydrationWarning>
                {stale.overdue && t("overduePrefix")}
                {panel.updatedAt ? (by ? t("updatedBy", { ago: formatAgo(panel.updatedAt, nowMs), by }) : t("updated", { ago: formatAgo(panel.updatedAt, nowMs) })) : t("waitingFirstUpdate")}
            </footer>
        </section>
    );
}

function PanelBody({ type, data, height }: { type: ViewPanelLayout["type"]; data: ViewPanelData; height: number }) {
    switch (type) {
        case "metric": return <MetricBody data={data as MetricPanelData} />;
        case "line":
        case "bar": return <ChartBody type={type} data={data as ChartPanelData} height={height} />;
        case "table": return <TableBody data={data as TablePanelData} />;
        case "list": return <ListBody data={data as ListPanelData} />;
        case "markdown": return <MarkdownRenderer content={(data as MarkdownPanelData).text} density="compact" allowWidgets={false} allowImages={false} isLinkAllowed={isSafeViewHref} className="text-sm" />;
        case "progress": return <ProgressBody data={data as ProgressPanelData} />;
        default: return null;
    }
}

function MetricBody({ data }: { data: MetricPanelData }) {
    const value = typeof data.value === "number" ? formatChartValue(data.value, "", data.unit ?? "", Math.abs(data.value) >= 100_000) : `${data.value}${data.unit ? ` ${data.unit}` : ""}`;
    const direction = Array.isArray(data.trend) || data.trend === undefined
        ? (data.delta === undefined ? null : data.delta > 0 ? "up" : data.delta < 0 ? "down" : "flat")
        : data.trend;
    const good = direction === "flat" || direction === null ? null : direction === (data.goodDirection ?? "up");
    const Arrow = direction === "up" ? IconArrowUpRight : direction === "down" ? IconArrowDownRight : IconArrowRight;
    const tone = good === null ? "bg-zinc-500/12 text-muted-foreground ring-zinc-500/20" : good ? "bg-emerald-500/12 text-emerald-500 ring-emerald-500/25" : "bg-rose-500/12 text-rose-500 ring-rose-500/25";
    return (
        <div className="flex h-full flex-col justify-between gap-2">
            <div className="flex items-end justify-between gap-3">
                <div className="min-w-0 truncate text-3xl font-semibold leading-tight tracking-tight text-foreground tabular-nums">{value}</div>
                {Array.isArray(data.trend) && (
                    <div className="flex min-w-0 flex-1 justify-end">
                        <Sparkline values={data.trend} color={good === false ? "var(--chart-5)" : "var(--chart-2)"} />
                    </div>
                )}
            </div>
            {(data.delta !== undefined || data.deltaLabel || direction) && (
                <div className="flex min-w-0 items-center gap-2 text-xs">
                    {(data.delta !== undefined || direction) && (
                        <span className={cn("inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 font-medium ring-1 ring-inset tabular-nums", tone)}>
                            <Arrow className="h-3 w-3" aria-hidden />
                            {data.delta !== undefined && `${data.delta > 0 ? "+" : ""}${formatChartValue(data.delta)}`}
                        </span>
                    )}
                    {data.deltaLabel && <span className="truncate text-muted-foreground">{data.deltaLabel}</span>}
                </div>
            )}
        </div>
    );
}

/** {series: [{name, points: [{x, y}]}]} as the shared chart's labels × values. */
export function toChartSpec(type: "line" | "bar", data: ChartPanelData, height: number): ChartSpec {
    const seen = new Map<string, number | string>();
    for (const series of data.series) for (const point of series.points) if (!seen.has(String(point.x))) seen.set(String(point.x), point.x);
    let keys = [...seen.keys()];
    if ([...seen.values()].every((x) => typeof x === "number")) keys = keys.sort((a, b) => Number(a) - Number(b));
    const index = new Map(keys.map((key, i) => [key, i]));
    return {
        type,
        labels: keys,
        series: data.series.map((series) => {
            const values = new Array<number>(keys.length).fill(0);
            for (const point of series.points) values[index.get(String(point.x))!] = point.y;
            return { name: series.name, data: values };
        }),
        stacked: Boolean(data.stacked),
        horizontal: false,
        unit: data.unit,
        height: Math.max(150, Math.min(640, height - 88)),
        explicitHeight: true,
    };
}

/** The height a chart may fill: its box on md+ (panels share a row's height), else the panel's nominal size. */
function useBoxHeight<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, number] {
    const ref = useRef<T | null>(null);
    const [height, setHeight] = useState(fallback);
    useLayoutEffect(() => {
        const el = ref.current;
        if (!el || typeof ResizeObserver === "undefined") return;
        const update = () => {
            const box = Math.floor(el.getBoundingClientRect().height);
            setHeight(window.matchMedia("(min-width: 768px)").matches && box > 0 ? box : fallback);
        };
        update();
        const observer = new ResizeObserver(update);
        observer.observe(el);
        return () => observer.disconnect();
    }, [fallback]);
    return [ref, height];
}

function NoPoints() {
    const t = useTranslations("views.panel");
    return <p className="text-sm text-muted-foreground">{t("noPoints")}</p>;
}

function ChartBody({ type, data, height }: { type: "line" | "bar"; data: ChartPanelData; height: number }) {
    const [ref, width] = useWidth<HTMLDivElement>(480);
    const [boxRef, box] = useBoxHeight<HTMLDivElement>(height - 88);
    const multi = data.series.length > 1;
    // Room for the axis caption and the legend under the plot.
    const plotHeight = Math.max(150, Math.min(640, box - (data.yLabel || data.xLabel ? 20 : 0) - (multi ? 30 : 0)));
    const spec = useMemo(() => ({ ...toChartSpec(type, data, height), height: plotHeight }), [type, data, height, plotHeight]);
    if (spec.labels.length === 0) return <NoPoints />;
    return (
        <div ref={boxRef} className="h-full min-h-0 w-full">
        <div ref={ref} className="w-full min-w-0">
            {(data.yLabel || data.xLabel) && (
                <div className="mb-1 flex justify-between text-[11px] text-muted-foreground">
                    <span>{data.yLabel}</span>
                    <span>{data.xLabel}</span>
                </div>
            )}
            <CartesianChart spec={spec} width={width} />
            <Legend items={spec.series.map((s, i) => ({ name: s.name, color: seriesColor(spec, i) }))} />
        </div>
        </div>
    );
}

function formatCell(value: unknown, column: TablePanelData["columns"][number], yesNo: { yes: string; no: string }): string {
    if (value === null || value === undefined || value === "") return "—";
    if (typeof value === "boolean") return value ? yesNo.yes : yesNo.no;
    if (typeof value === "number") {
        switch (column.format) {
            case "integer": return Math.round(value).toLocaleString("en-US");
            case "percent": return `${value.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
            case "currency":
                try {
                    return value.toLocaleString("en-US", { style: "currency", currency: column.currency ?? "USD", maximumFractionDigits: 2 });
                } catch {
                    return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
                }
            default: return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
        }
    }
    if (column.format === "date" && /^\d{4}-\d{2}-\d{2}/.test(value as string)) {
        const date = new Date(value as string);
        // UTC: a date-only value must read the same on the server and in every browser time zone.
        if (!Number.isNaN(date.getTime())) return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    }
    return String(value);
}

const ALIGN = { left: "text-left", right: "text-right", center: "text-center" } as const;

function TableBody({ data }: { data: TablePanelData }) {
    const t = useTranslations("views.panel");
    const yesNo = { yes: t("yes"), no: t("no") };
    const alignOf = (column: TablePanelData["columns"][number]): keyof typeof ALIGN => column.align
        ?? (column.format && ["number", "integer", "percent", "currency"].includes(column.format) ? "right" : "left");
    if (data.rows.length === 0) return <p className="text-sm text-muted-foreground">{t("noRows")}</p>;
    return (
        <table className="w-full min-w-max border-collapse text-sm">
            <thead className="sticky top-0 bg-card">
                <tr className="border-b border-border">
                    {data.columns.map((column) => (
                        <th key={column.key} scope="col" className={cn("px-2 py-1.5 text-xs font-medium text-muted-foreground", ALIGN[alignOf(column)])}>{column.label}</th>
                    ))}
                </tr>
            </thead>
            <tbody>
                {data.rows.map((row, i) => (
                    <tr key={i} className="border-b border-border/60 last:border-0">
                        {data.columns.map((column) => (
                            <td key={column.key} className={cn("px-2 py-1.5 text-foreground", ALIGN[alignOf(column)], alignOf(column) === "right" && "tabular-nums")}>
                                {formatCell(row[column.key], column, yesNo)}
                            </td>
                        ))}
                    </tr>
                ))}
            </tbody>
        </table>
    );
}

function ItemLink({ href, children }: { href: string | undefined; children: React.ReactNode }) {
    // Validated on write; checked again here so a stored row can never become a script link.
    if (!href || !isSafeViewHref(href)) return <>{children}</>;
    if (href.startsWith("/")) return <Link href={href} className="hover:underline">{children}</Link>;
    return <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="hover:underline">{children}</a>;
}

function ListBody({ data }: { data: ListPanelData }) {
    const t = useTranslations("views.panel");
    if (data.items.length === 0) return <p className="text-sm text-muted-foreground">{t("nothingHere")}</p>;
    return (
        <ul className="divide-y divide-border/60">
            {data.items.map((item, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3 py-1.5">
                    <span className="min-w-0">
                        <span className="block truncate text-sm text-foreground"><ItemLink href={item.href}>{item.title}</ItemLink></span>
                        {item.subtitle && <span className="block truncate text-xs text-muted-foreground">{item.subtitle}</span>}
                    </span>
                    {item.value !== undefined && (
                        <span className="shrink-0 text-sm font-medium text-foreground tabular-nums">
                            {typeof item.value === "number" ? formatChartValue(item.value) : item.value}
                        </span>
                    )}
                </li>
            ))}
        </ul>
    );
}

function ProgressBody({ data }: { data: ProgressPanelData }) {
    const t = useTranslations("views.panel");
    const share = Math.max(0, Math.min(1, data.value / data.max));
    const unit = data.unit ?? "";
    return (
        <div className="flex h-full flex-col justify-center gap-2">
            <div className="flex items-baseline justify-between gap-3">
                <span className="text-2xl font-semibold text-foreground tabular-nums">{Math.round(share * 100)}%</span>
                <span className="truncate text-xs text-muted-foreground tabular-nums">
                    {t("progressOf", { value: formatChartValue(data.value, "", unit, true), max: formatChartValue(data.max, "", unit, true) })}
                </span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round(share * 100)} aria-valuemin={0} aria-valuemax={100} aria-label={data.label ?? t("progress")}>
                <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
            </div>
            {data.label && <p className="truncate text-xs text-muted-foreground">{data.label}</p>}
        </div>
    );
}
