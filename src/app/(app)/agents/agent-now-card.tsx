"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import type { AgentNow } from "@/lib/agent-activity";

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
                {now.activity ? (
                    <p className="font-mono text-xs text-zinc-300 line-clamp-3 whitespace-pre-wrap">{now.activity}</p>
                ) : now.state === "idle" ? (
                    <p className="text-xs text-zinc-500">Idle — waiting for work.</p>
                ) : now.state === "offline" ? (
                    <p className="text-xs text-zinc-500">{now.lastSeenAt ? `Last seen ${formatAgo(now.lastSeenAt, nowMs)}` : "Never connected"}</p>
                ) : null}
            </div>

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
                        {now.lastRun.costCents != null && <span>${(now.lastRun.costCents / 100).toFixed(2)}</span>}
                        {now.lastRun.toolCalls != null && <span>{now.lastRun.toolCalls} {now.lastRun.toolCalls === 1 ? "tool" : "tools"}</span>}
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
