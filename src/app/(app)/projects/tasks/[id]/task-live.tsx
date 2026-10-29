"use client";

import { memo, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { IconLock } from "@tabler/icons-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { LiveRunSteps } from "@/components/run-timeline";
import {
    CHAT_POLL_MS,
    formatElapsed,
    isTimedStepKind,
    lastReasoningLine,
    mergeLiveRuns,
    type ClientLiveRun,
} from "@/lib/live-activity";
import { stallSignal, type StallSignal } from "@/lib/stall-signal";
import type { TaskLiveRun, TaskLiveView } from "@/lib/task-story-reads";
import { useLivePoll } from "@/lib/use-realtime";

/** Idle poll: a hidden tab does not poll at all; an idle task checks for a new run now and then. */
const TASK_IDLE_POLL_MS = 15_000;

const noopSubscribe = () => () => {};

/** The browser's time zone after hydration; "UTC" while server rendering (the server runs in UTC). */
export function useTimeZone(): string {
    return useSyncExternalStore(
        noopSubscribe,
        () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
        () => "UTC",
    );
}

/** A 1 s clock, 0 until mounted so server and first client render agree. */
export function useNow(intervalMs = 1000): number {
    const [now, setNow] = useState(0);
    useEffect(() => {
        const tick = () => setNow(Date.now());
        const first = setTimeout(tick, 0);
        const id = setInterval(tick, intervalMs);
        return () => {
            clearTimeout(first);
            clearInterval(id);
        };
    }, [intervalMs]);
    return now;
}

type LiveMeta = Omit<TaskLiveRun, "live">;

export interface TaskLiveState {
    runs: ClientLiveRun[];
    meta: Record<string, LiveMeta>;
    /** server clock − client clock; step and run timers count on the server clock. */
    offsetMs: number;
}

/** Fold a snapshot in. Instants are on the server clock (`serverNow`), so this stays pure. */
function applyLive(prev: TaskLiveState, view: TaskLiveView, offsetMs: number): TaskLiveState {
    const meta: Record<string, LiveMeta> = {};
    for (const run of view.runs) meta[run.live.runId] = { agentName: run.agentName, private: run.private, lastUsefulAt: run.lastUsefulAt, threadHref: run.threadHref };
    const serverNow = Date.parse(view.serverNow);
    return {
        runs: mergeLiveRuns(prev.runs, view.runs.map((run) => run.live), Number.isFinite(serverNow) ? serverNow : 0),
        meta,
        offsetMs,
    };
}

const EMPTY_LIVE: TaskLiveState = { runs: [], meta: {}, offsetMs: 0 };

/**
 * The task's live runs: seeded by the server render, then polled fast while a
 * run is live (the team chat's cadence) and slowly when idle. When a live run
 * ends, the page refreshes so the finished run lands in the timeline.
 */
export function useTaskLive(taskId: string, initial: TaskLiveView): TaskLiveState {
    const router = useRouter();
    const [state, setState] = useState<{ source: TaskLiveView; live: TaskLiveState }>(() => ({ source: initial, live: applyLive(EMPTY_LIVE, initial, 0) }));
    const runningRef = useRef(initial.runs.length > 0);
    const liveIdsRef = useRef(new Set(initial.runs.map((run) => run.live.runId)));

    // A server refresh (AutoRefresh, or after an action) brings a fresh snapshot:
    // adopt it during render (React's "state from props" pattern), keep the clock offset.
    let current = state;
    if (state.source !== initial) {
        current = { source: initial, live: applyLive(EMPTY_LIVE, initial, state.live.offsetMs) };
        setState(current);
    }

    useEffect(() => {
        runningRef.current = initial.runs.length > 0;
        liveIdsRef.current = new Set(initial.runs.map((run) => run.live.runId));
    }, [initial]);

    // Fast while a run is live, slow when idle, a slow fallback while the
    // realtime socket is up (a run event or task change refetches at once),
    // none while the tab is hidden (polled at once when shown again).
    useLivePoll(async (poll) => {
        try {
            const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/live`, { cache: "no-store" });
            if (res.ok) {
                const view = (await res.json()) as TaskLiveView;
                if (!poll.active) return;
                const ids = new Set(view.runs.map((run) => run.live.runId));
                const ended = [...liveIdsRef.current].some((id) => !ids.has(id));
                liveIdsRef.current = ids;
                runningRef.current = ids.size > 0;
                const serverNow = Date.parse(view.serverNow);
                const offsetMs = Number.isFinite(serverNow) ? serverNow - Date.now() : 0;
                setState((prev) => ({ source: prev.source, live: applyLive(prev.live, view, offsetMs) }));
                if (ended) router.refresh();
            }
        } catch {
            // Offline or server restart: keep the last snapshot and try again.
        }
    }, {
        fastMs: () => (runningRef.current ? CHAT_POLL_MS.team.active : TASK_IDLE_POLL_MS),
        topics: [`task:${taskId}`],
        resetKey: taskId,
        immediate: false,
    });

    return current.live;
}

/** "No progress for 14 min" / "Last useful action 40s ago" (lib/stall-signal.ts stallLabel, translated). */
export function useStallLabel() {
    const t = useTranslations("tasks.live");
    return (signal: Pick<StallSignal, "stalled" | "idleMs">): string => {
        const total = Number.isFinite(signal.idleMs) && signal.idleMs > 0 ? Math.floor(signal.idleMs / 1000) : 0;
        const minutes = Math.floor(total / 60);
        const idle = total < 60 ? t("idleSeconds", { count: total })
            : minutes < 60 ? t("idleMinutes", { count: minutes })
                : t("idleHours", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
        return signal.stalled ? t("noProgressFor", { idle }) : t("lastUsefulAction", { idle });
    };
}

/** The worst stall among live runs (for the task header), or null. */
export function strongestStall(state: TaskLiveState, nowMs: number): StallSignal | null {
    if (nowMs === 0) return null;
    let worst: StallSignal | null = null;
    for (const run of state.runs) {
        const meta = state.meta[run.runId];
        if (!meta) continue;
        const signal = stallSignal({ status: run.status, lastUsefulAt: meta.lastUsefulAt, now: nowMs + state.offsetMs });
        if (signal && (!worst || signal.idleMs > worst.idleMs)) worst = signal;
    }
    return worst;
}

/**
 * One live run, pinned above the timeline. The step line keeps a fixed
 * two-line height (step, then the last thought) so it never jumps as steps
 * stream in; the full step list sits behind "Steps".
 */
export const LiveRunBlock = memo(function LiveRunBlock({ run, meta, offsetMs, nowMs }: { run: ClientLiveRun; meta: LiveMeta | undefined; offsetMs: number; nowMs: number }) {
    const t = useTranslations("tasks.live");
    const stallLabel = useStallLabel();
    const serverNow = nowMs + offsetMs;
    const started = Date.parse(run.startedAt);
    const elapsed = nowMs && Number.isFinite(started) ? formatElapsed(serverNow - started) : null;
    const timed = isTimedStepKind(run.current.kind);
    const stepElapsed = nowMs && timed ? formatElapsed(serverNow - run.currentStartedAt) : null;
    const detail = meta?.private ? null : lastReasoningLine(run);
    const signal = nowMs && meta ? stallSignal({ status: run.status, lastUsefulAt: meta.lastUsefulAt, now: serverNow }) : null;
    const name = meta?.agentName ?? t("agent");

    return (
        <section
            id={`run-${run.runId}`}
            aria-label={t("isWorkingLabel", { name })}
            className={cn(
                "relative overflow-hidden rounded-2xl border bg-zinc-950/70 p-4 sm:p-5",
                signal?.stalled ? "border-amber-500/40" : "border-cyan-500/30",
            )}
        >
            <div className={cn("pointer-events-none absolute inset-x-0 top-0 h-px", signal?.stalled ? "bg-amber-400/50" : "bg-cyan-400/50")} aria-hidden="true" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="relative flex h-2 w-2 shrink-0" aria-hidden="true">
                    <span className={cn("absolute inline-flex h-full w-full rounded-full opacity-60 motion-safe:animate-ping", signal?.stalled ? "bg-amber-400" : "bg-cyan-400")} />
                    <span className={cn("relative inline-flex h-2 w-2 rounded-full", signal?.stalled ? "bg-amber-400" : "bg-cyan-400")} />
                </span>
                <p className="min-w-0 text-sm font-medium text-zinc-100">
                    {t.rich("isWorking", { name, muted: (chunks) => <span className="font-normal text-zinc-400">{chunks}</span> })}
                </p>
                <span className="font-mono text-xs tabular-nums text-zinc-400">{elapsed ?? " "}</span>
                <span className="ml-auto inline-flex items-center rounded-full border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-medium text-cyan-300">{t("live")}</span>
            </div>

            {/* Fixed two-line row: the step, then the last thought (blank when none). */}
            <div className="mt-3 rounded-xl border border-zinc-800/80 bg-zinc-900/60 px-3 py-2">
                <p className="flex min-w-0 items-center gap-1.5 text-xs text-zinc-300" title={run.current.summary}>
                    {meta?.private && <IconLock className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />}
                    <span className="min-w-0 truncate font-mono">{run.current.summary}</span>
                    {stepElapsed && <span className="shrink-0 font-mono tabular-nums text-zinc-500">· {stepElapsed}</span>}
                </p>
                <p className="mt-0.5 min-w-0 truncate text-[11px] italic text-zinc-500" title={detail ?? undefined}>{detail ?? " "}</p>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                <p
                    role="status"
                    className={cn(
                        "text-xs tabular-nums",
                        signal?.stalled ? "font-medium text-amber-300" : "text-zinc-500",
                    )}
                >
                    {signal ? stallLabel(signal) : " "}
                </p>
                {meta?.threadHref && (
                    <Link href={meta.threadHref} className="text-xs text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline">
                        {t("openChat")}
                    </Link>
                )}
            </div>
            {/* Own row: the expanded list takes the block's full width. */}
            {!meta?.private && (
                <div className="mt-2">
                    <LiveRunSteps steps={run.steps} usage={run.usage} />
                </div>
            )}
        </section>
    );
});
