"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { AgentNow, AgentRuntimeInfo } from "@/lib/agent-activity";
import { runWorkLabel } from "@/lib/agent-visibility";
import { RunTimelineList } from "@/components/run-timeline";
import { bridgeBadgeCopy, cacheHitPercent, HERMES_MIGRATION_DOC_HREF, isTimedStepKind, liveUsageLine } from "@/lib/live-activity";
import { formatTokenCount } from "@/lib/run-ledger-copy";
import { taskHref } from "@/lib/task-story";
import { describeFailure, fixAudience } from "@/lib/failure-cause";
import { useViewerPermissions } from "@/lib/use-viewer-permissions";
import { FailureFixButton } from "@/components/failure-fix";
import { useCopy } from "@/lib/i18n/use-copy";

/** Labelled by agents.now.states.<state>. */
const STATE_PILL: Record<AgentNow["state"], { className: string }> = {
    working: { className: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300" },
    typing: { className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" },
    idle: { className: "border-zinc-700 bg-zinc-800/60 text-zinc-300" },
    offline: { className: "border-zinc-700/60 bg-zinc-800/40 text-zinc-500" },
};

/** Run statuses with a label under agents.now.runStatus (anything else shows as is). */
const RUN_STATUSES = new Set(["succeeded", "failed", "timeout", "lost", "cancelled", "blocked", "running", "queued"]);

function lastRunBadge(status: string): string {
    if (status === "succeeded") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    if (status === "failed" || status === "timeout" || status === "lost") return "border-rose-500/30 bg-rose-500/10 text-rose-300";
    if (status === "cancelled" || status === "blocked") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
    return "border-zinc-700 bg-zinc-800/60 text-zinc-400";
}

export function AgentNowCard({ now }: { now: AgentNow | undefined }) {
    const t = useTranslations("agents.now");
    const formatAgo = useFormatAgo();
    const [nowMs, setNowMs] = useState(() => Date.now());
    useEffect(() => {
        const id = window.setInterval(() => setNowMs(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, []);

    if (!now) {
        return (
            <section className="emperor-panel rounded-2xl p-4 sm:p-5">
                <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{t("rightNow")}</p>
                <p className="mt-2 text-sm text-zinc-500">{t("loading")}</p>
            </section>
        );
    }

    const pillState = now.state in STATE_PILL ? now.state : "idle";
    const pill = STATE_PILL[pillState];
    const live = now.run?.live;
    // The step timer counts from when this snapshot was taken (the card poll).
    const activityText = live?.current.summary ?? now.activity;
    const lastRunCache = now.lastRun ? cacheHitPercent(now.lastRun.inputTokens, now.lastRun.cacheReadTokens) : null;
    const runningRuns = now.runningRuns ?? [];

    return (
        <section className="emperor-panel rounded-2xl p-4 sm:p-5">
            <p className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">{t("rightNow")}</p>

            <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium", pill.className)}>
                    {t(`states.${pillState}`)}
                </span>
            </div>

            {runningRuns.length > 0 && (
                <div className="mt-2 space-y-1">
                    {runningRuns.map((run) => {
                        const label = runWorkLabel(run);
                        return (
                            <div key={run.runId} className="flex items-center gap-2 text-xs">
                                <span className="shrink-0 font-mono text-zinc-400 tabular-nums">{run.startedAt ? formatDuration(nowMs - Date.parse(run.startedAt)) : "—"}</span>
                                {label.href ? (
                                    <Link href={label.href} className="min-w-0 truncate text-cyan-300 hover:text-cyan-200">{label.text}</Link>
                                ) : (
                                    <span className="min-w-0 truncate text-zinc-300">{label.text}</span>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}

            <div className="mt-3">
                {activityText ? (
                    <p className="font-mono text-xs text-zinc-300 line-clamp-3 whitespace-pre-wrap">
                        {activityText}
                        {live && isTimedStepKind(live.current.kind) && <StepElapsed key={`${live.current.kind}:${live.current.summary}`} sinceMs={live.current.sinceMs} />}
                    </p>
                ) : now.state === "idle" ? (
                    <p className="text-xs text-zinc-500">{t("idle")}</p>
                ) : now.state === "offline" ? (
                    <p className="text-xs text-zinc-500">{now.lastSeenAt ? t("lastSeen", { ago: formatAgo(now.lastSeenAt, nowMs) }) : t("neverConnected")}</p>
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
                    <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider text-zinc-500">{t("task")}</span>
                    <Link href={taskHref(now.task.id, now.run?.taskId === now.task.id ? now.run.id : null)} className="line-clamp-2 sm:truncate text-cyan-300 hover:text-cyan-200">
                        {now.task.title}
                    </Link>
                </div>
            )}

            {now.lastRun && (
                <div className="mt-3 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-400">
                        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-medium capitalize", lastRunBadge(now.lastRun.status))}>
                            {RUN_STATUSES.has(now.lastRun.status) ? t(`runStatus.${now.lastRun.status as "failed"}`) : now.lastRun.status}
                        </span>
                        <span>{t("ended", { ago: formatAgo(now.lastRun.endedAt ?? now.lastRun.startedAt, nowMs) })}</span>
                        {now.lastRun.durationMs != null && <span>{formatDuration(now.lastRun.durationMs)}</span>}
                        {now.lastRun.tokens != null && <span>{t("tokens", { count: now.lastRun.tokens })}</span>}
                        {now.lastRun.cacheReadTokens != null && now.lastRun.cacheReadTokens > 0 && (
                            <span>{lastRunCache != null ? t("cachedPercent", { amount: formatTokenCount(now.lastRun.cacheReadTokens), percent: lastRunCache }) : t("cached", { amount: formatTokenCount(now.lastRun.cacheReadTokens) })}</span>
                        )}
                        {now.lastRun.costCents != null && <span>${(now.lastRun.costCents / 100).toFixed(2)}</span>}
                        {now.lastRun.toolCalls != null && <span>{t("tools", { count: now.lastRun.toolCalls })}</span>}
                        {now.lastRun.model && <span className="max-w-full truncate">{now.lastRun.model}</span>}
                    </div>
                    {["failed", "timeout", "lost"].includes(now.lastRun.status) && <LastRunFailure agentId={now.agentId} lastRun={now.lastRun} />}
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
                    {t("openChat")}
                </Link>
            </div>
        </section>
    );
}

/** A failed last run: one plain cause and, for those allowed, one fix. */
function LastRunFailure({ agentId, lastRun }: { agentId: string; lastRun: NonNullable<AgentNow["lastRun"]> }) {
    const permissions = useViewerPermissions();
    const render = useCopy();
    const failure = describeFailure(
        { texts: [lastRun.error, lastRun.exitReason], runStatus: lastRun.status },
        { audience: fixAudience({ canAct: permissions.canWrite, isOwnerOrAdmin: permissions.canAdmin }), agentId, failedAt: lastRun.endedAt ?? lastRun.startedAt },
    );
    return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <p className="min-w-0 flex-1 text-xs text-rose-400 line-clamp-2">
                {render(failure.headlineCopy, failure.headline)}{failure.detail && <span className="text-rose-400/70">: {failure.detail}</span>}
            </p>
            {failure.fix && (
                <FailureFixButton fix={failure.fix} className="inline-flex h-11 shrink-0 items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-400/20 disabled:cursor-not-allowed disabled:opacity-50 sm:h-8" />
            )}
        </div>
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
    const t = useTranslations("agents.bridge");
    if (!runtime) return null;
    const managed = runtime.deployMode === "managed";
    // Tone and guide from the shared rule; the words from messages (lib/live-activity.ts bridgeBadgeCopy).
    const copy = bridgeBadgeCopy(runtime.updateState, runtime.bridgeVersion, managed);
    const update = managed ? t("updateManaged") : t("updateSelf");
    const version = runtime.bridgeVersion ?? "?";
    const state = runtime.updateState === "current" || runtime.updateState === "update-available" || runtime.updateState === "unsupported" ? runtime.updateState : "legacy";
    const label = state === "current" ? (runtime.bridgeVersion ? t("currentVersion", { version }) : t("current"))
        : state === "update-available" ? t("updateAvailable") : state === "unsupported" ? t("unsupported") : t("legacy");
    const hint = state === "current" ? t("currentHint") : state === "update-available" ? t("updateAvailableHint", { version, update })
        : state === "unsupported" ? t("unsupportedHint", { version, update }) : t("legacyHint", { update });
    if (compact && runtime.updateState === "current") return null;
    return (
        <span className="inline-flex max-w-full flex-wrap items-center gap-1.5">
            <span title={hint} className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium", BADGE_TONE[copy.tone])}>
                {label}
            </span>
            {!compact && copy.showGuide && (
                <a href={HERMES_MIGRATION_DOC_HREF} target="_blank" rel="noreferrer" className="text-[10px] text-cyan-400 underline underline-offset-2 hover:text-cyan-300">
                    {managed ? t("howToUpdate") : t("updateGuide")}
                </a>
            )}
            {!compact && runtime.gatewayTopology === "shared" && (
                <span title={t("sharedGatewayHint")} className="inline-flex shrink-0 items-center rounded-full border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-medium text-zinc-300">
                    {t("sharedGateway")}
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

/** Relative time like `just now`, `42s ago`, `3m ago`, `2h ago`, in the person's language. */
export function useFormatAgo() {
    const t = useTranslations("time");
    const tNow = useTranslations("agents.now");
    return (iso: string, nowMs: number): string => {
        const at = Date.parse(iso);
        if (!Number.isFinite(at)) return "";
        const diffMs = Math.max(0, nowMs - at);
        const seconds = Math.floor(diffMs / 1000);
        if (seconds < 10) return t("justNow");
        if (seconds < 60) return tNow("secondsAgo", { count: seconds });
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return t("minutesAgo", { count: minutes });
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return t("hoursAgo", { count: hours });
        return t("daysAgo", { count: Math.floor(hours / 24) });
    };
}
