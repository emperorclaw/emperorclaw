"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { AgentNow, AgentRuntimeInfo } from "@/lib/agent-activity";
import { RunTimelineList } from "@/components/run-timeline";
import { bridgeBadgeCopy, cacheHitPercent, HERMES_MIGRATION_DOC_HREF, isTimedStepKind, liveUsageLine } from "@/lib/live-activity";
import { formatTokenCount } from "@/lib/run-ledger-copy";

const STATE_PILL: Record<AgentNow["state"], { label: string; className: string }> = {
    working: { label: "Working", className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300" },
    typing: { label: "Responding", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
    idle: { label: "Idle", className: "border-zinc-700 bg-zinc-800/60 text-zinc-300" },
    offline: { label: "Offline", className: "border-zinc-700/60 bg-zinc-800/40 text-zinc-500" },
};

const TRIGGER_LABEL: Record<string, string> = {
    message: "replying to a message",
    task: "on a task",
    objective: "following up an objective",
};

function lastRunBadge(status: string): string {
    if (status === "succeeded") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    if (status === "failed" || status === "timeout" || status === "lost") return "border-rose-500/30 bg-rose-500/10 text-rose-300";
    if (status === "cancelled" || status === "blocked") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    return "border-zinc-700 bg-zinc-800/60 text-zinc-400";
}

export function AgentNowCard({ now }: { now: AgentNow | undefined }) {
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);

    if (!now) {
        return (
            <section className="emperor-panel rounded-2xl p-4 sm:p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Right now</p>
                <p className="mt-2 text-sm text-zinc-500">Loading activity…</p>
            </section>
        );
    }

    const pill = STATE_PILL[now.state] ?? STATE_PILL.idle;
    const elapsedMs = now.run ? nowMs - Date.parse(now.run.startedAt) : 0;
    const live = now.run?.live;
    // The step timer counts from when this snapshot was taken (the card poll).
    const activityText = live?.current.summary ?? now.activity;
    const lastRunCache = now.lastRun ? cacheHitPercent(now.lastRun.inputTokens, now.lastRun.cacheReadTokens) : null;

    return (
        <section className="emperor-panel rounded-2xl p-4 sm:p-5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">Right now</p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium", pill.className)}>
                    {pill.label}
                </span>
                {now.run && (
                    <>
                        <span className="font-mono text-xs text-zinc-400 tabular-nums">{formatDuration(elapsedMs)}</span>
                        {TRIGGER_LABEL[now.run.triggerKind] && <span className="text-xs text-zinc-500">{TRIGGER_LABEL[now.run.triggerKind]}</span>}
                    </>
                )}
            </div>

            <div className="mt-3">
                {activityText ? (
                    <p className="font-mono text-xs text-zinc-300 line-clamp-3 whitespace-pre-wrap">
                        {activityText}
                        {live && isTimedStepKind(live.current.kind) && <StepElapsed key={`${live.current.kind}:${live.current.summary}`} sinceMs={live.current.sinceMs} />}
                    </p>
                ) : now.state === "idle" ? (
                    <p className="text-xs text-zinc-500">Idle — waiting for work.</p>
                ) : now.state === "offline" ? (
                    <p className="text-xs text-zinc-500">{now.lastSeenAt ? `Last seen ${formatAgo(now.lastSeenAt, nowMs)}` : "Never connected"}</p>
                ) : null}
            </div>

            {live && live.steps.length > 0 && (
                <div className="mt-2">
                    <RunTimelineList steps={live.steps} />
                </div>
            )}
            {live?.usage && <p className="mt-1.5 text-[11px] tabular-nums text-zinc-500">{liveUsageLine(live.usage)}</p>}

            {now.task && (
                <div className="mt-3 flex items-center gap-2 text-xs">
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-zinc-500">Task</span>
                    <Link href={`/projects?task=${now.task.id}`} className="line-clamp-2 sm:truncate text-cyan-300 hover:text-cyan-200">
                        {now.task.title}
                    </Link>
                </div>
            )}

            {now.lastRun && (
                <div className="mt-3 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", lastRunBadge(now.lastRun.status))}>
                            {now.lastRun.status}
                        </span>
                        <span>ended {formatAgo(now.lastRun.endedAt ?? now.lastRun.startedAt, nowMs)}</span>
                        {now.lastRun.durationMs != null && <span>{formatDuration(now.lastRun.durationMs)}</span>}
                        {now.lastRun.tokens != null && <span>{now.lastRun.tokens.toLocaleString()} tokens</span>}
                        {now.lastRun.cacheReadTokens != null && now.lastRun.cacheReadTokens > 0 && (
                            <span>{formatTokenCount(now.lastRun.cacheReadTokens)} cached{lastRunCache != null ? ` (${lastRunCache}%)` : ""}</span>
                        )}
                        {now.lastRun.costCents != null && <span>${(now.lastRun.costCents / 100).toFixed(2)}</span>}
                        {now.lastRun.toolCalls != null && <span>{now.lastRun.toolCalls} {now.lastRun.toolCalls === 1 ? "tool" : "tools"}</span>}
                        {now.lastRun.model && <span className="max-w-full truncate">{now.lastRun.model}</span>}
                    </div>
                    {now.lastRun.error && <p className="text-xs text-rose-400 line-clamp-2">{now.lastRun.error}</p>}
                </div>
            )}

            {now.lastMessage && (
                <blockquote className="mt-3 border-l-2 border-zinc-700 pl-3">
                    <p className="text-xs text-zinc-400 line-clamp-2">{now.lastMessage.text}</p>
                    <span className="mt-0.5 block text-[10px] text-zinc-500">{formatAgo(now.lastMessage.createdAt, nowMs)}</span>
                </blockquote>
            )}

            <div className="mt-4">
                <Link
                    href={`/messages?agent=${now.agentId}`}
                    className="inline-flex h-11 sm:h-8 items-center gap-1.5 rounded-lg border border-zinc-800 px-3 text-xs text-zinc-300 transition-colors hover:border-cyan-400/40 hover:bg-cyan-400/10 hover:text-cyan-100"
                >
                    Open chat
                </Link>
            </div>
        </section>
    );
}

/** The current step's age, counted on from the snapshot's `sinceMs`. Ticks on its own. */
function StepElapsed({ sinceMs }: { sinceMs: number }) {
    const [origin] = useState(() => Date.now() - sinceMs);
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);
    return <span className="text-zinc-500 tabular-nums"> · {formatDuration(nowMs - origin)}</span>;
}

const BADGE_TONE: Record<ReturnType<typeof bridgeBadgeCopy>["tone"], string> = {
    ok: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    bad: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    muted: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
};

/**
 * The Hermes bridge version badge (current / update available / unsupported /
 * legacy). Outdated states link the upgrade guide unless `compact`.
 */
export function BridgeBadge({ runtime, compact = false }: { runtime: AgentRuntimeInfo | null | undefined; compact?: boolean }) {
    if (!runtime) return null;
    const managed = runtime.deployMode === "managed";
    const copy = bridgeBadgeCopy(runtime.updateState, runtime.bridgeVersion, managed);
    if (compact && runtime.updateState === "current") return null;
    return (
        <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
            <span title={copy.hint} className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", BADGE_TONE[copy.tone])}>
                {copy.label}
            </span>
            {!compact && copy.showGuide && (
                <a href={HERMES_MIGRATION_DOC_HREF} target="_blank" rel="noreferrer" className="text-[10px] text-cyan-400 underline underline-offset-2 hover:text-cyan-300">
                    {managed ? "How to update" : "Update guide"}
                </a>
            )}
            {!compact && runtime.gatewayTopology === "shared" && (
                <span title="This runtime shares one Hermes gateway with other agents on the same host." className="inline-flex shrink-0 items-center rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                    Shared gateway
                </span>
            )}
        </span>
    );
}

/** `42s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number): string {
    const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms) : 0;
    const seconds = Math.floor(total / 1000);
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
    return `${secs}s`;
}

/** Relative time like `just now`, `42s ago`, `3m ago`, `2h ago`. */
export function formatAgo(iso: string, nowMs: number): string {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const diffMs = Math.max(0, nowMs - t);
    const seconds = Math.floor(diffMs / 1000);
    if (seconds < 10) return "just now";
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
