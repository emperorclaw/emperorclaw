"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

type PullState = { status: "idle" | "pulling" | "ready" | "error"; phase?: "downloading" | "extracting"; percent?: number; downloadedBytes?: number; totalBytes?: number; extractedBytes?: number };

const POLL_MS = 2000;

function gigabytes(bytes: number): string {
    return (bytes / 1_000_000_000).toFixed(2);
}

/** "340 MB" under a gigabyte, "1.24 GB" above (decimal units, as Docker reports sizes). */
function amount(bytes: number): string {
    return bytes < 1_000_000_000 ? `${Math.round(bytes / 1_000_000)} MB` : `${gigabytes(bytes)} GB`;
}

type ProgressState = Pick<PullState, "phase" | "downloadedBytes" | "totalBytes" | "extractedBytes" | "percent">;

/**
 * The progress line as a message key under `hermesImage` plus its values
 * (the words live in messages/*.json; hermesImageProgressLabel is the English).
 */
export function hermesImageProgressMessage(state: ProgressState): { key: "unpackingOf" | "unpacking" | "downloadingOf" | "downloadingSoFar" | "downloading"; values: Record<string, string> } {
    if (state.phase === "extracting") {
        if (state.extractedBytes !== undefined && state.totalBytes) return { key: "unpackingOf", values: { done: gigabytes(state.extractedBytes), total: gigabytes(state.totalBytes) } };
        return { key: "unpacking", values: {} };
    }
    if (state.downloadedBytes !== undefined && state.totalBytes) return { key: "downloadingOf", values: { done: gigabytes(state.downloadedBytes), total: gigabytes(state.totalBytes) } };
    if (state.downloadedBytes) return { key: "downloadingSoFar", values: { amount: amount(state.downloadedBytes) } };
    return { key: "downloading", values: {} };
}

/** Text for the progress line: "x of y GB" once the total is known, else what has arrived so far. */
export function hermesImageProgressLabel(state: Pick<PullState, "phase" | "downloadedBytes" | "totalBytes" | "extractedBytes" | "percent">): string {
    if (state.phase === "extracting") {
        const base = "Unpacking the agent runtime (one time)";
        if (state.extractedBytes !== undefined && state.totalBytes) return `${base} — ${gigabytes(state.extractedBytes)} of ${gigabytes(state.totalBytes)} GB`;
        return `${base}…`;
    }
    const base = "Downloading the agent runtime (one time)";
    if (state.downloadedBytes !== undefined && state.totalBytes) return `${base} — ${gigabytes(state.downloadedBytes)} of ${gigabytes(state.totalBytes)} GB`;
    if (state.downloadedBytes) return `${base} — ${amount(state.downloadedBytes)} so far`;
    return `${base}…`;
}

/**
 * Shows the one-time Hermes runtime download while `active`, polling
 * /api/runtime/hermes-image every 2 s. Renders `fallback` whenever no pull is
 * running, including when the endpoint is missing or fails.
 */
export function HermesImageProgress({ active, fallback = null, className }: { active: boolean; fallback?: ReactNode; className?: string }) {
    const t = useTranslations("hermesImage");
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
    const message = hermesImageProgressMessage(state);
    const label = t(message.key, message.values);
    return (
        <div className={cn("space-y-1.5", className)}>
            <p className="text-sm text-muted-foreground">{label}</p>
            <div
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label={state.phase === "extracting" ? t("unpackingLabel") : t("downloadLabel")}
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
