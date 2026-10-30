"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
    IconAlertTriangle,
    IconBrain,
    IconChevronDown,
    IconCircleCheck,
    IconCircleX,
    IconInfoCircle,
    IconLoader2,
    IconPlayerStop,
    IconSparkles,
    IconTool,
    IconUsers,
} from "@tabler/icons-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCopy } from "@/lib/i18n/use-copy";
import { cn } from "@/lib/utils";
import { taskHref } from "@/lib/task-story";
import { formatRunDuration, formatTokenCount } from "@/lib/run-ledger-copy";
import {
    cacheHitPercent,
    liveUsageLine,
    runFooterSummary,
    timelineRows,
    type TimelineRow,
    type TimelineStep,
} from "@/lib/live-activity";
import type { RunLiveUsage } from "@/lib/run-events";

/**
 * A run's steps as a compact vertical list: tools (running, then done with
 * their duration), reasoning lines, notices (muted), compaction and turn ends.
 * Used live under the chat status row, behind an agent reply's footer, and in
 * the Agent → Runs tab. With `runId` and no `steps` it loads
 * `GET /api/runs/[runId]/events` once, on mount (so only when expanded).
 */

interface TimelineResponse {
    run: {
        status: string;
        durationMs: number | null;
        inputTokens: number | null;
        outputTokens: number | null;
        cacheReadTokens: number | null;
        costCents: number | null;
        toolCalls: number | null;
        model: string | null;
        exitReason?: string | null;
        queueMs: number | null;
        firstTokenMs: number | null;
        eventsDropped: number | null;
        error: string | null;
    };
    steps: TimelineStep[];
    usage: (RunLiveUsage & { costUsd: number | null }) | null;
    redacted: boolean;
}

function RowIcon({ row }: { row: TimelineRow }) {
    const cls = "mt-px h-3.5 w-3.5 shrink-0";
    if (row.status === "running") return <IconLoader2 className={cn(cls, "animate-spin text-cyan-400 motion-reduce:animate-none")} aria-hidden="true" />;
    switch (row.kind) {
        case "tool":
            if (row.status === "error") return <IconCircleX className={cn(cls, "text-rose-400")} aria-hidden="true" />;
            if (row.status === "interrupted") return <IconPlayerStop className={cn(cls, "text-amber-400")} aria-hidden="true" />;
            return <IconTool className={cn(cls, "text-emerald-400")} aria-hidden="true" />;
        case "reasoning":
            return <IconBrain className={cn(cls, "text-violet-300")} aria-hidden="true" />;
        case "notice":
            return <IconInfoCircle className={cn(cls, "text-zinc-600")} aria-hidden="true" />;
        case "compaction":
            return <IconSparkles className={cn(cls, "text-zinc-500")} aria-hidden="true" />;
        case "subagent":
            return <IconUsers className={cn(cls, "text-cyan-300")} aria-hidden="true" />;
        case "end":
            return row.status === "error"
                ? <IconAlertTriangle className={cn(cls, "text-rose-400")} aria-hidden="true" />
                : <IconPlayerStop className={cn(cls, "text-amber-400")} aria-hidden="true" />;
        default:
            return <IconCircleCheck className={cn(cls, "text-zinc-500")} aria-hidden="true" />;
    }
}

/** Pure list: no fetching, no timers. */
export const RunTimelineList = memo(function RunTimelineList({ steps, emptyText }: { steps: readonly TimelineStep[]; emptyText?: string }) {
    const t = useTranslations("runTimeline");
    const rows = useMemo(() => timelineRows(steps), [steps]);
    const render = useCopy();
    if (rows.length === 0) return <p className="text-[11px] text-zinc-500">{emptyText ?? t("noSteps")}</p>;
    return (
        <ol className="space-y-1" aria-label={t("steps")}>
            {rows.map((row) => (
                <li key={row.key} className="flex min-w-0 items-start gap-2 text-[11px] leading-snug">
                    <RowIcon row={row} />
                    <span className={cn("min-w-0 flex-1 break-words", row.kind === "notice" ? "text-zinc-500" : row.kind === "reasoning" ? "text-zinc-400" : "text-zinc-300")}>
                        <span className={cn(row.kind === "tool" && "font-mono font-medium text-zinc-200", row.kind === "notice" && "italic")}>{render(row.labelCopy, row.label)}</span>
                        {row.detail && <span className={cn(row.kind === "tool" ? "text-zinc-500" : "")}> · {row.detail}</span>}
                        {row.status === "error" && row.kind === "tool" && <span className="text-rose-400"> · {t("failed")}</span>}
                    </span>
                    {row.durationMs != null && (
                        <span className="shrink-0 font-mono tabular-nums text-[10px] text-zinc-500">{formatRunDuration(row.durationMs)}</span>
                    )}
                </li>
            ))}
        </ol>
    );
});

type Translate = ReturnType<typeof useTranslations<"runTimeline">>;

function usageSummary(data: TimelineResponse, t: Translate): string | null {
    const { run, usage } = data;
    const input = run.inputTokens ?? usage?.input ?? null;
    const output = run.outputTokens ?? usage?.output ?? null;
    const cacheRead = run.cacheReadTokens ?? usage?.cacheRead ?? null;
    const parts: string[] = [];
    if (input != null) parts.push(t("usage.in", { tokens: formatTokenCount(input) }));
    if (output != null) parts.push(t("usage.out", { tokens: formatTokenCount(output) }));
    const hit = cacheHitPercent(input, cacheRead);
    if (cacheRead != null && cacheRead > 0) parts.push(hit != null ? t("usage.cachedHit", { tokens: formatTokenCount(cacheRead), hit }) : t("usage.cached", { tokens: formatTokenCount(cacheRead) }));
    if (run.costCents != null) parts.push(`$${(run.costCents / 100).toFixed(2)}`);
    else if (usage?.costUsd != null) parts.push(`$${usage.costUsd.toFixed(2)}`);
    if (usage?.contextPercent != null && run.status === "running") parts.push(t("usage.context", { percent: usage.contextPercent }));
    return parts.length > 0 ? parts.join(" · ") : null;
}

function timingSummary(run: TimelineResponse["run"], t: Translate): string | null {
    const parts: string[] = [];
    if (run.queueMs != null) parts.push(t("timing.queued", { duration: formatRunDuration(run.queueMs) }));
    if (run.firstTokenMs != null) parts.push(t("timing.firstToken", { duration: formatRunDuration(run.firstTokenMs) }));
    if (run.model) parts.push(run.model);
    if (run.exitReason) parts.push(t("timing.exit", { reason: run.exitReason }));
    return parts.length > 0 ? parts.join(" · ") : null;
}

/** Loads one run's timeline on mount and renders it with its usage line. */
export function RunTimeline({ runId }: { runId: string }) {
    const t = useTranslations("runTimeline");
    const [data, setData] = useState<TimelineResponse | null>(null);
    const [error, setError] = useState<"notFound" | "loadFailed" | null>(null);

    useEffect(() => {
        let cancelled = false;
        fetch(`/api/runs/${encodeURIComponent(runId)}/events`, { cache: "no-store" })
            .then(async (res) => {
                if (!res.ok) throw new Error(res.status === 404 ? "notFound" : "loadFailed");
                return (await res.json()) as TimelineResponse;
            })
            .then((json) => { if (!cancelled) setData(json); })
            .catch((e: unknown) => { if (!cancelled) setError(e instanceof Error && e.message === "notFound" ? "notFound" : "loadFailed"); });
        return () => { cancelled = true; };
    }, [runId]);

    if (error) return <p className="text-[11px] text-amber-400" role="alert">{t(error)}</p>;
    if (!data) {
        return (
            <p className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                <IconLoader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t("loading")}
            </p>
        );
    }
    const usage = usageSummary(data, t);
    const timing = timingSummary(data.run, t);
    return (
        <div className="space-y-2">
            <RunTimelineList
                steps={data.steps}
                emptyText={data.redacted ? t("private") : t("noStepsBridge")}
            />
            {(usage || timing) && (
                <p className="break-words text-[10px] tabular-nums text-zinc-500">
                    {[usage, timing].filter(Boolean).join(" · ")}
                </p>
            )}
            {data.run.eventsDropped ? <p className="text-[10px] text-zinc-600">{t("dropped", { count: data.run.eventsDropped })}</p> : null}
            {data.run.error && <p className="break-words text-[11px] text-rose-300">{data.run.error}</p>}
        </div>
    );
}

/** The run behind one agent reply, as `/api/chat` returns it in `replyRuns`. */
export interface ReplyRun {
    runId: string;
    status: string;
    durationMs: number | null;
    toolCalls: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    model: string | null;
    /** Set when the run worked on a task: the expanded footer links to the task page. */
    taskId?: string | null;
}

/**
 * The collapsed footer under an agent reply ("Worked 42s · 6 tools · 18.2k
 * tokens · model"). Expanding it loads the run's timeline. Primitive-ish
 * props and memo keep chat polls from re-rendering it.
 */
export const ReplyRunFooter = memo(function ReplyRunFooter({ run, tone = "dark" }: { run: ReplyRun; tone?: "dark" | "light" }) {
    const t = useTranslations("runTimeline");
    const [open, setOpen] = useState(false);
    const toggle = useCallback(() => setOpen((value) => !value), []);
    const label = runFooterSummary(run);
    if (!label) return null;
    return (
        <div className="mt-1.5 min-w-0">
            <button
                type="button"
                onClick={toggle}
                aria-expanded={open}
                className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded text-left text-[10px] tabular-nums transition-colors focus-visible:outline-none focus-visible:ring-2",
                    tone === "light" ? "text-emerald-950/70 hover:text-emerald-950 focus-visible:ring-emerald-950/60" : "text-zinc-500 hover:text-zinc-300 focus-visible:ring-cyan-400/60",
                )}
            >
                <span className="truncate">{label}</span>
                <IconChevronDown className={cn("h-3 w-3 shrink-0 transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
            {open && (
                <div className="mt-1.5 space-y-2 rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-2">
                    <RunTimeline runId={run.runId} />
                    {run.taskId && (
                        <Link href={taskHref(run.taskId, run.runId)} className="inline-flex items-center gap-1 text-[11px] text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline">
                            {t("openOnTask")}
                        </Link>
                    )}
                </div>
            )}
        </div>
    );
});

/**
 * Live steps under the chat status row, behind a "Steps" toggle so the row
 * itself never changes height on its own.
 */
export const LiveRunSteps = memo(function LiveRunSteps({ steps, usage }: { steps: readonly TimelineStep[]; usage?: RunLiveUsage | null }) {
    const t = useTranslations("runTimeline");
    const [open, setOpen] = useState(false);
    const usageLine = liveUsageLine(usage);
    if (steps.length === 0 && !usageLine) return null;
    return (
        <div className="min-w-0">
            <button
                type="button"
                onClick={() => setOpen((value) => !value)}
                aria-expanded={open}
                className="inline-flex items-center gap-1 rounded text-[10px] text-zinc-500 transition-colors hover:text-zinc-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60"
            >
                {open ? t("hideSteps") : steps.length > 0 ? t("stepsCount", { count: steps.length }) : t("stepsToggle")}
                <IconChevronDown className={cn("h-3 w-3 transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>
            {open && (
                <div className="mt-1.5 space-y-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-2">
                    <RunTimelineList steps={steps} emptyText={t("noStepsYet")} />
                    {usageLine && <p className="text-[10px] tabular-nums text-zinc-500">{usageLine}</p>}
                </div>
            )}
        </div>
    );
});
