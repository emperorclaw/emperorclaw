"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import {
    IconAlertTriangle, IconCheck, IconChevronRight, IconCircleCheck, IconClock, IconFileText, IconMessageCircle, IconPlugConnectedX, IconRefresh, IconX, IconPlayerPlay,
} from "@tabler/icons-react";
import { timeAgo, type AttentionEntry, type AttentionKind, type DashboardMember } from "@/lib/team-scene";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const KIND_STYLE: Record<AttentionKind, { icon: typeof IconFileText; tile: string; verb: string }> = {
    approval: { icon: IconFileText, tile: "bg-sky-500/10 text-sky-500 ring-sky-500/25 dark:text-sky-300", verb: "Approve" },
    message: { icon: IconMessageCircle, tile: "bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-300", verb: "Delivery" },
    incident: { icon: IconAlertTriangle, tile: "bg-rose-500/10 text-rose-500 ring-rose-500/25 dark:text-rose-300", verb: "Task issue" },
    agent: { icon: IconPlugConnectedX, tile: "bg-rose-500/10 text-rose-500 ring-rose-500/25 dark:text-rose-300", verb: "Connection" },
    late: { icon: IconClock, tile: "bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-300", verb: "Running late" },
    not_started: { icon: IconClock, tile: "bg-amber-500/10 text-amber-600 ring-amber-500/25 dark:text-amber-300", verb: "Hasn't started" },
    paused: { icon: IconPlayerPlay, tile: "bg-violet-500/10 text-violet-500 ring-violet-500/25 dark:text-violet-300", verb: "Paused" },
};

const VISIBLE = 4;

export function NeedsAttention({ entries, now, onFocusMember, canAct, agents, watchlist = false }: {
    entries: AttentionEntry[];
    now: Date;
    onFocusMember: (key: string) => void;
    canAct: boolean;
    agents: DashboardMember[];
    watchlist?: boolean;
}) {
    const router = useRouter();
    const [expanded, setExpanded] = useState(false);
    const titleId = watchlist ? "watchlist-title" : "needs-attention-title";
    const [busyId, setBusyId] = useState<string | null>(null);

    const run = async (id: string, fn: () => Promise<void>, success: string) => {
        setBusyId(id);
        try {
            await fn();
            toast.success(success);
            router.refresh();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Something went wrong");
        } finally {
            setBusyId(null);
        }
    };

    const approve = (entry: AttentionEntry, decision: "approved" | "rejected") =>
        run(entry.id, async () => {
            if (!entry.approvalId) throw new Error("Approval id missing");
            const res = await fetch(`/api/approvals/${entry.approvalId}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ status: decision }),
            });
            if (!res.ok) throw new Error("Couldn't record the decision");
        }, decision === "approved" ? "Approved." : "Sent back.");

    const resume = (entry: AttentionEntry) =>
        run(entry.id, async () => {
            if (!entry.threadId) throw new Error("Thread missing");
            const res = await fetch("/api/chat/loop-resume", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ threadId: entry.threadId }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({})) as { error?: string };
                throw new Error(data.error || "Couldn't resume");
            }
        }, "Resumed the conversation.");

    const restart = (entry: AttentionEntry) =>
        run(entry.id, async () => {
            if (!entry.agentId) throw new Error("Agent id missing");
            const res = await fetch(`/api/agents/${entry.agentId}/recreate-runtime`, { method: "POST" });
            const data = await res.json().catch(() => ({})) as { error?: string; success?: boolean; message?: string };
            if (!res.ok || data.success === false) throw new Error(data.error || data.message || "Couldn't restart the runtime");
        }, "Restarting runtime…");

    const reassign = (entry: AttentionEntry, target: { type: "agent" | "human"; id: string }) =>
        run(entry.id, async () => {
            if (!entry.taskId) throw new Error("Task missing");
            const res = await fetch(`/api/tasks/${entry.taskId}`, {
                method: "PATCH", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ assignee: target }),
            });
            if (!res.ok) throw new Error("Couldn't reassign the task");
        }, "Task reassigned.");

    return (
        <section aria-labelledby={titleId} className="emperor-panel rounded-2xl p-4">
            <header className="flex items-start gap-2.5">
                <IconAlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" stroke={1.8} />
                <div className="min-w-0 flex-1">
                    <h2 id={titleId} className="text-base font-semibold text-foreground">{watchlist ? "Watchlist" : "Action inbox"}</h2>
                    <p className="text-xs text-muted-foreground">{watchlist ? "Timing and response signals. Work may still be progressing." : "Decisions and issues that need a person to act."}</p>
                </div>
                {entries.length > 0 && (
                    <span className="grid h-6 min-w-6 place-items-center rounded-md bg-amber-400/15 px-1.5 text-xs font-bold tabular-nums text-amber-600 ring-1 ring-inset ring-amber-400/30 dark:text-amber-300">{entries.length}</span>
                )}
            </header>

            {entries.length === 0 ? (
                <div className="mt-4 flex items-center gap-3 rounded-xl border border-dashed border-border px-3 py-4">
                    <IconCircleCheck className="h-5 w-5 shrink-0 text-emerald-500 dark:text-emerald-300" />
                    <div className="text-sm text-muted-foreground"><span className="font-medium text-foreground">All clear.</span> {watchlist ? "No timing or response warnings." : "No decisions or interventions are pending."}</div>
                </div>
            ) : (
                <ul className="mt-3 space-y-2">
                    {entries.slice(0, expanded ? entries.length : VISIBLE).map((entry) => {
                        const style = KIND_STYLE[entry.kind];
                        const busy = busyId !== null;
                        return (
                            <li key={entry.id} className="group relative rounded-xl border border-border/70 bg-muted/30 p-3 transition-colors hover:border-border hover:bg-muted/60 dark:bg-white/[0.02] dark:hover:bg-white/[0.04]">
                                <div className="flex gap-3">
                                    <span className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg ring-1 ring-inset", style.tile)}><style.icon className="h-[18px] w-[18px]" stroke={1.8} /></span>
                                    <div className="min-w-0 flex-1">
                                        <div className="flex items-start gap-2">
                                            <Link href={entry.href} className="min-w-0 flex-1 break-words text-sm font-semibold text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-none focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-cyan-400">
                                                <span className="mr-1.5 inline-flex items-center rounded bg-muted/70 px-1 py-px text-[10px] font-semibold uppercase tracking-wide text-muted-foreground dark:bg-white/[0.06]">{style.verb}</span>
                                                {entry.title}
                                            </Link>
                                            <IconChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                                        </div>
                                        <div className="mt-0.5 truncate text-xs text-muted-foreground">
                                            {entry.memberName && entry.memberKey ? (
                                                <button type="button" onClick={() => onFocusMember(entry.memberKey!)} className="relative z-10 font-medium hover:text-foreground">{entry.memberName}</button>
                                            ) : entry.memberName}
                                            {entry.memberName && entry.area && <span aria-hidden> · </span>}
                                            {entry.area}
                                        </div>
                                        {entry.kind === "incident" && entry.reason && (
                                            <div className="mt-0.5 truncate text-xs text-rose-500/90 dark:text-rose-300/90">{entry.reason}</div>
                                        )}
                                        {canAct ? (
                                            <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                                                <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><IconClock className="h-3.5 w-3.5" />{timeAgo(entry.at, now)}</span>
                                                <Actions entry={entry} busy={busy} agents={agents} onApprove={(e) => approve(e, "approved")} onReject={(e) => approve(e, "rejected")} onResume={resume} onRestart={restart} onReassign={reassign} />
                                            </div>
                                        ) : (
                                            <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground"><IconClock className="h-3.5 w-3.5" />{timeAgo(entry.at, now)}</div>
                                        )}
                                    </div>
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}
            {entries.length > VISIBLE && (
                <button type="button" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)} className="relative z-10 mt-3 inline-flex min-h-11 items-center gap-1 rounded-lg px-2 text-sm font-medium text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                    {expanded ? "Show fewer" : `Show all ${entries.length} ${watchlist ? "signals" : "actions"}`}<IconChevronRight className="h-4 w-4" />
                </button>
            )}
        </section>
    );
}

function Actions({ entry, busy, agents, onApprove, onReject, onResume, onRestart, onReassign }: {
    entry: AttentionEntry;
    busy: boolean;
    agents: DashboardMember[];
    onApprove: (e: AttentionEntry) => void;
    onReject: (e: AttentionEntry) => void;
    onResume: (e: AttentionEntry) => void;
    onRestart: (e: AttentionEntry) => void;
    onReassign: (e: AttentionEntry, target: { type: "agent" | "human"; id: string }) => void;
}) {
    const disabled = busy;
    const btn = "relative z-10 inline-flex min-h-11 items-center gap-1 rounded-lg px-2.5 text-xs font-semibold ring-1 ring-inset transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50";
    const primary = "bg-cyan-500/15 text-cyan-700 ring-cyan-500/40 hover:bg-cyan-500/25 dark:text-cyan-200";
    const danger = "bg-rose-500/10 text-rose-600 ring-rose-500/30 hover:bg-rose-500/20 dark:text-rose-300";

    switch (entry.kind) {
        case "approval":
            return (
                <span className="relative z-10 flex flex-wrap items-center gap-1.5">
                    <button type="button" disabled={disabled} onClick={() => onApprove(entry)} className={cn(btn, primary)}><IconCheck className="h-3.5 w-3.5" />Approve</button>
                    <button type="button" disabled={disabled} onClick={() => onReject(entry)} className={cn(btn, danger)}><IconX className="h-3.5 w-3.5" />Reject</button>
                </span>
            );
        case "paused":
            return <button type="button" disabled={disabled} onClick={() => onResume(entry)} className={cn(btn, primary)}><IconPlayerPlay className="h-3.5 w-3.5" />Resume</button>;
        case "agent":
            if (!entry.canRestartRuntime) return <Link href={entry.href} className={cn(btn, primary)}>Inspect connection</Link>;
            return (
                <span className="relative z-10 flex flex-wrap items-center gap-1.5">
                    <button type="button" disabled={disabled} onClick={() => onRestart(entry)} className={cn(btn, primary)}><IconRefresh className="h-3.5 w-3.5" />Restart</button>
                </span>
            );
        case "incident":
        case "not_started":
            if (!entry.taskId) return <Link href={entry.href} className={cn(btn, primary)}>{entry.actionLabel || "Inspect issue"}</Link>;
            return (
                <span className="relative z-10 flex flex-wrap items-center gap-1.5">
                    <Link href={entry.href} className={cn(btn, primary)}>Open task</Link>
                    {agents.some((agent) => agent.key !== entry.memberKey) && <ReassignMenu entry={entry} disabled={disabled} agents={agents} onReassign={onReassign} />}
                </span>
            );
        default:
            return (
                <Link href={entry.href} className={cn(btn, primary)}>
                    {entry.actionLabel || "Open"}
                </Link>
            );
    }
}

function ReassignMenu({ entry, disabled, agents, onReassign }: {
    entry: AttentionEntry;
    disabled: boolean;
    agents: DashboardMember[];
    onReassign: (e: AttentionEntry, target: { type: "agent"; id: string }) => void;
}) {
    const pickable = agents.filter((a) => a.kind === "agent" && a.key !== entry.memberKey);
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button type="button" disabled={disabled} className="relative z-10 inline-flex min-h-11 items-center gap-1 rounded-lg bg-cyan-500/15 px-2.5 text-xs font-semibold text-cyan-700 ring-1 ring-inset ring-cyan-500/40 transition hover:bg-cyan-500/25 disabled:cursor-not-allowed disabled:opacity-50 dark:text-cyan-200">
                    Reassign
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-72 w-52 overflow-y-auto">
                {pickable.length === 0 ? (
                    <span className="block px-2 py-1.5 text-xs text-muted-foreground">No other agents.</span>
                ) : pickable.map((a) => (
                    <DropdownMenuItem key={a.key} onSelect={() => onReassign(entry, { type: "agent", id: a.id })}>
                        <span className="flex min-w-0 items-center gap-2">
                            <span className="truncate">{a.name}</span>
                            {a.role && <span className="truncate text-xs text-muted-foreground">{a.role}</span>}
                        </span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
