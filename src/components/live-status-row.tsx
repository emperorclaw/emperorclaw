"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import { useLiveActivity } from "@/components/use-live-activity";

type LiveStatusRowProps = {
    /** A prompt is being handled or the agent is typing. */
    active: boolean;
    /** Id of the prompt being handled, when known; a new id restarts the timer. */
    activityKey: string | null;
    /** Latest activity line from the runtime, if any. */
    activity: string | null;
    /** Who is working ("Growth", "Growth and SEO"); null when unknown. */
    label: string | null;
    /** Text after the label when there is no activity line ("is working"). */
    idleVerb: string;
    /** Text shown when there is neither a label nor an activity line. */
    fallbackText: string;
    variant: "direct" | "team";
};

/**
 * The chat's "agent is working" row. It owns the 1 s ticker so only this row
 * re-renders while an agent works, not the whole transcript. The live region
 * stays mounted (visually hidden and empty when idle) so screen readers catch
 * the first announcement when work starts.
 *
 * Props are primitives only, so memo skips re-renders from the parent.
 */
export const LiveStatusRow = memo(function LiveStatusRow({ active, activityKey, activity, label, idleVerb, fallbackText, variant }: LiveStatusRowProps) {
    const live = useLiveActivity({ active, key: activityKey, activity });
    const dot = variant === "direct" ? "bg-emerald-500" : "bg-cyan-500";

    const dots = active && (
        <div className="flex shrink-0 gap-1" aria-hidden="true">
            <div className={cn("h-1.5 w-1.5 rounded-full motion-safe:animate-bounce [animation-delay:-0.3s]", dot)} />
            <div className={cn("h-1.5 w-1.5 rounded-full motion-safe:animate-bounce [animation-delay:-0.15s]", dot)} />
            <div className={cn("h-1.5 w-1.5 rounded-full motion-safe:animate-bounce", dot)} />
        </div>
    );

    // Only name + activity are announced; the ticking timer sits outside the
    // live region so it is not read every second. Activity is the model's own
    // reasoning or tool line, so it keeps its case.
    const status = (
        <span role="status" aria-live="polite" className={cn(active && "min-w-0 truncate text-[11px] text-zinc-400")} title={live.activity ?? undefined}>
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

    const timer = active && live.elapsedLabel && (
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-zinc-600" aria-hidden="true">
            {live.elapsedLabel}
        </span>
    );

    if (variant === "direct") {
        return (
            <div className={active ? "flex justify-start mt-3 animate-in fade-in slide-in-from-left-2 duration-300" : "sr-only"}>
                {/* max-w matches the message bubbles so long activity truncates. */}
                <div className={cn(active && "flex min-w-0 max-w-[88%] items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900 px-4 py-3 sm:max-w-[80%]")}>
                    {dots}
                    {status}
                    {timer}
                </div>
            </div>
        );
    }

    return (
        <div className={active ? "flex items-center gap-2 border-t border-zinc-800/60 px-4 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200" : "sr-only"}>
            {dots}
            {status}
            {timer}
        </div>
    );
});
