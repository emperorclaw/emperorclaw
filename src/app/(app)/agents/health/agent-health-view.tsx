"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { IconAlertTriangle, IconArrowLeft, IconClockHour4, IconHeartbeat, IconMessageCircleOff, IconRefresh } from "@tabler/icons-react";
import { StatsBlock } from "@/components/rich/stats-block";
import type { AgentHealth, CompanyHealth, HealthStatus } from "@/lib/agent-health";
import { cn } from "@/lib/utils";

const STATUS: Record<HealthStatus, { label: string; className: string; dot: string }> = {
    down: { label: "Down", className: "bg-rose-500/12 text-rose-300 ring-rose-500/30", dot: "bg-rose-400" },
    attention: { label: "Needs attention", className: "bg-amber-500/12 text-amber-200 ring-amber-500/30", dot: "bg-amber-400" },
    healthy: { label: "Healthy", className: "bg-emerald-500/12 text-emerald-300 ring-emerald-500/25", dot: "bg-emerald-400" },
    idle: { label: "Idle", className: "bg-zinc-500/12 text-zinc-400 ring-zinc-500/25", dot: "bg-zinc-500" },
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

function ago(iso: string | null): string {
    if (!iso) return "never";
    return `${formatDuration(Date.now() - new Date(iso).getTime())} ago`;
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
    const status = STATUS[agent.status];
    return (
        <article className="emperor-panel flex min-w-0 flex-col gap-3 rounded-2xl p-4">
            <div className="flex items-start gap-3">
                <Link href={`/agents?agent=${agent.id}`} className="relative shrink-0">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={agent.avatarUrl || `https://api.dicebear.com/9.x/pixel-art/svg?seed=${encodeURIComponent(agent.id)}`} alt="" className="h-10 w-10 rounded-xl border border-zinc-800 bg-zinc-900 object-cover" />
                    <span className={cn("absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-zinc-950", agent.online ? "bg-emerald-400" : "bg-zinc-600")} />
                </Link>
                <div className="min-w-0 flex-1">
                    <Link href={`/agents?agent=${agent.id}`} className="block truncate text-sm font-semibold text-zinc-100 hover:text-white">{agent.name}</Link>
                    <div className="truncate text-xs text-zinc-500">{agent.online ? `Online · load ${agent.load}` : `Offline · seen ${ago(agent.lastSeenAt)}`}</div>
                </div>
                <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", status.className)}>
                    <span className={cn("h-1.5 w-1.5 rounded-full", status.dot)} />{status.label}
                </span>
            </div>
            {agent.reasons.length > 0 && (
                <ul className="space-y-0.5 text-xs text-amber-200/90">
                    {agent.reasons.map((r) => <li key={r} className="flex items-center gap-1.5"><IconAlertTriangle className="h-3 w-3 shrink-0" />{r}</li>)}
                </ul>
            )}
            <div className="grid grid-cols-4 gap-2">
                <Metric label="Requests" value={agent.requests} />
                <Metric label="Replies" value={agent.replies} />
                <Metric label="Reply time" value={formatDuration(agent.medianResponseMs)} />
                <Metric label="Retries" value={agent.retries} warn={agent.retries > 0} />
                <Metric label="Unanswered" value={agent.unanswered} warn={agent.unanswered > 0} />
                <Metric label="Failed" value={agent.failed} warn={agent.failed > 0} />
                <Metric label="Open tasks" value={agent.overdueTasks ? `${agent.openTasks} · ${agent.overdueTasks} late` : agent.openTasks} warn={agent.overdueTasks > 0} />
                <Metric label="Done (7d)" value={agent.doneTasks} />
            </div>
            <div className="flex items-end justify-between gap-3 border-t border-zinc-800/80 pt-2.5">
                <div className="text-xs text-zinc-500">
                    <span className="tabular-nums text-zinc-300">{money(agent.monthlyCostCents)}</span> this month · {agent.monthlyTokens.toLocaleString()} tokens
                </div>
                <div className="flex flex-col items-end gap-0.5">
                    <Spark values={agent.repliesByDay} />
                    <span className="text-[10px] text-zinc-600">replies / day</span>
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
                    <Link href="/agents" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-300"><IconArrowLeft className="h-3.5 w-3.5" />Agents</Link>
                    <h1 className="mt-1 flex items-center gap-2 text-2xl font-semibold tracking-tight text-zinc-100"><IconHeartbeat className="h-6 w-6 text-cyan-300" />Agent health</h1>
                    <p className="mt-0.5 text-xs text-zinc-500">Last {health.windowDays} days · updated {ago(health.generatedAt)}</p>
                </div>
                <button type="button" onClick={() => void refresh()} disabled={refreshing} className="inline-flex items-center gap-1.5 rounded-xl border border-zinc-800 px-3 py-2 text-xs text-zinc-300 hover:border-cyan-400/40 hover:text-cyan-100 disabled:opacity-50">
                    <IconRefresh className={cn("h-3.5 w-3.5", refreshing && "animate-spin")} />Refresh
                </button>
            </div>

            <StatsBlock items={[
                { label: "Online", value: `${t.online}/${t.agents}`, tone: down ? "negative" : "neutral", hint: down ? `${down} down` : undefined, progress: t.agents ? Math.round((t.online / t.agents) * 100) : 0 },
                { label: "Unanswered", value: String(t.unanswered), tone: t.unanswered ? "negative" : "positive", hint: t.unanswered ? "waiting over 10 min" : "nothing waiting" },
                { label: "Failed messages", value: String(t.failed), tone: t.failed ? "negative" : "positive", hint: `last ${health.windowDays} days` },
                { label: "Median reply", value: formatDuration(t.medianResponseMs), tone: "neutral", hint: "request → agent reply" },
                { label: "Cost this month", value: money(t.costCents), tone: "neutral" },
            ]} />

            {health.attention.length > 0 && (
                <section className="emperor-panel rounded-2xl p-4">
                    <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-zinc-100"><IconMessageCircleOff className="h-4 w-4 text-amber-300" />Needs attention</h2>
                    <ul className="divide-y divide-zinc-800/80">
                        {health.attention.map((item) => (
                            <li key={`${item.kind}:${item.agentId}:${item.messageId}`}>
                                <Link href={item.link} className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-zinc-900">
                                    <span className={cn("shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset", item.kind === "failed" ? STATUS.down.className : STATUS.attention.className)}>
                                        {item.kind === "failed" ? "Failed" : "Unanswered"}
                                    </span>
                                    <span className="w-28 shrink-0 truncate text-xs font-medium text-zinc-300">{item.agentName}</span>
                                    <span className="min-w-0 flex-1 truncate text-xs text-zinc-400">{item.text || "(attachment)"}</span>
                                    <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-zinc-500"><IconClockHour4 className="h-3 w-3" />{ago(item.since)}</span>
                                </Link>
                            </li>
                        ))}
                    </ul>
                </section>
            )}

            <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                {health.agents.map((agent) => <AgentCard key={agent.id} agent={agent} />)}
                {health.agents.length === 0 && <div className="col-span-full py-16 text-center text-sm text-zinc-500">No agents yet.</div>}
            </section>
        </div>
    );
}
