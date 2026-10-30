"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import { IconArrowDown, IconArrowUp, IconCoin, IconDownload, IconX } from "@tabler/icons-react";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import {
    COST_TABS,
    RANGE_PRESETS,
    estimatedShare,
    formatTokens,
    formatUsd,
    type CostDimension,
    type CostFilter,
    type CostGroup,
    type CostTab,
    type CostTotals,
    type RangePreset,
} from "@/lib/costs";

/** The range as the page passes it: inclusive YYYY-MM-DD bounds. */
export type RangeView = { preset: RangePreset; from: string; to: string; days: number };

function rangeParams(range: RangeView): URLSearchParams {
    const params = new URLSearchParams({ range: range.preset });
    if (range.preset === "custom") {
        params.set("from", range.from);
        params.set("to", range.to);
    }
    return params;
}

/** Tabs and date range presets (URL state: every view is a shareable link). */
export function CostsTabs({ active, range }: { active: CostTab; range: RangeView }) {
    const t = useTranslations("costs");
    return (
        <nav aria-label={t("views")} className="flex flex-wrap gap-1 border-b border-border">
            {COST_TABS.map((tab) => {
                const params = rangeParams(range);
                params.set("tab", tab);
                return (
                    <Link key={tab} href={`/costs?${params.toString()}`} aria-current={tab === active ? "page" : undefined}
                        className={cn("-mb-px inline-flex min-h-10 items-center border-b-2 px-3 text-sm transition-colors",
                            tab === active ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}>
                        {t(`tabs.${tab}`)}
                    </Link>
                );
            })}
        </nav>
    );
}

type GroupRow = CostGroup & { href: string | null };
type SortKey = "label" | "runs" | "tokens" | "costCents" | "share";


export function CostsClient({
    tab, dimension, range, filter, filterLabels, total, series, groups, exportHref, clearFilterHref, restricted,
}: {
    tab: CostTab;
    dimension: CostDimension;
    range: RangeView;
    filter: CostFilter;
    filterLabels: Partial<Record<keyof CostFilter, string>>;
    total: CostTotals;
    series: { day: string; costCents: number; runs: number }[];
    groups: GroupRow[];
    exportHref: string;
    clearFilterHref: string;
    restricted: boolean;
}) {
    const t = useTranslations("costs");
    const format = useFormatter();
    const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "costCents", desc: true });
    const sorted = useMemo(() => {
        const list = [...groups];
        list.sort((a, b) => {
            const diff = sort.key === "label" ? a.label.localeCompare(b.label) : (a[sort.key] as number) - (b[sort.key] as number);
            return sort.desc ? -diff : diff;
        });
        return list;
    }, [groups, sort]);

    const filters = (Object.keys(filterLabels) as (keyof CostFilter)[]).filter((key) => filter[key] !== undefined);

    const unpricedRuns = total.basis.unpriced.runs;

    return (
        <div className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <RangePicker tab={tab} range={range} filter={filter} />
                <a href={exportHref} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-sm text-foreground hover:bg-accent">
                    <IconDownload className="h-4 w-4" aria-hidden />{t("exportCsv")}
                </a>
            </div>

            {filters.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                    {filters.map((key) => (
                        <span key={key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1">
                            <span className="text-muted-foreground">{t("filterLabel", { noun: t(`columns.${key}`) })}</span>
                            <span className="font-medium text-foreground">{filterLabels[key]}</span>
                        </span>
                    ))}
                    {filter.project && !["chat", "unknown-task"].includes(filter.project) && (
                        <Link href={`/projects?project=${encodeURIComponent(filter.project)}`} className="text-primary hover:underline">{t("openBoard")}</Link>
                    )}
                    <Link href={clearFilterHref} className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground">
                        <IconX className="h-3.5 w-3.5" aria-hidden />{t("clear")}
                    </Link>
                </div>
            )}

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                <Stat label={t("stats.cost")} value={formatUsd(total.costCents)}
                    detail={t("stats.costDetail", { reported: formatUsd(total.basis.reported.costCents), estimated: formatUsd(total.basis.estimated.costCents) })} />
                <Stat label={t("stats.runs")} value={format.number(total.runs)} detail={t("stats.runsDetail", { days: range.days, from: range.from, to: range.to })} />
                <Stat label={t("stats.tokens")} value={formatTokens(total.tokens)} detail={t("stats.tokensDetail", { input: formatTokens(total.inputTokens), output: formatTokens(total.outputTokens) })} />
                <Stat label={t("stats.estimated")} value={`${Math.round(estimatedShare(total) * 100)}%`}
                    detail={unpricedRuns > 0 ? t("stats.unpriced", { count: unpricedRuns, runs: format.number(unpricedRuns), tokens: formatTokens(total.unpricedTokens) }) : t("stats.priced")} />
            </div>

            <DailyChart series={series} />

            <div className="overflow-hidden rounded-2xl border border-border bg-card">
                <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                        <thead>
                            <tr className="border-b border-border text-xs uppercase tracking-wider text-muted-foreground">
                                <SortHeader label={t(`columns.${dimension}`)} sortKey="label" sort={sort} onSort={setSort} align="left" />
                                <SortHeader label={t("stats.runs")} sortKey="runs" sort={sort} onSort={setSort} />
                                <SortHeader label={t("stats.tokens")} sortKey="tokens" sort={sort} onSort={setSort} />
                                <SortHeader label={t("stats.cost")} sortKey="costCents" sort={sort} onSort={setSort} />
                                <SortHeader label={t("share")} sortKey="share" sort={sort} onSort={setSort} />
                                <th scope="col" className="px-4 py-3 text-right font-medium">{t("basis")}</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-border">
                            {sorted.map((group) => (
                                <tr key={group.key} className="hover:bg-accent/40">
                                    <td className="max-w-[28rem] px-4 py-2.5">
                                        {group.href
                                            ? <Link href={group.href} className="font-medium text-foreground hover:text-primary">{group.label}</Link>
                                            : <span className={cn("font-medium", group.special ? "text-muted-foreground" : "text-foreground")}>{group.label}</span>}
                                        {group.detail && <div className="truncate text-xs text-muted-foreground">{group.detail}</div>}
                                    </td>
                                    <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">{format.number(group.runs)}</td>
                                    <td className="px-4 py-2.5 text-right font-mono text-xs text-muted-foreground">{formatTokens(group.tokens)}</td>
                                    <td className="px-4 py-2.5 text-right font-mono text-xs text-foreground">{formatUsd(group.costCents)}</td>
                                    <td className="px-4 py-2.5 text-right">
                                        <span className="inline-flex items-center justify-end gap-2">
                                            <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-muted sm:block" aria-hidden>
                                                <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.round(group.share * 100)}%` }} />
                                            </span>
                                            <span className="w-10 font-mono text-xs text-muted-foreground">{Math.round(group.share * 100)}%</span>
                                        </span>
                                    </td>
                                    <td className="px-4 py-2.5 text-right"><BasisChips totals={group} /></td>
                                </tr>
                            ))}
                        </tbody>
                        {sorted.length > 0 && (
                            <tfoot>
                                <tr className="border-t border-border text-xs font-medium text-foreground">
                                    <td className="px-4 py-2.5">{t("total")}</td>
                                    <td className="px-4 py-2.5 text-right font-mono">{format.number(total.runs)}</td>
                                    <td className="px-4 py-2.5 text-right font-mono">{formatTokens(total.tokens)}</td>
                                    <td className="px-4 py-2.5 text-right font-mono">{formatUsd(total.costCents)}</td>
                                    <td className="px-4 py-2.5 text-right font-mono text-muted-foreground">{total.costCents > 0 ? "100%" : "—"}</td>
                                    <td className="px-4 py-2.5" />
                                </tr>
                            </tfoot>
                        )}
                    </table>
                </div>
                {sorted.length === 0 && (
                    <EmptyState
                        bordered={false}
                        icon={IconCoin}
                        title={t("emptyTitle")}
                        description={restricted ? t("emptyRestricted") : t("emptyDescription")}
                    />
                )}
            </div>
            <p className="text-xs text-muted-foreground">
                {t("legend")}
            </p>
        </div>
    );
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
    return (
        <div className="rounded-2xl border border-border bg-card p-4">
            <div className="mb-1 text-xs uppercase tracking-wider text-muted-foreground">{label}</div>
            <div className="text-xl font-semibold text-foreground sm:text-2xl">{value}</div>
            <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
        </div>
    );
}

function BasisChips({ totals }: { totals: CostTotals }) {
    const t = useTranslations("costs.basisChips");
    const chips: { key: string; label: string; className: string; title: string }[] = [];
    if (totals.basis.reported.runs > 0) chips.push({ key: "reported", label: t("reported"), className: "border-border text-muted-foreground", title: t("costFrom", { cost: formatUsd(totals.basis.reported.costCents), runs: totals.basis.reported.runs }) });
    if (totals.basis.estimated.runs > 0) chips.push({ key: "estimated", label: t("estimated"), className: "border-amber-500/40 text-amber-600 dark:text-amber-300", title: t("costFrom", { cost: formatUsd(totals.basis.estimated.costCents), runs: totals.basis.estimated.runs }) });
    if (totals.basis.unpriced.runs > 0) chips.push({ key: "unpriced", label: t("unpriced"), className: "border-rose-500/40 text-rose-600 dark:text-rose-300", title: t("unpricedTitle", { runs: totals.basis.unpriced.runs, tokens: formatTokens(totals.unpricedTokens) }) });
    return (
        <span className="inline-flex flex-wrap justify-end gap-1">
            {chips.map((chip) => <span key={chip.key} title={chip.title} className={cn("rounded-full border px-2 py-0.5 text-[10px]", chip.className)}>{chip.label}</span>)}
        </span>
    );
}

function SortHeader({ label, sortKey, sort, onSort, align = "right" }: {
    label: string; sortKey: SortKey; sort: { key: SortKey; desc: boolean }; onSort: (s: { key: SortKey; desc: boolean }) => void; align?: "left" | "right";
}) {
    const active = sort.key === sortKey;
    return (
        <th scope="col" aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"} className={cn("px-4 py-3 font-medium", align === "left" ? "text-left" : "text-right")}>
            <button type="button" onClick={() => onSort({ key: sortKey, desc: active ? !sort.desc : sortKey !== "label" })}
                className={cn("inline-flex items-center gap-1 uppercase tracking-wider hover:text-foreground", active && "text-foreground")}>
                {label}
                {active && (sort.desc ? <IconArrowDown className="h-3 w-3" aria-hidden /> : <IconArrowUp className="h-3 w-3" aria-hidden />)}
            </button>
        </th>
    );
}

function RangePicker({ tab, range, filter }: { tab: CostTab; range: RangeView; filter: CostFilter }) {
    const t = useTranslations("costs");
    const [custom, setCustom] = useState(range.preset === "custom");
    const base = (preset: RangePreset) => {
        const params = new URLSearchParams({ tab, range: preset });
        for (const [key, value] of Object.entries(filter)) if (value !== undefined) params.set(key, value);
        return `/costs?${params.toString()}`;
    };
    return (
        <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex flex-wrap rounded-lg border border-border bg-card p-0.5" role="group" aria-label={t("dateRange")}>
                {RANGE_PRESETS.filter((preset) => preset !== "custom").map((preset) => (
                    <Link key={preset} href={base(preset)} aria-current={range.preset === preset ? "true" : undefined}
                        className={cn("rounded-md px-2.5 py-1 text-xs", range.preset === preset ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                        {t(`ranges.${preset}`)}
                    </Link>
                ))}
                <button type="button" onClick={() => setCustom((open) => !open)} aria-expanded={custom}
                    className={cn("rounded-md px-2.5 py-1 text-xs", range.preset === "custom" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}>
                    {t("ranges.custom")}
                </button>
            </div>
            {custom && (
                <form action="/costs" method="get" className="flex flex-wrap items-center gap-2 text-xs">
                    <input type="hidden" name="tab" value={tab} />
                    <input type="hidden" name="range" value="custom" />
                    {Object.entries(filter).map(([key, value]) => value !== undefined && <input key={key} type="hidden" name={key} value={value} />)}
                    <label className="flex items-center gap-1 text-muted-foreground">{t("from")}
                        <input type="date" name="from" defaultValue={range.from} required className="rounded-md border border-border bg-card px-2 py-1 text-foreground" />
                    </label>
                    <label className="flex items-center gap-1 text-muted-foreground">{t("to")}
                        <input type="date" name="to" defaultValue={range.to} required className="rounded-md border border-border bg-card px-2 py-1 text-foreground" />
                    </label>
                    <button type="submit" className="rounded-md border border-border bg-card px-2.5 py-1 text-foreground hover:bg-accent">{t("apply")}</button>
                </form>
            )}
        </div>
    );
}

/** Daily cost bars (inline SVG). Each bar carries its day, cost and runs as a tooltip. */
function DailyChart({ series }: { series: { day: string; costCents: number; runs: number }[] }) {
    const t = useTranslations("costs.chart");
    const max = Math.max(0, ...series.map((point) => point.costCents));
    const width = Math.max(series.length, 1) * 10;
    const height = 100;
    if (series.length === 0) return null;
    return (
        <figure className="rounded-2xl border border-border bg-card p-4">
            <figcaption className="mb-2 flex items-baseline justify-between text-xs text-muted-foreground">
                <span>{t("title")}</span>
                <span className="font-mono">{max > 0 ? t("max", { cost: formatUsd(max) }) : t("noCost")}</span>
            </figcaption>
            <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" className="h-28 w-full" role="img"
                aria-label={t("label", { from: series[0].day, to: series[series.length - 1].day })}>
                <line x1={0} x2={width} y1={height - 0.5} y2={height - 0.5} stroke="var(--border)" strokeWidth={1} vectorEffect="non-scaling-stroke" />
                {series.map((point, index) => {
                    const barHeight = max > 0 ? Math.max(point.costCents > 0 ? 1.5 : 0, (point.costCents / max) * (height - 4)) : 0;
                    return (
                        <g key={point.day}>
                            <rect x={index * 10} y={0} width={10} height={height} fill="transparent">
                                <title>{t("bar", { day: point.day, cost: formatUsd(point.costCents), runs: point.runs })}</title>
                            </rect>
                            {barHeight > 0 && (
                                <rect x={index * 10 + 1.5} y={height - barHeight} width={7} height={barHeight} rx={1} fill="var(--primary)" pointerEvents="none" />
                            )}
                        </g>
                    );
                })}
            </svg>
            <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
                <span>{series[0].day}</span>
                <span>{series[series.length - 1].day}</span>
            </div>
        </figure>
    );
}
