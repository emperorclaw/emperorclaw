"use client";

import { memo, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { useLiveActivity } from "@/components/use-live-activity";
import { formatElapsed, stepHeadline } from "@/lib/live-activity";

type LiveStatusRowProps = {
    /** A prompt is being handled or the agent is typing. */
    active: boolean;
    /** Id of the prompt being handled, when known; a new id restarts the timer. */
    activityKey: string | null;
    /** Latest activity line from the runtime, if any (0.3 bridges: currentActivity). */
    activity: string | null;
    /** Who is working ("Growth", "Growth and SEO"); null when unknown. */
    label: string | null;
    /** Text after the label when there is no activity line ("is working"). */
    idleVerb: string;
    /** Text shown when there is neither a label nor an activity line. */
    fallbackText: string;
    variant: "direct" | "team";
    /**
     * 0.9 run events: the live run's current line ("Running terminal · npm
     * test"). When set it wins over `activity`, and the row reserves a second
     * line for `detail` so it does not change height as steps come and go.
     */
    step?: string | null;
    /** Client epoch when the current step began; shows a step timer (tools only). */
    stepStartedAt?: number | null;
    /** Second line under a live run: the last reasoning line, when any. */
    detail?: string | null;
};

/** The current step's own ticking timer ("· 4s"). Isolated so only it re-renders each second. */
const StepTimer = memo(function StepTimer({ startedAt }: { startedAt: number }) {
    const [now, setNow] = useState(0);
    useEffect(() => {
        const tick = () => setNow(Date.now());
        const first = setTimeout(tick, 0);
        const timer = setInterval(tick, 1000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
        };
    }, [startedAt]);
    if (now === 0) return null;
    return <span className="tabular-nums"> · {formatElapsed(Math.max(0, now - startedAt))}</span>;
});

/**
 * The chat's "agent is working" row. It owns the 1 s ticker so only this row
 * re-renders while an agent works, not the whole transcript. The live region
 * stays mounted (visually hidden and empty when idle) so screen readers catch
 * the first announcement when work starts.
 *
 * Props are primitives only, so memo skips re-renders from the parent.
 */
export const LiveStatusRow = memo(function LiveStatusRow({ active, activityKey, activity, label, idleVerb, fallbackText, variant, step = null, stepStartedAt = null, detail = null }: LiveStatusRowProps) {
    const live = useLiveActivity({ active, key: activityKey, activity: step ?? activity });
    const dot = variant === "direct" ? "bg-emerald-500" : "bg-cyan-500";
    const evented = active && step !== null;

    const dots = active && (
        <div className="flex shrink-0 gap-1" aria-hidden="true">
            <div className={cn("h-1.5 w-1.5 rounded-full motion-safe:animate-bounce [animation-delay:-0.3s]", dot)} />
            <div className={cn("h-1.5 w-1.5 rounded-full motion-safe:animate-bounce [animation-delay:-0.15s]", dot)} />
            <div className={cn("h-1.5 w-1.5 rounded-full motion-safe:animate-bounce", dot)} />
        </div>
    );

    // The live region only carries the name and the step headline ("Thinking",
    // "Running write_file"), so it speaks once per step rather than on every
    // streamed thought or tick. The visible line below shows the full text.
    // Activity is the model's own reasoning or tool line, so it keeps its case.
    const headline = stepHeadline(live.activity);
    const announcement = active ? (label ? `${label}: ${headline ?? idleVerb}` : headline ?? fallbackText) : "";
    const status = (
        <span className={cn(active && "min-w-0 truncate text-[11px] text-zinc-400")} title={live.activity ?? undefined}>
            {active && (label ? (
                <>
                    <span className="font-bold text-zinc-500">{label}{live.activity ? ":" : ""}</span>{" "}
                    {live.activity ?? idleVerb}
                </>
            ) : (
                live.activity ?? fallbackText
            ))}
        </span>
    );

    const stepTimer = evented && stepStartedAt !== null && (
        <span className="shrink-0 text-[11px] text-zinc-500" aria-hidden="true">
            <StepTimer startedAt={stepStartedAt} />
        </span>
    );

    const timer = active && live.elapsedLabel && (
        <span className="ml-auto shrink-0 pl-1 font-mono text-[10px] tabular-nums text-zinc-600" aria-hidden="true">
            {live.elapsedLabel}
        </span>
    );

    // A live run always has the second line (blank when there is no detail),
    // so the row keeps one height for the whole turn.
    const detailLine = evented && (
        <span className="block min-w-0 truncate text-[10px] italic text-zinc-500" title={detail ?? undefined}>
            {detail ?? " "}
        </span>
    );

    const firstLine = (
        <div className="flex min-w-0 items-center gap-2">
            {dots}
            <div className="flex min-w-0 flex-1 items-center">
                <span role="status" aria-live="polite" className="sr-only">{announcement}</span>
                {status}
                {stepTimer}
            </div>
            {timer}
        </div>
    );

    if (variant === "direct") {
        return (
            <div className={active ? "flex justify-start mt-3 animate-in fade-in slide-in-from-left-2 duration-300" : "sr-only"}>
                {/* max-w matches the message bubbles so long activity truncates. */}
                <div className={cn(active && "min-w-0 max-w-[88%] rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 sm:max-w-[80%]", evented && "w-full")}>
                    {firstLine}
                    {detailLine && <div className="mt-0.5 pl-[26px]">{detailLine}</div>}
                </div>
            </div>
        );
    }

    return (
        <div className={active ? "border-t border-zinc-800/60 px-4 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200" : "sr-only"}>
            {firstLine}
            {detailLine && <div className="mt-0.5 pl-[26px]">{detailLine}</div>}
        </div>
    );
});
