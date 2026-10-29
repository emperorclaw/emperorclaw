"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
import {
    IconArrowUpRight,
    IconChartHistogram,
    IconChevronRight,
    IconLoader2,
    IconRefresh,
} from "@tabler/icons-react";
import { RunStatusChip } from "@/components/run-status-chip";
import { RunTimeline } from "@/components/run-timeline";
import { cacheHitPercent } from "@/lib/live-activity";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/team-scene";
import {
    buildDailyWindow,
    buildRunsQuery,
    formatRunDuration,
    formatRunTokens,
    runThreadLink,
    summarizeRunDaily,
    type RunDailyDay,
} from "@/lib/run-ledger-copy";

/**
 * Agent → Runs: the run ledger's user-facing side. Reads the read-only ledger
 * endpoint (`GET /api/agents/[id]/runs`) — a 30-day chart from `agent_run_daily`,
 * headline stats, and a status-filtered, cursor-paginated list of recent runs.
 * Nothing here writes; the server closes lost runs and rolls up days itself.
 */

const RUNS_WINDOW_DAYS = 30;

interface AgentRunRow {
    id: string;
    agentId: string | null;
    runtimeId: string | null;
    runtimeKind: string | null;
    status: string;
    triggerKind: string;
    triggerMessageId: string | null;
    threadId: string | null;
    threadType: string | null;
    startedAt: string;
    durationMs: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    costCents: number | null;
    toolCalls: number | null;
    error: string | null;
    // 0.9 run usage (run-usage: 2); null for older runtimes.
    cacheReadTokens?: number | null;
    model?: string | null;
    queueMs?: number | null;
    firstTokenMs?: number | null;
    exitReason?: string | null;
}

type DailyRow = RunDailyDay;

interface RunsResponse {
    runs?: AgentRunRow[];
    nextCursor?: string | null;
    daily?: DailyRow[];
}

/** Labelled by agents.runs.filters.<key>. */
const STATUS_FILTERS = [
    { value: "", key: "all" },
    { value: "failed", key: "failed" },
    { value: "timeout", key: "timeout" },
    { value: "lost", key: "lost" },
] as const;

const TRIGGER_KINDS = new Set(["message", "task", "objective", "other"]);

/** Trigger kind → label (lib/run-ledger-copy.ts triggerKindLabel, translated). */
function useTriggerKindLabel() {
    const t = useTranslations("agents.runs.triggers");
    return (kind: string | null | undefined) => kind && TRIGGER_KINDS.has(kind) ? t(kind as "task") : kind || t("unknown");
}

export function AgentRunsTab({ agentId }: { agentId: string }) {
    const t = useTranslations("agents.runs");
    const [filter, setFilter] = useState("");
    const [runs, setRuns] = useState<AgentRunRow[]>([]);
    const [daily, setDaily] = useState<DailyRow[]>([]);
    const [cursor, setCursor] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        fetch(`/api/agents/${encodeURIComponent(agentId)}/runs?${buildRunsQuery({ status: filter })}`)
            .then(async (res) => {
                if (!res.ok) throw new Error("runs");
                return (await res.json()) as RunsResponse;
            })
            .then((data) => {
                if (cancelled) return;
                setRuns(data.runs ?? []);
                setDaily(data.daily ?? []);
                setCursor(data.nextCursor ?? null);
            })
            .catch(() => {
                if (!cancelled) setError(t("loadFailed"));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [agentId, filter, t]);

    const loadMore = useCallback(async () => {
        if (!cursor || loadingMore) return;
        setLoadingMore(true);
        try {
            const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/runs?${buildRunsQuery({ cursor, status: filter })}`);
            if (!res.ok) throw new Error("more");
            const data = (await res.json()) as RunsResponse;
            setRuns((prev) => [...prev, ...(data.runs ?? [])]);
            setCursor(data.nextCursor ?? null);
        } catch {
            setError(t("loadMoreFailed"));
        } finally {
            setLoadingMore(false);
        }
    }, [agentId, cursor, filter, loadingMore, t]);

    const summary = useMemo(() => summarizeRunDaily(daily), [daily]);
    const hasAnyData = runs.length > 0 || daily.length > 0;

    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <IconChartHistogram className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                    <h3 className="text-sm font-medium text-zinc-200">{t("title")}</h3>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">{t("last30Days")}</span>
                </div>
            </div>

            {loading ? (
                <p className="flex items-center gap-2 text-xs text-zinc-500">
                    <IconLoader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    {t("loading")}
                </p>
            ) : error && !hasAnyData ? (
                <p className="text-xs text-amber-400" role="alert">{error}</p>
            ) : !hasAnyData ? (
                <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center">
                    <IconChartHistogram className="mx-auto mb-2 h-6 w-6 text-zinc-600" aria-hidden="true" />
                    <p className="text-xs text-zinc-400">{t("emptyTitle")}</p>
                    <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-zinc-500">
                        {t("emptyHint")}
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    <HeadlineStats summary={summary} />
                    <RunChart daily={daily} />
                    <div className="flex flex-wrap gap-2" role="group" aria-label={t("filterLabel")}>
                        {STATUS_FILTERS.map((item) => (
                            <button
                                key={item.key}
                                type="button"
                                aria-pressed={filter === item.value}
                                onClick={() => setFilter(item.value)}
                                className={cn(
                                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
                                    filter === item.value
                                        ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
                                        : "border-zinc-800 text-zinc-400 hover:border-zinc-700 hover:text-zinc-100",
                                )}
                            >
                                {t(`filters.${item.key}`)}
                            </button>
                        ))}
                    </div>

                    {runs.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center">
                            <p className="text-[11px] text-zinc-500">
                                {filter ? t("noFilteredRuns", { status: t(`filters.${STATUS_FILTERS.find((item) => item.value === filter)?.key ?? "all"}`).toLowerCase() }) : t("noRuns")}
                            </p>
                        </div>
                    ) : (
                        <>
                            <RunTable runs={runs} />
                            <RunCards runs={runs} />
                        </>
                    )}

                    {cursor && (
                        <div className="flex justify-center">
                            <button
                                type="button"
                                onClick={() => void loadMore()}
                                disabled={loadingMore}
                                className="rounded-full border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:border-cyan-500/40 hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {loadingMore ? t("loadingMore") : t("loadOlder")}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function HeadlineStats({ summary }: { summary: ReturnType<typeof summarizeRunDaily> }) {
    const t = useTranslations("agents.runs.stats");
    const format = useFormatter();
    const items: { label: string; value: string }[] = [
        { label: t("runs"), value: format.number(summary.runs) },
        { label: t("successRate"), value: summary.successRate === null ? "—" : `${Math.round(summary.successRate * 100)}%` },
        { label: t("p50p95"), value: `${formatRunDuration(summary.p50Ms)} / ${formatRunDuration(summary.p95Ms)}` },
        { label: t("tokens"), value: formatRunTokens(summary.inputTokens, summary.outputTokens) },
        { label: t("cost"), value: formatCents(summary.costCents) ?? "—" },
        { label: t("toolCalls"), value: format.number(summary.toolCalls) },
    ];
    return (
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
            {items.map((item) => (
                <div key={item.label} className="min-w-0">
                    <dt className="truncate text-[10px] uppercase tracking-wider text-zinc-500">{item.label}</dt>
                    <dd className="truncate text-sm font-semibold tabular-nums text-zinc-100">{item.value}</dd>
                </div>
            ))}
        </dl>
    );
}

function RunChart({ daily }: { daily: DailyRow[] }) {
    const t = useTranslations("agents.runs.chart");
    const days = useMemo(() => buildDailyWindow(daily, RUNS_WINDOW_DAYS), [daily]);
    const max = Math.max(1, ...days.map((d) => d.succeeded + d.unsuccessful));
    const totals = days.reduce(
        (acc, d) => ({ succeeded: acc.succeeded + d.succeeded, unsuccessful: acc.unsuccessful + d.unsuccessful }),
        { succeeded: 0, unsuccessful: 0 },
    );
    const hasBars = totals.succeeded + totals.unsuccessful > 0;
    const zeroRunDays = days.filter((d) => d.hasData && d.succeeded + d.unsuccessful === 0).length;

    return (
        <figure className="space-y-2">
            <figcaption className="sr-only">{t("caption")}</figcaption>
            <div className="flex h-24 items-end gap-[3px]" aria-hidden="true">
                {days.map((day) => {
                    const total = day.succeeded + day.unsuccessful;
                    const title = total > 0
                        ? t("dayTotals", { day: day.day, succeeded: day.succeeded, unsuccessful: day.unsuccessful })
                        : day.hasData
                            ? t("dayNoRuns", { day: day.day })
                            : t("dayNoData", { day: day.day });
                    return (
                        <div
                            key={day.day}
                            className="flex h-full min-w-0 flex-1 flex-col justify-end gap-px"
                            title={title}
                        >
                            {day.unsuccessful > 0 && (
                                <span
                                    className="w-full rounded-t-[2px] bg-rose-500/70"
                                    style={{ height: `${(day.unsuccessful / max) * 100}%` }}
                                />
                            )}
                            {day.succeeded > 0 && (
                                <span
                                    className="w-full rounded-b-[2px] bg-emerald-500/70"
                                    style={{ height: `${(day.succeeded / max) * 100}%` }}
                                />
                            )}
                            {total === 0 && day.hasData && <span className="h-0.5 w-full rounded-full bg-zinc-700" />}
                            {total === 0 && !day.hasData && <span className="h-0.5 w-full rounded-full bg-zinc-900" />}
                        </div>
                    );
                })}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-zinc-500">
                <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-emerald-500/70" aria-hidden="true" />
                    {t("succeeded", { count: totals.succeeded })}
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-rose-500/70" aria-hidden="true" />
                    {t("unsuccessful", { count: totals.unsuccessful })}
                </span>
                {zeroRunDays > 0 && (
                    <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-sm bg-zinc-700" aria-hidden="true" />
                        {t("zeroRunDays", { count: zeroRunDays })}
                    </span>
                )}
                <span className="text-zinc-600">
                    {hasBars ? t("peak", { count: max }) : t("noRollups")}
                </span>
            </div>
        </figure>
    );
}

/** "Oct 29, 14:05" in the person's language. */
function useFormatRunTime() {
    const format = useFormatter();
    return (iso: string): string => {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "—";
        return format.dateTime(date, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    };
}

function TriggerCell({ run }: { run: AgentRunRow }) {
    const t = useTranslations("agents.runs");
    const triggerKindLabel = useTriggerKindLabel();
    const label = triggerKindLabel(run.triggerKind);
    const href = runThreadLink(run);
    if (href) {
        return (
            <Link
                href={href}
                className="inline-flex items-center gap-1 rounded text-cyan-300 transition-colors hover:text-cyan-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            >
                {label}
                <IconArrowUpRight className="h-3 w-3 shrink-0" aria-hidden="true" />
                <span className="sr-only">{t("openThread")}</span>
            </Link>
        );
    }
    return <span className="text-zinc-300">{label}</span>;
}

function cacheLabel(run: AgentRunRow): string {
    const hit = cacheHitPercent(run.inputTokens, run.cacheReadTokens);
    return hit == null ? "—" : `${hit}%`;
}

function msLabel(ms: number | null | undefined): string {
    return ms == null ? "—" : formatRunDuration(ms);
}

function ExpandButton({ open, onClick }: { open: boolean; onClick: () => void }) {
    const t = useTranslations("agents.runs");
    return (
        <button
            type="button"
            onClick={onClick}
            aria-expanded={open}
            aria-label={open ? t("hideRunSteps") : t("showRunSteps")}
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 transition-colors hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
        >
            <IconChevronRight className={cn("h-3.5 w-3.5 transition-transform", open && "rotate-90")} aria-hidden="true" />
        </button>
    );
}

function useExpanded() {
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const toggle = useCallback((id: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);
    return { expanded, toggle };
}

function RunTable({ runs }: { runs: AgentRunRow[] }) {
    const t = useTranslations("agents.runs");
    const formatRunTime = useFormatRunTime();
    const { expanded, toggle } = useExpanded();
    return (
        <div className="overflow-x-auto">
            <table className="hidden w-full border-collapse text-left text-xs sm:table">
                <caption className="sr-only">{t("tableCaption")}</caption>
                <thead>
                    <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                        <th scope="col" className="py-2 pr-3 font-medium">{t("columns.time")}</th>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("columns.trigger")}</th>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("columns.status")}</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">{t("columns.duration")}</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">{t("columns.tokens")}</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">{t("columns.tools")}</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium" title={t("columns.queueHint")}>{t("columns.queue")}</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium" title={t("columns.firstTokenHint")}>{t("columns.firstToken")}</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium" title={t("columns.cacheHint")}>{t("columns.cache")}</th>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("columns.model")}</th>
                        <th scope="col" className="py-2 pr-3 font-medium">{t("columns.exit")}</th>
                        <th scope="col" className="py-2 font-medium">{t("columns.error")}</th>
                    </tr>
                </thead>
                <tbody>
                    {runs.map((run) => (
                        <Fragment key={run.id}>
                        <tr className={cn("align-top", expanded.has(run.id) ? "" : "border-b border-zinc-800/60")}>
                            <td className="whitespace-nowrap py-2 pr-3 text-zinc-400">
                                <span className="inline-flex items-center gap-1">
                                    <ExpandButton open={expanded.has(run.id)} onClick={() => toggle(run.id)} />
                                    {formatRunTime(run.startedAt)}
                                </span>
                            </td>
                            <td className="py-2 pr-3"><TriggerCell run={run} /></td>
                            <td className="py-2 pr-3"><RunStatusChip status={run.status} /></td>
                            <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{formatRunDuration(run.durationMs)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{formatRunTokens(run.inputTokens, run.outputTokens)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{run.toolCalls ?? "—"}</td>
                            <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums text-zinc-300">{msLabel(run.queueMs)}</td>
                            <td className="whitespace-nowrap py-2 pr-3 text-right tabular-nums text-zinc-300">{msLabel(run.firstTokenMs)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{cacheLabel(run)}</td>
                            <td className="max-w-[10rem] py-2 pr-3 text-zinc-400"><span className="block truncate" title={run.model ?? undefined}>{run.model || "—"}</span></td>
                            <td className="max-w-[10rem] py-2 pr-3 text-zinc-400"><span className="block truncate" title={run.exitReason ?? undefined}>{run.exitReason || "—"}</span></td>
                            <td className="max-w-[16rem] py-2 text-rose-300">
                                {run.error ? <span className="line-clamp-2 break-words">{run.error}</span> : <span className="text-zinc-600">—</span>}
                            </td>
                        </tr>
                        {expanded.has(run.id) && (
                            <tr className="border-b border-zinc-800/60">
                                <td colSpan={12} className="pb-3 pl-7 pr-3">
                                    <RunTimeline runId={run.id} />
                                </td>
                            </tr>
                        )}
                        </Fragment>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function RunCards({ runs }: { runs: AgentRunRow[] }) {
    const t = useTranslations("agents.runs");
    const formatRunTime = useFormatRunTime();
    const { expanded, toggle } = useExpanded();
    return (
        <ul className="space-y-2 sm:hidden">
            {runs.map((run) => (
                <li key={run.id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] text-zinc-400">{formatRunTime(run.startedAt)}</span>
                        <RunStatusChip status={run.status} />
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                        <div className="flex min-w-0 justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.trigger")}</dt>
                            <dd className="min-w-0 truncate text-zinc-300"><TriggerCell run={run} /></dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.duration")}</dt>
                            <dd className="tabular-nums text-zinc-300">{formatRunDuration(run.durationMs)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.tokens")}</dt>
                            <dd className="tabular-nums text-zinc-300">{formatRunTokens(run.inputTokens, run.outputTokens)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.tools")}</dt>
                            <dd className="tabular-nums text-zinc-300">{run.toolCalls ?? "—"}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.queue")}</dt>
                            <dd className="tabular-nums text-zinc-300">{msLabel(run.queueMs)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.firstToken")}</dt>
                            <dd className="tabular-nums text-zinc-300">{msLabel(run.firstTokenMs)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.cache")}</dt>
                            <dd className="tabular-nums text-zinc-300">{cacheLabel(run)}</dd>
                        </div>
                        <div className="flex min-w-0 justify-between gap-2">
                            <dt className="text-zinc-500">{t("columns.model")}</dt>
                            <dd className="min-w-0 truncate text-zinc-300">{run.model || "—"}</dd>
                        </div>
                        {run.exitReason && (
                            <div className="col-span-2 flex min-w-0 justify-between gap-2">
                                <dt className="text-zinc-500">{t("columns.exit")}</dt>
                                <dd className="min-w-0 truncate text-zinc-300" title={run.exitReason}>{run.exitReason}</dd>
                            </div>
                        )}
                    </dl>
                    {run.error && <p className="mt-1.5 break-words text-[11px] text-rose-300">{run.error}</p>}
                    <button
                        type="button"
                        onClick={() => toggle(run.id)}
                        aria-expanded={expanded.has(run.id)}
                        className="mt-2 inline-flex min-h-9 items-center gap-1 text-[11px] text-zinc-400 transition-colors hover:text-cyan-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
                    >
                        <IconChevronRight className={cn("h-3.5 w-3.5 transition-transform", expanded.has(run.id) && "rotate-90")} aria-hidden="true" />
                        {expanded.has(run.id) ? t("hideSteps") : t("showSteps")}
                    </button>
                    {expanded.has(run.id) && (
                        <div className="mt-1.5 rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2">
                            <RunTimeline runId={run.id} />
                        </div>
                    )}
                </li>
            ))}
        </ul>
    );
}
