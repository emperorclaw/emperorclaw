"use client";

import { memo, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useFormatter, useTranslations } from "next-intl";
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
import { FailureFixButton } from "@/components/failure-fix";
import { describeFailure, type FixAudience } from "@/lib/failure-cause";
import { formatRunDuration, formatTokenCount } from "@/lib/run-ledger-copy";
import {
    formatCost,
    groupStoryByDay,
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
    const t = useTranslations("tasks.timeline.outcomes");
    return (
        <span className={cn("inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium", OUTCOME_TONE[outcome], className)}>
            <span className={cn("h-1.5 w-1.5 rounded-full", OUTCOME_DOT[outcome])} aria-hidden="true" />
            {t(outcome)}
        </span>
    );
}

function timeLabel(iso: string, timeZone: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    return new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone }).format(date);
}

/** "Oct 29, 2026, 2:05 PM" in the person's language and the given zone. */
function useFullTime() {
    const format = useFormatter();
    return (iso: string, timeZone: string): string => {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return iso;
        return format.dateTime(date, { dateStyle: "medium", timeStyle: "short", timeZone });
    };
}

function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

type RunStatsLabels = { tools: (count: number) => string; tokens: (amount: string) => string };

/** "4m 12s · 12 tools · 18.2k tokens · $0.21 · deepseek-v4" for a run block header. */
export function runStats(run: Pick<StoryRun, "durationMs" | "toolCalls" | "inputTokens" | "outputTokens" | "costCents">, labels: RunStatsLabels): string[] {
    const parts: string[] = [];
    if (run.durationMs != null) parts.push(formatRunDuration(run.durationMs));
    if (run.toolCalls != null) parts.push(labels.tools(run.toolCalls));
    const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
    if (tokens > 0) parts.push(labels.tokens(formatTokenCount(tokens)));
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

function actorLabel(entry: StoryEventEntry, t: ReturnType<typeof useTranslations<"tasks.timeline">>): string | null {
    if (entry.actor.name) return entry.actor.name;
    if (entry.actor.type === "human") return t("aPerson");
    if (entry.actor.type === "system") return t("system");
    return null;
}

function EventRow({ entry, timeZone }: { entry: StoryEventEntry; timeZone: string }) {
    const t = useTranslations("tasks.timeline");
    const fullTime = useFullTime();
    const { icon: Icon, className } = EVENT_ICON[entry.tone];
    const actor = actorLabel(entry, t);
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

/** Approval actions with a label under tasks.timeline.actions (anything else shows as is). */
const APPROVAL_ACTIONS = new Set(["task_done", "send_email", "publish", "spend", "delete"]);

function ApprovalRow({ entry, timeZone }: { entry: StoryApprovalEntry; timeZone: string }) {
    const t = useTranslations("tasks.timeline");
    const fullTime = useFullTime();
    const action = APPROVAL_ACTIONS.has(entry.actionType) ? t(`actions.${entry.actionType as "publish"}`) : entry.actionType.replace(/_/g, " ");
    const requested = entry.phase === "requested";
    const pending = requested && entry.status === "pending";
    const Icon = requested ? IconShieldQuestion : entry.status === "approved" ? IconShieldCheck : IconShieldX;
    const iconTone = requested ? (pending ? "text-amber-300" : "text-zinc-400") : entry.status === "approved" ? "text-emerald-300" : "text-rose-300";
    const decision = entry.status === "approved" ? t("approved") : entry.status === "rejected" ? t("rejected") : entry.status === "expired" ? t("expired") : entry.status === "dismissed" ? t("dismissed") : entry.status;
    return (
        <Row time={timeLabel(entry.at, timeZone)} title={fullTime(entry.at, timeZone)} marker={<Icon className={cn("h-3 w-3", iconTone)} aria-hidden="true" />}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-sm leading-6 text-zinc-200">
                    {requested ? (
                        <>{t("approvalRequested")} <span className="text-zinc-100">{action}</span>{entry.requesterName && <span className="text-zinc-500"> · {entry.requesterName}</span>}</>
                    ) : (
                        <>{decision}: <span className="text-zinc-100">{action}</span>{entry.resolverName && <span className="text-zinc-500"> · {entry.resolverName}</span>}</>
                    )}
                </p>
                {pending && (
                    <Link href="/approvals" className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-200 transition-colors hover:bg-amber-500/20">
                        {t("review")}
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
    const t = useTranslations("tasks.timeline");
    const fullTime = useFullTime();
    return (
        <Row time={timeLabel(entry.at, timeZone)} title={fullTime(entry.at, timeZone)} marker={<IconFileText className="h-3 w-3 text-sky-300" aria-hidden="true" />}>
            <p className="text-sm leading-6 text-zinc-400">
                {entry.agentName ? t("agentSavedFile", { name: entry.agentName }) : t("fileSaved")}
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
    const t = useTranslations("tasks.timeline");
    const fullTime = useFullTime();
    return (
        <Row time={timeLabel(entry.at, timeZone)} title={fullTime(entry.at, timeZone)} marker={entry.text == null ? <IconLock className="h-3 w-3 text-zinc-500" aria-hidden="true" /> : <IconMessage2 className="h-3 w-3 text-zinc-300" aria-hidden="true" />}>
            <p className="text-sm leading-6 text-zinc-400">
                {t.rich("senderIn", { sender: entry.senderLabel, thread: entry.threadLabel, strong: (chunks) => <span className="text-zinc-200">{chunks}</span> })}
                {entry.href && (
                    <Link href={entry.href} className="ml-2 text-xs text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline">{t("openChat")}</Link>
                )}
            </p>
            {entry.text == null
                ? <p className="mt-1 text-xs italic text-zinc-500">{t("privateChat")}</p>
                : <div className="mt-1"><RichText content={entry.text} collapsedHeight={200} /></div>}
        </Row>
    );
}

/** Who is looking and which task, so a failed run can offer its fix. */
export interface RunFixContext {
    audience: FixAudience;
    taskId: string;
    /** The task's current agent assignee: Nudge/Retry go to it, else to the run's agent. */
    taskAssigneeId: string | null;
}

const FIX_BUTTON = "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-cyan-400/10 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-400/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50";

/** A failed run's one plain cause and, on the task's latest run, its one fix. */
function RunFailure({ run, fixContext }: { run: StoryRun; fixContext: RunFixContext | null }) {
    const failure = describeFailure(
        { texts: [run.error, run.exitReason], runStatus: run.status },
        {
            audience: fixContext?.audience ?? "viewer", agentId: run.agentId, taskId: fixContext?.taskId ?? null,
            taskAssigneeId: fixContext?.taskAssigneeId ?? null, failedAt: run.endedAt ?? run.startedAt,
        },
    );
    return (
        <div className="flex min-w-0 flex-col gap-2 border-t border-rose-500/15 bg-rose-500/[0.04] px-3 py-2 sm:flex-row sm:items-center">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-rose-200">
                <IconAlertTriangle className="mr-1.5 inline h-3.5 w-3.5 -translate-y-px text-rose-300" aria-hidden="true" />
                {failure.headline}
                {failure.detail && <span className="text-rose-200/70">: {failure.detail}</span>}
            </p>
            {failure.fix && <FailureFixButton fix={failure.fix} className={FIX_BUTTON} />}
        </div>
    );
}

/**
 * A finished run as a collapsible block: outcome, agent, duration, tools,
 * tokens, cost and model in the header; expanding mounts the run's steps
 * (loaded on demand). The reply it produced is linked under it. A failed run
 * says why in one line; `fixContext` (the task's latest run only) adds the fix.
 */
export const RunBlock = memo(function RunBlock({ run, timeZone, defaultOpen = false, fixContext = null }: { run: StoryRun; timeZone: string; defaultOpen?: boolean; fixContext?: RunFixContext | null }) {
    const t = useTranslations("tasks.timeline");
    const fullTime = useFullTime();
    const [open, setOpen] = useState(defaultOpen);
    const stats = runStats(run, { tools: (count) => t("tools", { count }), tokens: (amount) => t("tokens", { amount }) });
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
                        <span className="truncate text-sm font-medium text-zinc-100">{run.agentName ?? t("agent")}</span>
                        {run.private && <IconLock className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-label={t("privateChatLabel")} />}
                    </span>
                    <span className="flex min-w-0 flex-1 items-center gap-2 sm:justify-end">
                        <span className="min-w-0 truncate text-xs tabular-nums text-zinc-400">
                            {stats.join(" · ")}
                            {model && <span className="hidden text-zinc-500 md:inline"> · {model.length > 32 ? `${model.slice(0, 31)}…` : model}</span>}
                        </span>
                        <IconChevronDown className={cn("ml-auto h-4 w-4 shrink-0 text-zinc-500 transition-transform sm:ml-0", open && "rotate-180")} aria-hidden="true" />
                    </span>
                </button>

                {run.outcome === "failed" && <RunFailure run={run} fixContext={fixContext} />}

                {run.reply && (
                    <div className="flex min-w-0 items-start gap-2 border-t border-zinc-800/80 px-3 py-2">
                        <IconCornerDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                        <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-400">
                            <span className="text-zinc-500">{run.threadLabel ? t("replyIn", { thread: run.threadLabel }) : t("reply")}</span>
                            {run.reply.excerpt
                                ? <span className="line-clamp-2 text-zinc-300">{t("quoted", { text: run.reply.excerpt })}</span>
                                : <span className="block italic text-zinc-500">{t("privateChat")}</span>}
                        </p>
                        {run.threadHref && (
                            <Link href={run.threadHref} className="shrink-0 text-xs text-cyan-300 underline-offset-2 hover:text-cyan-200 hover:underline">
                                {t("openChat")}
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

function EntryRow({ entry, timeZone, focusRunId, fixContext }: { entry: StoryEntry; timeZone: string; focusRunId: string | null; fixContext: RunFixContext | null }) {
    switch (entry.kind) {
        case "event": return <EventRow entry={entry} timeZone={timeZone} />;
        case "approval": return <ApprovalRow entry={entry} timeZone={timeZone} />;
        case "artifact": return <ArtifactRow entry={entry} timeZone={timeZone} />;
        case "message": return <MessageRow entry={entry} timeZone={timeZone} />;
        case "run": {
            // Keyed on focus so a #run-<id> link arriving after mount opens it.
            const focused = focusRunId === entry.run.id;
            return <RunBlock key={focused ? "focused" : "plain"} run={entry.run} timeZone={timeZone} defaultOpen={focused} fixContext={fixContext} />;
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

export function TaskStoryTimeline({ entries, timeZone, nowIso, fixContext = null }: { entries: readonly StoryEntry[]; timeZone: string; nowIso: string; fixContext?: RunFixContext | null }) {
    const t = useTranslations("tasks.timeline");
    const focusRunId = useFocusRunId();
    const days = useMemo(() => groupStoryByDay(entries, { now: new Date(nowIso), timeZone }), [entries, nowIso, timeZone]);
    // Only the newest run can still be fixed; older failures keep their cause line without a button.
    const latestRunId = useMemo(() => entries.find((entry) => entry.kind === "run")?.id ?? null, [entries]);
    if (entries.length === 0) {
        return (
            <div className="rounded-2xl border border-dashed border-zinc-800 px-5 py-10 text-center">
                <p className="text-sm text-zinc-300">{t("empty")}</p>
                <p className="mt-1 text-xs text-zinc-500">{t("emptyHint")}</p>
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
                        {day.entries.map((entry) => <EntryRow key={`${entry.kind}:${entry.id}`} entry={entry} timeZone={timeZone} focusRunId={focusRunId} fixContext={entry.kind === "run" && entry.id === latestRunId ? fixContext : null} />)}
                    </ol>
                </section>
            ))}
        </div>
    );
}
