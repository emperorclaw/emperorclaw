"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    IconArrowUpRight,
    IconChartHistogram,
    IconLoader2,
    IconRefresh,
} from "@tabler/icons-react";
import { RunStatusChip } from "@/components/run-status-chip";
import { cn } from "@/lib/utils";
import { formatCents } from "@/lib/team-scene";
import {
    buildDailyWindow,
    buildRunsQuery,
    formatRunDuration,
    formatRunTokens,
    runThreadLink,
    summarizeRunDaily,
    triggerKindLabel,
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
}

type DailyRow = RunDailyDay;

interface RunsResponse {
    runs?: AgentRunRow[];
    nextCursor?: string | null;
    daily?: DailyRow[];
}

const STATUS_FILTERS = [
    { value: "", label: "All" },
    { value: "failed", label: "Failed" },
    { value: "timeout", label: "Timeout" },
    { value: "lost", label: "Lost" },
] as const;

export function AgentRunsTab({ agentId }: { agentId: string }) {
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
                if (!res.ok) throw new Error("Could not load runs");
                return (await res.json()) as RunsResponse;
            })
            .then((data) => {
                if (cancelled) return;
                setRuns(data.runs ?? []);
                setDaily(data.daily ?? []);
                setCursor(data.nextCursor ?? null);
            })
            .catch(() => {
                if (!cancelled) setError("Could not load runs");
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [agentId, filter]);

    const loadMore = useCallback(async () => {
        if (!cursor || loadingMore) return;
        setLoadingMore(true);
        try {
            const res = await fetch(`/api/agents/${encodeURIComponent(agentId)}/runs?${buildRunsQuery({ cursor, status: filter })}`);
            if (!res.ok) throw new Error("Could not load more runs");
            const data = (await res.json()) as RunsResponse;
            setRuns((prev) => [...prev, ...(data.runs ?? [])]);
            setCursor(data.nextCursor ?? null);
        } catch {
            setError("Could not load more runs");
        } finally {
            setLoadingMore(false);
        }
    }, [agentId, cursor, filter, loadingMore]);

    const summary = useMemo(() => summarizeRunDaily(daily), [daily]);
    const hasAnyData = runs.length > 0 || daily.length > 0;

    return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <IconChartHistogram className="h-4 w-4 text-cyan-400" aria-hidden="true" />
                    <h3 className="text-sm font-medium text-zinc-200">Runs</h3>
                    <span className="text-[10px] uppercase tracking-wider text-zinc-500">Last 30 days</span>
                </div>
            </div>

            {loading ? (
                <p className="flex items-center gap-2 text-xs text-zinc-500">
                    <IconLoader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                    Loading runs…
                </p>
            ) : error && !hasAnyData ? (
                <p className="text-xs text-amber-400" role="alert">{error}</p>
            ) : !hasAnyData ? (
                <div className="rounded-lg border border-dashed border-zinc-800 p-6 text-center">
                    <IconChartHistogram className="mx-auto mb-2 h-6 w-6 text-zinc-600" aria-hidden="true" />
                    <p className="text-xs text-zinc-400">No runs recorded yet.</p>
                    <p className="mx-auto mt-1 max-w-md text-[11px] leading-relaxed text-zinc-500">
                        Once this agent&apos;s runtime reports its turns (bridge 0.2.0 and later), each turn
                        appears here with its trigger, duration, tokens and outcome. Update the bridge if
                        runs stay empty after the agent answers a message.
                    </p>
                </div>
            ) : (
                <div className="space-y-4">
                    <HeadlineStats summary={summary} />
                    <RunChart daily={daily} />
                    <div className="flex flex-wrap gap-2" role="group" aria-label="Filter runs by status">
                        {STATUS_FILTERS.map((item) => (
                            <button
                                key={item.value || "all"}
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
                                {item.label}
                            </button>
                        ))}
                    </div>

                    {runs.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-zinc-800 p-4 text-center">
                            <p className="text-[11px] text-zinc-500">
                                No {filter ? `${filter} ` : ""}runs in the last 30 days.
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
                                {loadingMore ? "Loading…" : "Load older runs"}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

function HeadlineStats({ summary }: { summary: ReturnType<typeof summarizeRunDaily> }) {
    const items: { label: string; value: string }[] = [
        { label: "Runs", value: summary.runs.toLocaleString("en-US") },
        { label: "Success rate", value: summary.successRate === null ? "—" : `${Math.round(summary.successRate * 100)}%` },
        { label: "p50 / p95", value: `${formatRunDuration(summary.p50Ms)} / ${formatRunDuration(summary.p95Ms)}` },
        { label: "Tokens", value: formatRunTokens(summary.inputTokens, summary.outputTokens) },
        { label: "Cost", value: formatCents(summary.costCents) ?? "—" },
        { label: "Tool calls", value: summary.toolCalls.toLocaleString("en-US") },
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
            <figcaption className="sr-only">Runs per day over the last 30 days, stacked by outcome.</figcaption>
            <div className="flex h-24 items-end gap-[3px]" aria-hidden="true">
                {days.map((day) => {
                    const total = day.succeeded + day.unsuccessful;
                    const title = total > 0
                        ? `${day.day}: ${day.succeeded} succeeded, ${day.unsuccessful} unsuccessful`
                        : day.hasData
                            ? `${day.day}: no runs`
                            : `${day.day}: no data`;
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
                    Succeeded: {totals.succeeded.toLocaleString("en-US")}
                </span>
                <span className="inline-flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-sm bg-rose-500/70" aria-hidden="true" />
                    Failed, timed out or lost: {totals.unsuccessful.toLocaleString("en-US")}
                </span>
                {zeroRunDays > 0 && (
                    <span className="inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-sm bg-zinc-700" aria-hidden="true" />
                        Recorded, no runs: {zeroRunDays.toLocaleString("en-US")} day{zeroRunDays === 1 ? "" : "s"}
                    </span>
                )}
                <span className="text-zinc-600">
                    {hasBars ? `Peak ${max.toLocaleString("en-US")} runs/day` : "No daily rollups yet"}
                </span>
            </div>
        </figure>
    );
}

function formatRunTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "—";
    return date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function TriggerCell({ run }: { run: AgentRunRow }) {
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
                <span className="sr-only"> — open the triggering thread</span>
            </Link>
        );
    }
    return <span className="text-zinc-300">{label}</span>;
}

function RunTable({ runs }: { runs: AgentRunRow[] }) {
    return (
        <div className="overflow-x-auto">
            <table className="hidden w-full border-collapse text-left text-xs sm:table">
                <caption className="sr-only">Recent runs, newest first</caption>
                <thead>
                    <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wider text-zinc-500">
                        <th scope="col" className="py-2 pr-3 font-medium">Time</th>
                        <th scope="col" className="py-2 pr-3 font-medium">Trigger</th>
                        <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Duration</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Tokens</th>
                        <th scope="col" className="py-2 pr-3 text-right font-medium">Tools</th>
                        <th scope="col" className="py-2 font-medium">Error</th>
                    </tr>
                </thead>
                <tbody>
                    {runs.map((run) => (
                        <tr key={run.id} className="border-b border-zinc-800/60 align-top last:border-0">
                            <td className="whitespace-nowrap py-2 pr-3 text-zinc-400">{formatRunTime(run.startedAt)}</td>
                            <td className="py-2 pr-3"><TriggerCell run={run} /></td>
                            <td className="py-2 pr-3"><RunStatusChip status={run.status} /></td>
                            <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{formatRunDuration(run.durationMs)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{formatRunTokens(run.inputTokens, run.outputTokens)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-zinc-300">{run.toolCalls ?? "—"}</td>
                            <td className="max-w-[16rem] py-2 text-rose-300">
                                {run.error ? <span className="line-clamp-2 break-words">{run.error}</span> : <span className="text-zinc-600">—</span>}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function RunCards({ runs }: { runs: AgentRunRow[] }) {
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
                            <dt className="text-zinc-500">Trigger</dt>
                            <dd className="min-w-0 truncate text-zinc-300"><TriggerCell run={run} /></dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">Duration</dt>
                            <dd className="tabular-nums text-zinc-300">{formatRunDuration(run.durationMs)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">Tokens</dt>
                            <dd className="tabular-nums text-zinc-300">{formatRunTokens(run.inputTokens, run.outputTokens)}</dd>
                        </div>
                        <div className="flex justify-between gap-2">
                            <dt className="text-zinc-500">Tools</dt>
                            <dd className="tabular-nums text-zinc-300">{run.toolCalls ?? "—"}</dd>
                        </div>
                    </dl>
                    {run.error && <p className="mt-1.5 break-words text-[11px] text-rose-300">{run.error}</p>}
                </li>
            ))}
        </ul>
    );
}
