"use client";

import { memo, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
    IconAlertTriangle,
    IconArrowRight,
    IconChevronDown,
    IconCornerDownRight,
    IconFileText,
    IconFlag,
    IconLock,
    IconMessage2,
    IconNote,
    IconPlayerPlay,
    IconShieldCheck,
    IconShieldQuestion,
    IconShieldX,
    IconSparkles,
    IconUserShare,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { RunTimeline } from "@/components/run-timeline";
import { RichText } from "@/components/rich-text";
import { formatRunDuration, formatTokenCount } from "@/lib/run-ledger-copy";
import {
    formatCost,
    groupStoryByDay,
    RUN_OUTCOME_LABEL,
    type RunOutcome,
    type StoryApprovalEntry,
    type StoryArtifactEntry,
    type StoryEntry,
    type StoryEventEntry,
    type StoryMessageEntry,
    type StoryRun,
} from "@/lib/task-story";

const OUTCOME_TONE: Record<RunOutcome, string> = {
    running: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
    done: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    needs_you: "border-amber-500/40 bg-amber-500/10 text-amber-300",
    failed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    stopped: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
};

const OUTCOME_DOT: Record<RunOutcome, string> = {
    running: "bg-cyan-400",
    done: "bg-emerald-400",
    needs_you: "bg-amber-400",
    failed: "bg-rose-400",
    stopped: "bg-zinc-500",
};

export function OutcomePill({ outcome, className }: { outcome: RunOutcome; className?: string }) {
    return (
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", OUTCOME_TONE[outcome], className)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", OUTCOME_DOT[outcome])} aria-hidden="true" />
            {RUN_OUTCOME_LABEL[outcome]}
        </span>
    );
}

function timeLabel(iso: string, timeZone: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
}

function fullTime(iso: string, timeZone: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "4m 12s · 12 tools · 18.2k tokens · $0.21 · deepseek-v4" for a run block header. */
export function runStats(run: Pick<StoryRun, "durationMs" | "toolCalls" | "inputTokens" | "outputTokens" | "costCents">): string[] {
    const parts: string[] = [];
    if (run.durationMs != null) parts.push(formatRunDuration(run.durationMs));
    if (run.toolCalls != null) parts.push(`${run.toolCalls} ${run.toolCalls === 1 ? "tool" : "tools"}`);
    const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
    if (tokens > 0) parts.push(`${formatTokenCount(tokens)} tokens`);
    const cost = formatCost(run.costCents);
    if (cost) parts.push(cost);
    return parts;
}

// ─── Rows ───────────────────────────────────────────────────────────────────

/** One row: time gutter, rail marker, content. */
function Row({ time, title, marker, children, id, highlight }: { time: string; title: string; marker: React.ReactNode; children: React.ReactNode; id?: string; highlight?: boolean }) {
    return (
        <li id={id} className={cn("group/row relative grid scroll-mt-24 grid-cols-[2.75rem_1.5rem_minmax(0,1fr)] gap-x-2 sm:grid-cols-[3.25rem_1.75rem_minmax(0,1fr)] sm:gap-x-3", highlight && "rounded-xl bg-cyan-500/[0.04] ring-1 ring-cyan-500/30")}>
            <time className="pt-[3px] text-right font-mono text-[11px] tabular-nums text-zinc-500" title={title}>{time}</time>
            <div className="relative flex justify-center">
                <span className="absolute inset-y-0 w-px bg-zinc-800 group-first/row:top-3 group-last/row:bottom-auto group-last/row:h-3" aria-hidden="true" />
                <span className="relative z-[1] mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border border-zinc-800 bg-zinc-950">{marker}</span>
            </div>
            <div className="min-w-0 pb-5">{children}</div>
        </li>
    );
}

const EVENT_ICON: Record<StoryEventEntry["tone"], { icon: typeof IconNote; className: string }> = {
    note: { icon: IconNote, className: "text-zinc-300" },
    state: { icon: IconArrowRight, className: "text-cyan-300" },
    assign: { icon: IconUserShare, className: "text-zinc-300" },
    created: { icon: IconSparkles, className: "text-zinc-400" },
    system: { icon: IconFlag, className: "text-zinc-500" },
    problem: { icon: IconAlertTriangle, className: "text-amber-300" },
};

function actorLabel(entry: StoryEventEntry): string | null {
    if (entry.actor.name) return entry.actor.name;
    if (entry.actor.type === "human") return "A person";
    if (entry.actor.type === "system") return "System";
    return null;
}

function EventRow({ entry, timeZone }: { entry: StoryEventEntry; timeZone: string }) {
    const { icon: Icon, className } = EVENT_ICON[entry.tone];
    const actor = actorLabel(entry);
    return (
        <Row time={timeLabel(entry.at, timeZone)} title={fullTime(entry.at, timeZone)} marker={<Icon className={cn("h-3 w-3", className)} aria-hidden="true" />}>
            <p className="text-sm leading-6 text-zinc-200">
                {entry.text}
                {actor && <span className="text-zinc-500"> · {actor}</span>}
            </p>
            {entry.note && (
                <div className={cn(
                    "mt-1.5 rounded-xl border px-3 py-2",
                    entry.tone === "problem" ? "border-amber-500/20 bg-amber-500/[0.06]" : "border-zinc-800 bg-zinc-900/60",
                )}>
                    <RichText content={entry.note} collapsedHeight={220} />
                </div>
            )}
        </Row>
    );
}

const ACTION_LABEL: Record<string, string> = {
    task_done: "Mark the task done",
    send_email: "Send an email",
    publish: "Publish",
    spend: "Spend money",
    delete: "Delete something",
};

function ApprovalRow({ entry, timeZone }: { entry: StoryApprovalEntry; timeZone: string }) {
    const action = ACTION_LABEL[entry.actionType] ?? entry.actionType.replace(/_/g, " ");
    const requested = entry.phase === "requested";
    const pending = requested && entry.status === "pending";
    const Icon = requested ? IconShieldQuestion : entry.status === "approved" ? IconShieldCheck : IconShieldX;
    const iconTone = requested ? (pending ? "text-amber-300" : "text-zinc-400") : entry.status === "approved" ? "text-emerald-300" : "text-rose-300";
    const decision = entry.status === "approved" ? "Approved" : entry.status === "rejected" ? "Rejected" : entry.status === "expired" ? "Expired" : entry.status === "dismissed" ? "Dismissed" : entry.status;
    return (
        <Row time={timeLabel(entry.at, timeZone)} title={fullTime(entry.at, timeZone)} marker={<Icon className={cn("h-3 w-3", iconTone)} aria-hidden="true" />}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm leading-6 text-zinc-200">
                    {requested ? (
                        <>Approval requested: <span className="text-zinc-100">{action}</span>{entry.requesterName && <span className="text-zinc-500"> · {entry.requesterName}</span>}</>
                    ) : (
                        <>{decision}: <span className="text-zinc-100">{action}</span>{entry.resolverName && <span className="text-zinc-500"> · {entry.resolverName}</span>}</>
                    )}
                </p>
                {pending && (
                    <Link href="/approvals" className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20">
                        Review
                    </Link>
                )}
            </div>
            {entry.note && (
                <div className="mt-1.5 border-l border-zinc-700 pl-3 text-zinc-400">
                    <RichText content={entry.note} collapsedHeight={180} />
                </div>
            )}
        </Row>
    );
}

function ArtifactRow({ entry, timeZone }: { entry: StoryArtifactEntry; timeZone: string }) {
    return (
        <Row time={timeLabel(entry.at, timeZone)} title={fullTime(entry.at, timeZone)} marker={<IconFileText className="h-3 w-3 text-sky-300" aria-hidden="true" />}>
            <p className="text-sm leading-6 text-zinc-400">
                {entry.agentName ? `${entry.agentName} saved a file` : "File saved"}
            </p>
            <Link
                href={`/artifacts?artifact=${encodeURIComponent(entry.id)}`}
                className="mt-1 flex max-w-md items-center gap-3 rounded-xl border border-zinc-800 bg-zinc-900/60 px-3 py-2 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
            >
                <IconFileText className="h-5 w-5 shrink-0 text-zinc-400" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-zinc-100">{entry.title}</span>
                    <span className="block truncate text-[11px] text-zinc-500">{[entry.contentType, formatBytes(entry.sizeBytes)].filter(Boolean).join(" · ")}</span>
                </span>
            </Link>
        </Row>
    );
}

function MessageRow({ entry, timeZone }: { entry: StoryMessageEntry; timeZone: string }) {
    return (
        <Row time={timeLabel(entry.at, timeZone)} title={fullTime(entry.at, timeZone)} marker={entry.text == null ? <IconLock className="h-3 w-3 text-zinc-500" aria-hidden="true" /> : <IconMessage2 className="h-3 w-3 text-zinc-300" aria-hidden="true" />}>
            <p className="text-sm leading-6 text-zinc-400">
                <span className="text-zinc-200">{entry.senderLabel}</span> in {entry.threadLabel}
                {entry.href && (
                    <Link href={entry.href} className="ml-2 text-xs text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline">Open chat</Link>
                )}
            </p>
            {entry.text == null
                ? <p className="mt-1 text-xs italic text-zinc-500">Private chat. Only its participants can read it.</p>
                : <div className="mt-1"><RichText content={entry.text} collapsedHeight={200} /></div>}
        </Row>
    );
}

/**
 * A finished run as a collapsible block: outcome, agent, duration, tools,
 * tokens, cost and model in the header; expanding mounts the run's steps
 * (loaded on demand). The reply it produced is linked under it.
 */
export const RunBlock = memo(function RunBlock({ run, timeZone, defaultOpen = false }: { run: StoryRun; timeZone: string; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen);
    const stats = runStats(run);
    const model = run.model?.trim();
    const panelId = `run-${run.id}-steps`;
    return (
        <Row
            id={`run-${run.id}`}
            highlight={defaultOpen}
            time={timeLabel(run.startedAt, timeZone)}
            title={fullTime(run.startedAt, timeZone)}
            marker={<IconPlayerPlay className={cn("h-2.5 w-2.5", run.outcome === "failed" ? "text-rose-300" : run.outcome === "needs_you" ? "text-amber-300" : run.outcome === "done" ? "text-emerald-300" : "text-zinc-400")} aria-hidden="true" />}
        >
            <div className={cn(
                "overflow-hidden rounded-xl border bg-zinc-900/50 transition-colors",
                open ? "border-zinc-700" : "border-zinc-800 hover:border-zinc-700",
            )}>
                <button
                    type="button"
                    onClick={() => setOpen((value) => !value)}
                    aria-expanded={open}
                    aria-controls={panelId}
                    className="flex w-full min-w-0 flex-col gap-1.5 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/60 sm:flex-row sm:items-center sm:gap-3"
                >
                    <span className="flex min-w-0 items-center gap-2">
                        <OutcomePill outcome={run.outcome} />
                        <span className="truncate text-sm font-medium text-zinc-100">{run.agentName ?? "Agent"}</span>
                        {run.private && <IconLock className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-label="Private chat" />}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
                        <span className="min-w-0 truncate text-xs tabular-nums text-zinc-400">
                            {stats.join(" · ")}
                            {model && <span className="hidden text-zinc-500 md:inline"> · {model.length > 32 ? `${model.slice(0, 31)}…` : model}</span>}
                        </span>
                        <IconChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-zinc-500 transition-transform sm:ml-0", open && "rotate-180")} aria-hidden="true" />
                    </span>
                </button>

                {run.reply && (
                    <div className="flex min-w-0 items-start gap-2 border-t border-zinc-800/80 px-3 py-2">
                        <IconCornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                        <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-400">
                            <span className="text-zinc-500">Reply{run.threadLabel ? ` in ${run.threadLabel}` : ""}</span>
                            {run.reply.excerpt
                                ? <span className="line-clamp-2 text-zinc-300">“{run.reply.excerpt}”</span>
                                : <span className="block italic text-zinc-500">Private chat. Only its participants can read it.</span>}
                        </p>
                        {run.threadHref && (
                            <Link href={run.threadHref} className="shrink-0 text-xs text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline">
                                Open chat
                            </Link>
                        )}
                    </div>
                )}

                {open && (
                    <div id={panelId} className="space-y-2 border-t border-zinc-800/80 bg-zinc-950/50 px-3 py-3">
                        <RunTimeline runId={run.id} />
                    </div>
                )}
            </div>
        </Row>
    );
});

function EntryRow({ entry, timeZone, focusRunId }: { entry: StoryEntry; timeZone: string; focusRunId: string | null }) {
    switch (entry.kind) {
        case "event": return <EventRow entry={entry} timeZone={timeZone} />;
        case "approval": return <ApprovalRow entry={entry} timeZone={timeZone} />;
        case "artifact": return <ArtifactRow entry={entry} timeZone={timeZone} />;
        case "message": return <MessageRow entry={entry} timeZone={timeZone} />;
        case "run": {
            // Keyed on focus so a #run-<id> link arriving after mount opens it.
            const focused = focusRunId === entry.run.id;
            return <RunBlock key={focused ? "focused" : "plain"} run={entry.run} timeZone={timeZone} defaultOpen={focused} />;
        }
    }
}

/** `#run-<id>` in the URL opens and scrolls to that run (links from chat replies and the Right now card). */
function useFocusRunId(): string | null {
    const [runId, setRunId] = useState<string | null>(null);
    useEffect(() => {
        const read = () => {
            const match = /^#run-([0-9a-f-]{36})$/i.exec(window.location.hash);
            setRunId(match ? match[1] : null);
        };
        read();
        window.addEventListener("hashchange", read);
        return () => window.removeEventListener("hashchange", read);
    }, []);
    useEffect(() => {
        if (!runId) return;
        const el = document.getElementById(`run-${runId}`);
        el?.scrollIntoView({ block: "center" });
    }, [runId]);
    return runId;
}

export function TaskStoryTimeline({ entries, timeZone, nowIso }: { entries: readonly StoryEntry[]; timeZone: string; nowIso: string }) {
    const focusRunId = useFocusRunId();
    const days = useMemo(() => groupStoryByDay(entries, { now: new Date(nowIso), timeZone }), [entries, nowIso, timeZone]);
    if (entries.length === 0) {
        return (
            <div className="rounded-2xl border border-dashed border-zinc-800 px-5 py-10 text-center">
                <p className="text-sm text-zinc-300">Nothing has happened on this task yet.</p>
                <p className="mt-1 text-xs text-zinc-500">Runs, notes, approvals and files show up here as the work moves.</p>
            </div>
        );
    }
    return (
        <div className="space-y-6">
            {days.map((day) => (
                <section key={day.key} aria-labelledby={`day-${day.key}`}>
                    <h3 id={`day-${day.key}`} className="mb-3 flex items-center gap-3">
                        <span className="text-xs font-semibold text-zinc-300">{day.label}</span>
                        <span className="h-px flex-1 bg-zinc-800" aria-hidden="true" />
                    </h3>
                    <ol className="space-y-0">
                        {day.entries.map((entry) => <EntryRow key={`${entry.kind}:${entry.id}`} entry={entry} timeZone={timeZone} focusRunId={focusRunId} />)}
                    </ol>
                </section>
            ))}
        </div>
    );
}
