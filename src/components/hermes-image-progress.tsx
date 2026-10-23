"use client";

import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

type PullState = { status: "idle" | "pulling" | "ready" | "error"; percent?: number; downloadedBytes?: number; totalBytes?: number };

const POLL_MS = 2000;

function gigabytes(bytes: number): string {
    return (bytes / 1_000_000_000).toFixed(1);
}

/** Text for the download line; values are decimal gigabytes, as Docker reports sizes. */
export function hermesImageProgressLabel(state: Pick<PullState, "downloadedBytes" | "totalBytes" | "percent">): string {
    const base = "Downloading the agent runtime (one time)";
    if (state.downloadedBytes !== undefined && state.totalBytes) return `${base} — ${gigabytes(state.downloadedBytes)} of ${gigabytes(state.totalBytes)} GB`;
    if (state.downloadedBytes) return `${base} — ${gigabytes(state.downloadedBytes)} GB so far`;
    return `${base}…`;
}

/**
 * Shows the one-time Hermes runtime download while `active`, polling
 * /api/runtime/hermes-image every 2 s. Renders `fallback` whenever no pull is
 * running, including when the endpoint is missing or fails.
 */
export function HermesImageProgress({ active, fallback = null, className }: { active: boolean; fallback?: ReactNode; className?: string }) {
    const [state, setState] = useState<PullState | null>(null);

    useEffect(() => {
        if (!active) { setState(null); return; }
        let cancelled = false;
        const poll = async () => {
            try {
                const res = await fetch("/api/runtime/hermes-image", { cache: "no-store" });
                const data = res.ok ? await res.json() as PullState : null;
                if (!cancelled) setState(data);
            } catch {
                if (!cancelled) setState(null);
            }
        };
        void poll();
        const timer = setInterval(() => void poll(), POLL_MS);
        return () => { cancelled = true; clearInterval(timer); };
    }, [active]);

    if (!active || state?.status !== "pulling") return <>{fallback}</>;
    const percent = state.percent;
    const label = hermesImageProgressLabel(state);
    return (
        <div className={cn("space-y-1.5", className)}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Agent runtime download"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent}
                aria-valuetext={percent !== undefined ? `${percent}% — ${label}` : label}
            >
                <div
                    className={cn("h-full rounded-full bg-cyan-500 transition-[width] duration-500", percent === undefined && "w-1/4 animate-pulse")}
                    style={percent !== undefined ? { width: `${Math.max(2, percent)}%` } : undefined}
                />
            </div>
        </div>
    );
}
