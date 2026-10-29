"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { IconAlertTriangle, IconArrowLeft, IconClockHour4, IconHeartbeat, IconMessageCircleOff, IconRefresh } from "@tabler/icons-react";
import { StatsBlock } from "@/components/rich/stats-block";
import type { AgentHealth, CompanyHealth, HealthStatus } from "@/lib/agent-health";
import { agentAvatarSrc } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/** Labelled by agents.health.status.<status>. */
const STATUS: Record<HealthStatus, { className: string; dot: string }> = {
    down: { className: "bg-rose-500/12 text-rose-300 ring-rose-500/30", dot: "bg-rose-400" },
    attention: { className: "bg-amber-500/12 text-amber-200 ring-amber-500/30", dot: "bg-amber-400" },
    healthy: { className: "bg-emerald-500/12 text-emerald-300 ring-emerald-500/25", dot: "bg-emerald-400" },
    idle: { className: "bg-zinc-500/12 text-zinc-400 ring-zinc-500/25", dot: "bg-zinc-500" },
};

export function formatDuration(ms: number | null): string {
    if (ms === null) return "—";
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = ms / 3_600_000;
    return h < 48 ? `${h.toFixed(h < 10 ? 1 : 0)}h` : `${Math.round(h / 24)}d`;
}

/** "5m ago" (or "never"), in the person's language. */
function useAgo() {
    const t = useTranslations("agents.health");
    return (iso: string | null): string => {
        if (!iso) return t("never");
        return t("ago", { duration: formatDuration(Date.now() - new Date(iso).getTime()) });
    };
}

function money(cents: number): string {
    return `$${(cents / 100).toFixed(cents >= 10_000 ? 0 : 2)}`;
}

function Spark({ values }: { values: number[] }) {
    const max = Math.max(1, ...values);
    return (
        <div className="flex h-6 items-end gap-0.5" aria-hidden>
            {values.map((v, i) => (
                <span key={i} className="w-1.5 rounded-sm bg-cyan-400/60" style={{ height: `${Math.max(8, (v / max) * 100)}%`, opacity: v ? 1 : 0.25 }} />
            ))}
        </div>
    );
}

function Metric({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
    return (
        <div className="min-w-0">
            <div className="truncate text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
            <div className={cn("text-sm font-semibold tabular-nums", warn ? "text-amber-300" : "text-zinc-100")}>{value}</div>
        </div>
    );
}

function AgentCard({ agent }: { agent: AgentHealth }) {
    const t = useTranslations("agents.health");
    const ago = useAgo();
    const status = STATUS[agent.status];
    return (
        <article className="emperor-panel flex min-w-0 flex-col gap-3 rounded-2xl p-4">
            <div className="flex items-start gap-3">
                <Link href={`/agents?agent=${agent.id}`} className="relative shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={agentAvatarSrc(agent)} alt="" className="h-10 w-10 rounded-xl border border-zinc-800 bg-zinc-900 object-cover" />
                    <span className={cn("absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-zinc-950", agent.online ? "bg-emerald-400" : "bg-zinc-600")} />
                </Link>
                <div className="min-w-0 flex-1">
                    <Link href={`/agents?agent=${agent.id}`} className="block truncate text-sm font-semibold text-zinc-100 hover:text-zinc-50">{agent.name}</Link>
                    <div className="truncate text-xs text-zinc-500">{agent.online ? t("onlineLoad", { load: agent.load }) : t("offlineSeen", { ago: ago(agent.lastSeenAt) })}</div>
                </div>
                <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", status.className)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />{t(`status.${agent.status}`)}
                </span>
            </div>
            {agent.reasons.length > 0 && (
                <ul className="space-y-0.5 text-xs text-amber-200/90">
                    {agent.reasons.map((r) => <li key={r} className="flex items-center gap-1.5"><IconAlertTriangle className="h-3 w-3 shrink-0" />{r}</li>)}
                </ul>
            )}
            <div className="grid grid-cols-4 gap-2">
                <Metric label={t("metrics.requests")} value={agent.requests} />
                <Metric label={t("metrics.replies")} value={agent.replies} />
                <Metric label={t("metrics.replyTime")} value={formatDuration(agent.medianResponseMs)} />
                <Metric label={t("metrics.retries")} value={agent.retries} warn={agent.retries > 0} />
                <Metric label={t("metrics.unanswered")} value={agent.unanswered} warn={agent.unanswered > 0} />
                <Metric label={t("metrics.failed")} value={agent.failed} warn={agent.failed > 0} />
                <Metric label={t("metrics.openTasks")} value={agent.overdueTasks ? t("openLate", { open: agent.openTasks, late: agent.overdueTasks }) : agent.openTasks} warn={agent.overdueTasks > 0} />
                <Metric label={t("metrics.done7d")} value={agent.doneTasks} />
            </div>
            <div className="flex items-end justify-between gap-3 border-t border-zinc-800/80 pt-2.5">
                <div className="text-xs text-zinc-500">
                    {t.rich("monthly", { cost: money(agent.monthlyCostCents), tokens: agent.monthlyTokens, num: (chunks) => <span className="tabular-nums text-zinc-300">{chunks}</span> })}
                </div>
                <div className="flex flex-col items-end gap-0.5">
                    <Spark values={agent.repliesByDay} />
                    <span className="text-[10px] text-zinc-600">{t("repliesPerDay")}</span>
                </div>
            </div>
        </article>
    );
}

/**
 * Is every agent doing its job? Unanswered and failed messages surface here
 * first — the silent failures a person would otherwise find by accident.
 */
export function AgentHealthView({ initial }: { initial: CompanyHealth }) {
    const tr = useTranslations("agents.health");
    const ago = useAgo();
    const [health, setHealth] = useState(initial);
    const [refreshing, setRefreshing] = useState(false);

    const refresh = useCallback(async () => {
        setRefreshing(true);
        try {
            const res = await fetch("/api/ui/agents/health", { cache: "no-store" });
            if (res.ok) setHealth(await res.json());
        } finally {
            setRefreshing(false);
        }
    }, []);

    useEffect(() => {
        const interval = setInterval(() => {
            if (document.visibilityState === "visible") void refresh();
        }, 60_000);
        return () => clearInterval(interval);
    }, [refresh]);

    const t = health.totals;
    const down = health.agents.filter((a) => a.status === "down").length;
    return (
        <div className="mx-auto max-w-[1400px] space-y-5 animate-in fade-in duration-300">
            <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                    <Link href="/agents" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"><IconArrowLeft className="h-3.5 w-3.5" />{tr("back")}</Link>
                    <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight text-zinc-100"><IconHeartbeat className="h-6 w-6 text-cyan-300" />{tr("title")}</h1>
                    <p className="mt-0.5 text-xs text-zinc-500">{tr("window", { days: health.windowDays, ago: ago(health.generatedAt) })}</p>
                </div>
                <button type="button" onClick={() => void refresh()} disabled={refreshing} className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:border-cyan-400/40 hover:text-cyan-100 disabled:opacity-50">
                    <IconRefresh className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />{tr("refresh")}
                </button>
            </div>

            <StatsBlock items={[
                { label: tr("stats.online"), value: `${t.online}/${t.agents}`, tone: down ? "negative" : "neutral", hint: down ? tr("stats.down", { count: down }) : undefined, progress: t.agents ? Math.round((t.online / t.agents) * 100) : 0 },
                { label: tr("stats.unanswered"), value: String(t.unanswered), tone: t.unanswered ? "negative" : "positive", hint: t.unanswered ? tr("stats.waitingOver10") : tr("stats.nothingWaiting") },
                { label: tr("stats.failedMessages"), value: String(t.failed), tone: t.failed ? "negative" : "positive", hint: tr("stats.lastDays", { days: health.windowDays }) },
                { label: tr("stats.medianReply"), value: formatDuration(t.medianResponseMs), tone: "neutral", hint: tr("stats.medianReplyHint") },
                { label: tr("stats.costThisMonth"), value: money(t.costCents), tone: "neutral" },
            ]} />

            {health.attention.length > 0 && (
                <section className="emperor-panel rounded-2xl p-4">
                    <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-100"><IconMessageCircleOff className="h-4 w-4 text-amber-300" />{tr("needsAttention")}</h2>
                    <ul className="divide-y divide-zinc-800/80">
                        {health.attention.map((item) => (
                            <li key={`${item.kind}:${item.agentId}:${item.messageId}`}>
                                <Link href={item.link} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg px-2 py-2.5 transition-colors hover:bg-zinc-900">
                                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", item.kind === "failed" ? STATUS.down.className : STATUS.attention.className)}>
                                        {item.kind === "failed" ? tr("failed") : tr("unanswered")}
                                    </span>
                                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-300 sm:w-28 sm:flex-none sm:shrink-0">{item.agentName}</span>
                                    <span className="ml-auto inline-flex shrink-0 items-center gap-1 text-[11px] text-zinc-500 sm:order-last sm:ml-0"><IconClockHour4 className="h-3 w-3" />{ago(item.since)}</span>
                                    <span className="basis-full text-xs text-zinc-400 line-clamp-2 sm:min-w-0 sm:flex-1 sm:line-clamp-1">{item.text || tr("attachment")}</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {health.agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
                {health.agents.length === 0 && <div className="col-span-full py-16 text-center text-sm text-zinc-500">{tr("empty")}</div>}
            </section>
        </div>
    );
}
