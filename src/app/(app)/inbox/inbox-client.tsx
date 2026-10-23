"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
    IconArchive, IconArrowRight, IconBuildingStore, IconCheck, IconChecks, IconClock, IconFolder, IconHistory, IconInbox, IconMessage,
    IconPlayerPlay, IconRefresh, IconRobot, IconUser, IconX,
} from "@tabler/icons-react";
import { PageHeader } from "@/components/page-header";
import { KIND_STYLE } from "@/components/team-dashboard/needs-attention";
import { refreshNavBadges } from "@/components/use-nav-badges";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import {
    ATTENTION_GROUP_LABEL, ATTENTION_GROUPS, attentionGroup, matchesInboxFilter,
    type AttentionGroup, type InboxFilter,
} from "@/lib/attention-rules";
import { approvalAgeDays, isStaleApproval } from "@/lib/approval-status";
import { isPlainKey, isTypingTarget } from "@/lib/keyboard-shortcuts";
import { timeAgo, type AttentionEntry } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

type Agent = { key: string; id: string; name: string; role: string | null };
type Decision = "approved" | "rejected" | "dismissed";

// "Decisions" + "Blocked" = "Needs you" (the header and the badge); FYI is counted apart.
const FILTERS: { id: InboxFilter; label: string; hint: string }[] = [
    { id: "needs", label: "Needs you", hint: "Everything waiting on you" },
    { id: "decide", label: "Decisions", hint: "Part of Needs you: approvals and questions" },
    { id: "blocked", label: "Blocked", hint: "Part of Needs you: stopped or failing work" },
    { id: "fyi", label: "FYI", hint: "Signals only, not counted as needing you" },
];

const GROUP_HINT: Record<AttentionGroup, string> = {
    decide: "Agents are waiting on your call.",
    blocked: "Work that stopped and needs a hand.",
    fyi: "Worth knowing. Nothing is waiting on you.",
};

const BTN = "inline-flex min-h-11 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold ring-1 ring-inset transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-9";
const PRIMARY = "bg-cyan-500/15 text-cyan-700 ring-cyan-500/40 hover:bg-cyan-500/25 dark:text-cyan-200";
const APPROVE = "bg-emerald-500/15 text-emerald-700 ring-emerald-500/40 hover:bg-emerald-500/25 dark:text-emerald-200";
const DANGER = "bg-rose-500/10 text-rose-600 ring-rose-500/30 hover:bg-rose-500/20 dark:text-rose-300";
const NEUTRAL = "bg-transparent text-muted-foreground ring-border hover:bg-muted hover:text-foreground";

export function InboxClient({ entries, agents, generatedAt, canAct, filter }: {
    entries: AttentionEntry[];
    agents: Agent[];
    generatedAt: string;
    canAct: boolean;
    filter: InboxFilter;
}) {
    const router = useRouter();
    const now = useMemo(() => new Date(generatedAt), [generatedAt]);
    const [busyId, setBusyId] = useState<string | null>(null);
    // Resolved here: hidden at once, before the refreshed list arrives.
    const [done, setDone] = useState<ReadonlySet<string>>(new Set());
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [rejectingId, setRejectingId] = useState<string | null>(null);
    const listRef = useRef<HTMLDivElement>(null);

    const live = useMemo(() => entries.filter((e) => !done.has(e.id)), [entries, done]);
    const visible = useMemo(() => live.filter((e) => matchesInboxFilter(e, filter)), [live, filter]);
    const grouped = useMemo(() => ATTENTION_GROUPS.map((group) => ({ group, items: visible.filter((e) => attentionGroup(e) === group) })).filter((g) => g.items.length > 0), [visible]);
    // Keyboard order follows the screen: groups top to bottom.
    const ordered = useMemo(() => grouped.flatMap((g) => g.items), [grouped]);
    // Every number on this page is a count of rows it can list.
    const filterCount = (id: InboxFilter) => live.filter((e) => matchesInboxFilter(e, id)).length;
    const needsYou = filterCount("needs");

    const settle = useCallback(async () => {
        router.refresh();
        await refreshNavBadges();
    }, [router]);

    const run = useCallback(async (entry: AttentionEntry, fn: () => Promise<void>, success: string, hide = true) => {
        setBusyId(entry.id);
        try {
            await fn();
            if (hide) setDone((prev) => new Set(prev).add(entry.id));
            toast.success(success);
            setRejectingId(null);
            void settle();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Something went wrong");
        } finally {
            setBusyId(null);
        }
    }, [settle]);

    const decide = useCallback((entry: AttentionEntry, decision: Decision, note = "") => run(entry, async () => {
        let approvalId = entry.approvalId ?? null;
        // A task that requires approval but was never asked about: create the request, then decide it.
        if (!approvalId) {
            if (!entry.taskId || !entry.projectId) throw new Error("Open the task to decide it");
            const created = await fetch("/api/approvals", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ projectId: entry.projectId, taskIds: [entry.taskId], rationale: "Approval decided directly in Emperor." }),
            });
            if (!created.ok) throw new Error("Couldn't create the approval");
            approvalId = ((await created.json()) as { approval?: { id?: string } }).approval?.id ?? null;
        }
        if (!approvalId) throw new Error("Approval id missing");
        const res = await fetch(`/api/approvals/${approvalId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: decision, resolutionNote: note.trim() || null }),
        });
        if (!res.ok) throw new Error("Couldn't record the decision");
        const stored = ((await res.json().catch(() => ({}))) as { approval?: { status?: string } }).approval?.status;
        if (stored && stored !== decision) {
            void settle();
            throw new Error(`Already ${stored}. Your decision was not applied.`);
        }
    }, decision === "approved" ? `Approved. ${entry.memberName ?? "The agent"} has been told.`
        : decision === "dismissed" ? `Dismissed. ${entry.memberName ?? "The agent"} has been told not to do it.`
            : `Sent back to ${entry.memberName ?? "the agent"} with your note.`), [run, settle]);

    const resume = (entry: AttentionEntry) => run(entry, async () => {
        const res = await fetch("/api/chat/loop-resume", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId: entry.threadId }),
        });
        if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error || "Couldn't resume");
    }, "Resumed the conversation.");

    const restart = (entry: AttentionEntry) => run(entry, async () => {
        const res = await fetch(`/api/agents/${entry.agentId}/recreate-runtime`, { method: "POST" });
        const data = await res.json().catch(() => ({})) as { error?: string; success?: boolean; message?: string };
        if (!res.ok || data.success === false) throw new Error(data.error || data.message || "Couldn't restart the runtime");
    }, "Restarting the runtime.", false);

    const reassign = (entry: AttentionEntry, agent: Agent) => run(entry, async () => {
        const res = await fetch(`/api/tasks/${entry.taskId}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ assignee: { type: "agent", id: agent.id } }),
        });
        if (!res.ok) throw new Error("Couldn't reassign the task");
    }, `Reassigned to ${agent.name}.`, false);

    const markRead = (entry: AttentionEntry) => run(entry, async () => {
        const res = await fetch("/api/notifications/read", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids: [entry.notificationId] }),
        });
        if (!res.ok) throw new Error("Couldn't mark it read");
    }, "Marked read.");

    const setFilter = (next: InboxFilter) => {
        router.replace(next === "needs" ? "/inbox" : `/inbox?filter=${next}`, { scroll: false });
    };

    // j/k move, Enter opens (native on the focused link), a/r decide approvals.
    const focusRow = useCallback((id: string) => {
        setSelectedId(id);
        const row = listRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(id)}"]`);
        row?.querySelector<HTMLElement>("[data-entry-link]")?.focus({ preventScroll: true });
        row?.scrollIntoView({ block: "nearest", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    }, []);

    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.defaultPrevented || !isPlainKey(event) || isTypingTarget(event.target as HTMLElement | null)) return;
            if (document.querySelector("[role='dialog'], [role='menu']")) return;
            if (ordered.length === 0) return;
            const index = selectedId ? ordered.findIndex((e) => e.id === selectedId) : -1;
            const current = index >= 0 ? ordered[index] : null;
            if (event.key === "j" || event.key === "k") {
                event.preventDefault();
                const next = event.key === "j" ? Math.min(ordered.length - 1, index + 1) : Math.max(0, index < 0 ? 0 : index - 1);
                focusRow(ordered[next].id);
                return;
            }
            if (!current || !canAct || current.kind !== "approval" || busyId) return;
            if (event.key === "a") {
                event.preventDefault();
                const at = new Date(current.at).getTime();
                if (isStaleApproval(at, Date.now())) {
                    toast.message(`This request is ${approvalAgeDays(at, Date.now())} days old. Use the Approve button to confirm.`);
                    return;
                }
                void decide(current, "approved");
            } else if (event.key === "r") {
                event.preventDefault();
                setRejectingId(current.id);
            }
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [ordered, selectedId, canAct, busyId, decide, focusRow]);

    return (
        <div className="mx-auto max-w-[1100px] space-y-5 pb-20 animate-in fade-in duration-500">
            <PageHeader
                eyebrow="Inbox"
                title={needsYou === 0 ? "Nothing needs you" : needsYou === 1 ? "1 thing needs you" : `${needsYou} things need you`}
                description="Decisions and blockers from your agents, most urgent first. FYI signals are kept apart."
                actions={
                    <Link href="/approvals" className={cn(BTN, NEUTRAL, "text-sm font-medium")}>
                        <IconHistory className="h-4 w-4" />Approval history
                    </Link>
                }
            />

            {/* Phone: four equal cells, count over label (never overflows). Desktop: one row, FYI set apart. */}
            <div role="toolbar" aria-label="Filter the inbox" className="grid grid-cols-4 gap-1 rounded-xl border border-border bg-muted/40 p-1 sm:inline-flex sm:w-max dark:bg-white/[0.02]">
                {FILTERS.map((f) => {
                    const active = filter === f.id;
                    const n = filterCount(f.id);
                    return (
                        <Fragment key={f.id}>
                            {f.id === "fyi" && <span aria-hidden className="mx-1 my-1.5 hidden w-px bg-border sm:block" />}
                            <button type="button" aria-pressed={active} title={f.hint} onClick={() => setFilter(f.id)}
                                className={cn("flex min-h-12 min-w-0 flex-col-reverse items-center justify-center gap-0.5 rounded-lg px-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400 sm:min-h-9 sm:flex-row sm:gap-2 sm:px-3.5 sm:text-sm",
                                    active ? "bg-background text-foreground shadow-sm ring-1 ring-border dark:bg-white/[0.07]" : "text-muted-foreground hover:text-foreground")}>
                                <span className="truncate">{f.label}</span>
                                <span className={cn("rounded-md px-1.5 text-sm font-semibold tabular-nums sm:text-[11px]", active ? "bg-primary/15 text-primary" : "text-foreground/80 sm:bg-muted sm:text-muted-foreground sm:dark:bg-white/[0.05]")}>{n}</span>
                            </button>
                        </Fragment>
                    );
                })}
            </div>

            <div ref={listRef} className="space-y-6">
                {grouped.length === 0 ? (
                    <EmptyState filter={filter} fyiCount={filterCount("fyi")} onShow={setFilter} />
                ) : grouped.map(({ group, items }) => (
                    <section key={group} aria-labelledby={`inbox-${group}`}>
                        <header className="mb-2.5 flex items-baseline gap-2 px-1">
                            <h2 id={`inbox-${group}`} className={cn("text-sm font-semibold", group === "blocked" ? "text-rose-600 dark:text-rose-300" : group === "decide" ? "text-foreground" : "text-muted-foreground")}>
                                {ATTENTION_GROUP_LABEL[group]}
                            </h2>
                            <span className="text-xs tabular-nums text-muted-foreground">{items.length}</span>
                            <span className="hidden truncate text-xs text-muted-foreground/80 sm:inline">{GROUP_HINT[group]}</span>
                        </header>
                        <ul className="space-y-2">
                            {items.map((entry) => (
                                <InboxRow
                                    key={entry.id}
                                    entry={entry}
                                    now={now}
                                    selected={selectedId === entry.id}
                                    onSelect={() => setSelectedId(entry.id)}
                                    canAct={canAct}
                                    busy={busyId === entry.id}
                                    anyBusy={busyId !== null}
                                    agents={agents}
                                    rejecting={rejectingId === entry.id}
                                    setRejecting={(on) => setRejectingId(on ? entry.id : null)}
                                    onDecide={decide}
                                    onResume={resume}
                                    onRestart={restart}
                                    onReassign={reassign}
                                    onMarkRead={markRead}
                                />
                            ))}
                        </ul>
                    </section>
                ))}
            </div>

            {ordered.length > 0 && (
                <p className="hidden items-center gap-4 px-1 text-xs text-muted-foreground md:flex">
                    <Hint keys={["j", "k"]}>move</Hint>
                    <Hint keys={["Enter"]}>open</Hint>
                    {canAct && <Hint keys={["a"]}>approve</Hint>}
                    {canAct && <Hint keys={["r"]}>reject</Hint>}
                    <span className="ml-auto">Updates every few seconds</span>
                </p>
            )}
        </div>
    );
}

function Hint({ keys, children }: { keys: string[]; children: ReactNode }) {
    return (
        <span className="inline-flex items-center gap-1.5">
            {keys.map((k) => <kbd key={k} className="rounded-md border border-border bg-muted/60 px-1.5 py-0.5 font-mono text-[11px] text-foreground dark:bg-white/[0.04]">{k}</kbd>)}
            <span>{children}</span>
        </span>
    );
}

function EmptyState({ filter, fyiCount, onShow }: { filter: InboxFilter; fyiCount: number; onShow: (filter: InboxFilter) => void }) {
    const filtered = filter !== "needs";
    return (
        <div className="emperor-panel relative overflow-hidden rounded-2xl px-6 py-14 text-center">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 -top-24 mx-auto h-48 w-72 rounded-full bg-cyan-400/10 blur-3xl" />
            <div className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-500/10 text-emerald-600 ring-1 ring-inset ring-emerald-500/25 dark:text-emerald-300">
                <IconChecks className="h-7 w-7" stroke={1.7} />
            </div>
            <h2 className="relative mt-4 text-lg font-semibold text-foreground">{filter === "fyi" ? "No FYI signals" : filtered ? "Nothing here" : "You're all caught up"}</h2>
            <p className="relative mx-auto mt-1 max-w-sm text-sm leading-6 text-muted-foreground">
                {filter === "fyi" ? "Slow replies, late work and mentions show up here." : filtered ? "Nothing of this kind is waiting on you." : "No decisions, blockers or failures. When an agent needs you, it lands here first."}
            </p>
            <div className="relative mt-5 flex flex-wrap justify-center gap-2">
                {filtered ? (
                    <button type="button" onClick={() => onShow("needs")} className={cn(BTN, PRIMARY, "text-sm")}>Back to Needs you</button>
                ) : (
                    <>
                        <Link href="/" className={cn(BTN, PRIMARY, "text-sm")}>See who&apos;s working<IconArrowRight className="h-4 w-4" /></Link>
                        {fyiCount > 0
                            ? <button type="button" onClick={() => onShow("fyi")} className={cn(BTN, NEUTRAL, "text-sm font-medium")}>See {fyiCount} FYI {fyiCount === 1 ? "signal" : "signals"}</button>
                            : <Link href="/messages" className={cn(BTN, NEUTRAL, "text-sm font-medium")}><IconMessage className="h-4 w-4" />Messages</Link>}
                    </>
                )}
            </div>
        </div>
    );
}

function Meta({ icon: Icon, children, title }: { icon: typeof IconRobot; children: ReactNode; title?: string }) {
    return (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1" title={title}>
            <Icon className="h-3.5 w-3.5 shrink-0 opacity-70" />
            <span className="truncate">{children}</span>
        </span>
    );
}

function InboxRow({ entry, now, selected, onSelect, canAct, busy, anyBusy, agents, rejecting, setRejecting, onDecide, onResume, onRestart, onReassign, onMarkRead }: {
    entry: AttentionEntry;
    now: Date;
    selected: boolean;
    onSelect: () => void;
    canAct: boolean;
    busy: boolean;
    anyBusy: boolean;
    agents: Agent[];
    rejecting: boolean;
    setRejecting: (on: boolean) => void;
    onDecide: (entry: AttentionEntry, decision: Decision, note?: string) => void;
    onResume: (entry: AttentionEntry) => void;
    onRestart: (entry: AttentionEntry) => void;
    onReassign: (entry: AttentionEntry, agent: Agent) => void;
    onMarkRead: (entry: AttentionEntry) => void;
}) {
    const style = KIND_STYLE[entry.kind];
    const group = attentionGroup(entry);
    const isAgentArea = entry.kind === "agent" || entry.kind === "run_failed";
    const project = isAgentArea ? null : entry.area;
    return (
        <li
            data-entry-id={entry.id}
            onFocus={onSelect}
            onClick={onSelect}
            aria-current={selected ? "true" : undefined}
            className={cn(
                "group relative rounded-2xl border bg-card/60 p-3.5 transition-colors sm:p-4 dark:bg-white/[0.02]",
                selected ? "border-cyan-400/60 ring-1 ring-cyan-400/40" : "border-border/70 hover:border-border hover:bg-muted/40 dark:hover:bg-white/[0.035]",
                group === "fyi" && !selected && "bg-transparent dark:bg-transparent",
            )}
        >
            <div className="flex gap-3">
                <span className={cn("grid h-10 w-10 shrink-0 place-items-center rounded-xl ring-1 ring-inset", style.tile)}>
                    <style.icon className="h-5 w-5" stroke={1.8} />
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-col gap-3 md:flex-row md:items-start">
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                <span>{style.verb}</span>
                                {entry.taskCount && entry.taskCount > 1 ? <span className="rounded-md bg-amber-400/15 px-1.5 py-px normal-case tracking-normal text-amber-700 dark:text-amber-200">Covers {entry.taskCount} tasks</span> : null}
                            </div>
                            <Link data-entry-link href={entry.href} className="mt-0.5 block break-words text-[15px] font-semibold leading-snug text-foreground hover:text-primary focus-visible:rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400">
                                {entry.title}
                            </Link>
                            {entry.reason && (
                                <p className={cn("mt-1 line-clamp-2 text-sm", group === "blocked" ? "text-rose-600/90 dark:text-rose-300/90" : "text-muted-foreground")}>{entry.reason}</p>
                            )}
                            {entry.detail && <p className="mt-1 line-clamp-2 text-sm text-muted-foreground">{entry.detail}</p>}
                            <div className="mt-2 flex flex-wrap items-center gap-x-3.5 gap-y-1 text-xs text-muted-foreground">
                                {entry.memberName && <Meta icon={entry.memberKey?.startsWith("human:") ? IconUser : IconRobot}>{entry.memberName}</Meta>}
                                {entry.customerName && <Meta icon={IconBuildingStore} title="Customer">{entry.customerName}</Meta>}
                                {project && <Meta icon={IconFolder} title="Project">{project}</Meta>}
                                <Meta icon={IconClock}><time dateTime={entry.at}>{timeAgo(entry.at, now)}</time></Meta>
                            </div>
                        </div>
                        {canAct && !rejecting && (
                            <div className="flex shrink-0 flex-wrap items-center gap-1.5 md:justify-end">
                                <RowActions entry={entry} busy={busy} disabled={anyBusy} agents={agents} onReject={() => setRejecting(true)}
                                    onDecide={onDecide} onResume={onResume} onRestart={onRestart} onReassign={onReassign} onMarkRead={onMarkRead} />
                            </div>
                        )}
                        {!canAct && (
                            <Link href={entry.href} tabIndex={-1} className={cn(BTN, NEUTRAL, "shrink-0 self-start")}>Open<IconArrowRight className="h-3.5 w-3.5" /></Link>
                        )}
                    </div>
                    {canAct && rejecting && <RejectForm entry={entry} busy={busy} onCancel={() => setRejecting(false)} onSend={(note) => onDecide(entry, "rejected", note)} />}
                </div>
            </div>
        </li>
    );
}

function RejectForm({ entry, busy, onCancel, onSend }: { entry: AttentionEntry; busy: boolean; onCancel: () => void; onSend: (note: string) => void }) {
    const [note, setNote] = useState("");
    return (
        <form
            className="mt-3 flex flex-col gap-2 border-t border-border/70 pt-3 sm:flex-row sm:items-center"
            onSubmit={(e) => { e.preventDefault(); if (note.trim()) onSend(note); }}
        >
            <input
                autoFocus
                value={note}
                onChange={(e) => setNote(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
                placeholder={`What should ${entry.memberName ?? "the agent"} change?`}
                aria-label="Reason for rejecting, sent to the agent"
                className="min-h-11 min-w-0 flex-1 rounded-lg border border-rose-500/40 bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-cyan-400/60 md:min-h-9"
            />
            <div className="flex gap-1.5">
                <button type="submit" disabled={busy || !note.trim()} className={cn(BTN, DANGER)}><IconX className="h-3.5 w-3.5" />Send back</button>
                <button type="button" onClick={onCancel} className={cn(BTN, NEUTRAL, "ring-0")}>Cancel</button>
            </div>
        </form>
    );
}

function RowActions({ entry, busy, disabled, agents, onReject, onDecide, onResume, onRestart, onReassign, onMarkRead }: {
    entry: AttentionEntry;
    busy: boolean;
    disabled: boolean;
    agents: Agent[];
    onReject: () => void;
    onDecide: (entry: AttentionEntry, decision: Decision, note?: string) => void;
    onResume: (entry: AttentionEntry) => void;
    onRestart: (entry: AttentionEntry) => void;
    onReassign: (entry: AttentionEntry, agent: Agent) => void;
    onMarkRead: (entry: AttentionEntry) => void;
}) {
    const [confirmDays, setConfirmDays] = useState<number | null>(null);
    const open = <Link href={entry.href} className={cn(BTN, NEUTRAL)}>{entry.actionLabel || "Open"}<IconArrowRight className="h-3.5 w-3.5" /></Link>;

    switch (entry.kind) {
        case "approval": {
            if (confirmDays !== null) {
                return (
                    <span role="alertdialog" aria-label="Confirm approving an old request" className="flex flex-col gap-2 rounded-xl border border-amber-500/40 bg-amber-400/10 p-2.5 dark:bg-amber-300/[0.06]">
                        <span className="text-xs text-amber-800 dark:text-amber-100">This request is {confirmDays} days old. Approve and let {entry.memberName ?? "the agent"} act now?</span>
                        <span className="flex flex-wrap gap-1.5">
                            <button type="button" disabled={disabled} onClick={() => onDecide(entry, "approved")} className={cn(BTN, APPROVE)}><IconCheck className="h-3.5 w-3.5" />Approve anyway</button>
                            <button type="button" disabled={disabled} onClick={() => onDecide(entry, "dismissed")} className={cn(BTN, NEUTRAL)}><IconArchive className="h-3.5 w-3.5" />Dismiss</button>
                            <button type="button" onClick={() => setConfirmDays(null)} className={cn(BTN, NEUTRAL, "ring-0")}>Cancel</button>
                        </span>
                    </span>
                );
            }
            const approve = () => {
                const at = new Date(entry.at).getTime();
                const nowMs = Date.now();
                if (Number.isFinite(at) && isStaleApproval(at, nowMs)) setConfirmDays(approvalAgeDays(at, nowMs));
                else onDecide(entry, "approved");
            };
            return (
                <>
                    <button type="button" disabled={disabled} onClick={approve} className={cn(BTN, APPROVE)} aria-keyshortcuts="a">
                        {busy ? <IconRefresh className="h-3.5 w-3.5 animate-spin" /> : <IconCheck className="h-3.5 w-3.5" />}Approve
                    </button>
                    <button type="button" disabled={disabled} onClick={onReject} className={cn(BTN, DANGER)} aria-keyshortcuts="r"><IconX className="h-3.5 w-3.5" />Reject</button>
                    {entry.approvalId && (
                        <button type="button" disabled={disabled} onClick={() => onDecide(entry, "dismissed")} title="Obsolete: the agent won't do it" aria-label="Dismiss as obsolete" className={cn(BTN, NEUTRAL, "px-2.5")}>
                            <IconArchive className="h-3.5 w-3.5" /><span className="sr-only md:not-sr-only">Dismiss</span>
                        </button>
                    )}
                </>
            );
        }
        case "paused":
            return <button type="button" disabled={disabled || !entry.threadId} onClick={() => onResume(entry)} className={cn(BTN, PRIMARY)}><IconPlayerPlay className="h-3.5 w-3.5" />Resume</button>;
        case "agent":
        case "run_failed":
            return (
                <>
                    {entry.canRestartRuntime && entry.agentId && (
                        <button type="button" disabled={disabled} onClick={() => onRestart(entry)} className={cn(BTN, PRIMARY)}>
                            <IconRefresh className={cn("h-3.5 w-3.5", busy && "animate-spin")} />Restart
                        </button>
                    )}
                    {open}
                </>
            );
        case "incident":
        case "not_started":
        case "late":
        case "task_blocked":
        case "request":
        case "stalled": {
            const pickable = agents.filter((a) => a.key !== entry.memberKey);
            return (
                <>
                    {entry.taskId && pickable.length > 0 && (
                        <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                                <button type="button" disabled={disabled} className={cn(BTN, PRIMARY)}>{busy ? <IconRefresh className="h-3.5 w-3.5 animate-spin" /> : <IconRobot className="h-3.5 w-3.5" />}Reassign</button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="max-h-72 w-56 overflow-y-auto">
                                {pickable.map((a) => (
                                    <DropdownMenuItem key={a.key} onSelect={() => onReassign(entry, a)}>
                                        <span className="flex min-w-0 flex-col">
                                            <span className="truncate">{a.name}</span>
                                            {a.role && <span className="truncate text-xs text-muted-foreground">{a.role}</span>}
                                        </span>
                                    </DropdownMenuItem>
                                ))}
                            </DropdownMenuContent>
                        </DropdownMenu>
                    )}
                    {open}
                </>
            );
        }
        case "mention":
        case "decision":
            return (
                <>
                    {entry.notificationId && (
                        <button type="button" disabled={disabled} onClick={() => onMarkRead(entry)} className={cn(BTN, NEUTRAL)}><IconCheck className="h-3.5 w-3.5" />Mark read</button>
                    )}
                    <Link href={entry.href} className={cn(BTN, PRIMARY)}><IconInbox className="h-3.5 w-3.5" />{entry.kind === "decision" ? "Answer" : "Open"}</Link>
                </>
            );
        default:
            return open;
    }
}
