"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
    IconAdjustmentsHorizontal,
    IconArrowLeft,
    IconHistory,
    IconLayoutKanban,
    IconLoader2,
    IconRobot,
    IconSend,
    IconShieldQuestion,
    IconUser,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { RichText } from "@/components/rich-text";
import { projectTitle } from "@/lib/project-title";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { stallLabel } from "@/lib/stall-signal";
import { fixAudience } from "@/lib/failure-cause";
import { taskStateLabel, type StoryEntry } from "@/lib/task-story";
import type { TaskStoryView } from "@/lib/task-story-reads";
import { LiveRunBlock, strongestStall, useNow, useTaskLive, useTimeZone } from "./task-live";
import { TaskStoryTimeline } from "./task-story-timeline";

const STATE_TONE: Record<string, string> = {
    inbox: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
    queued: "border-zinc-700 bg-zinc-800/60 text-zinc-300",
    in_progress: "border-cyan-500/30 bg-cyan-500/10 text-cyan-300",
    review: "border-violet-500/30 bg-violet-500/10 text-violet-300",
    blocked: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    done: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    failed: "border-rose-500/30 bg-rose-500/10 text-rose-300",
    dead_letter: "border-rose-500/30 bg-rose-500/10 text-rose-300",
};

const EDITABLE_STATES = ["inbox", "in_progress", "review", "blocked", "done", "failed"] as const;

type Story = TaskStoryView;

function ApprovalSummary({ approval }: { approval: Story["task"]["approval"] }) {
    if (approval.pending > 0) {
        return (
            <Link href="/approvals" className="inline-flex items-center gap-1.5 text-amber-300 hover:text-amber-200">
                <IconShieldQuestion className="h-3.5 w-3.5" aria-hidden="true" />
                {approval.pending === 1 ? "1 approval waiting" : `${approval.pending} approvals waiting`}
            </Link>
        );
    }
    if (approval.latest) {
        const verb = approval.latest.status === "approved" ? "Approved" : approval.latest.status === "rejected" ? "Rejected" : taskStateLabel(approval.latest.status);
        return <span className="text-zinc-300">{verb}{approval.latest.resolverName ? ` by ${approval.latest.resolverName}` : ""}</span>;
    }
    return <span className="text-zinc-500">None requested</span>;
}

/** State, assignee and note controls. Inline in the side rail on desktop, in a bottom sheet on phones. */
function TaskActions({ story, onDone }: { story: Story; onDone?: () => void }) {
    const router = useRouter();
    const { task, assignees } = story;
    const [pending, startTransition] = useTransition();
    const [busy, setBusy] = useState(false);
    const [blockReason, setBlockReason] = useState("");
    const [choosingBlocked, setChoosingBlocked] = useState(false);
    const [note, setNote] = useState("");
    const ownerValue = task.owner ? `${task.owner.type}:${task.owner.id}` : "";
    const canAssign = assignees.agents.length > 0 || assignees.members.length > 0;

    const patch = async (body: Record<string, unknown>, success: string) => {
        setBusy(true);
        try {
            const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}`, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not update the task");
            toast.success(success);
            startTransition(() => router.refresh());
            onDone?.();
            return true;
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not update the task");
            return false;
        } finally {
            setBusy(false);
        }
    };

    const onState = (state: string) => {
        if (state === task.state) return;
        if (state === "blocked") {
            setChoosingBlocked(true);
            return;
        }
        setChoosingBlocked(false);
        void patch({ state }, `Moved to ${taskStateLabel(state)}`);
    };

    const onAssignee = (value: string) => {
        if (value === ownerValue) return;
        const [type, id] = value.split(":", 2);
        const assignee = value && (type === "agent" || type === "human") && id ? { type, id } : null;
        void patch({ assignee }, assignee ? "Reassigned" : "Unassigned");
    };

    const sendNote = async () => {
        const text = note.trim();
        if (!text) return;
        setBusy(true);
        try {
            const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/notes`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ comment: text }),
            });
            if (!res.ok) throw new Error("Could not save the note");
            // Same as the board drawer: an agent owner gets the note as a directive.
            if (task.owner?.type === "agent") {
                await fetch("/api/chat", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ text: `Task Directive for TASK-${task.id}:\n${text}`, targetAgentId: task.owner.id }),
                });
            }
            setNote("");
            toast.success(task.owner?.type === "agent" ? `Note saved and sent to ${task.owner.name}` : "Note saved");
            startTransition(() => router.refresh());
            onDone?.();
        } catch (error) {
            toast.error(error instanceof Error ? error.message : "Could not save the note");
        } finally {
            setBusy(false);
        }
    };

    const disabled = busy || pending;
    const selectClass = "h-11 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-cyan-400 disabled:opacity-60 sm:h-9";

    return (
        <div className="space-y-4">
            <div className="grid gap-3">
                <label className="grid gap-1.5">
                    <span className="text-xs font-medium text-zinc-400">State</span>
                    <select value={choosingBlocked ? "blocked" : task.state} disabled={disabled} onChange={(event) => onState(event.target.value)} className={selectClass}>
                        {!(EDITABLE_STATES as readonly string[]).includes(task.state) && <option value={task.state}>{taskStateLabel(task.state)}</option>}
                        {EDITABLE_STATES.map((state) => <option key={state} value={state}>{taskStateLabel(state)}</option>)}
                    </select>
                </label>
                {choosingBlocked && (
                    <div className="grid gap-2 rounded-xl border border-rose-500/20 bg-rose-500/[0.05] p-3">
                        <label className="grid gap-1.5">
                            <span className="text-xs font-medium text-rose-200">What is blocking it?</span>
                            <input value={blockReason} onChange={(event) => setBlockReason(event.target.value)} className="h-10 rounded-lg border border-zinc-800 bg-zinc-950 px-2.5 text-sm text-zinc-100 outline-none focus:border-rose-400" placeholder="Waiting for the client's logo files" />
                        </label>
                        <div className="flex gap-2">
                            <button type="button" disabled={disabled || !blockReason.trim()} onClick={() => void patch({ state: "blocked", blockedReason: blockReason.trim() }, "Task blocked").then((ok) => { if (ok) { setChoosingBlocked(false); setBlockReason(""); } })} className="h-9 flex-1 rounded-lg bg-rose-500/15 text-sm font-medium text-rose-100 transition-colors hover:bg-rose-500/25 disabled:opacity-50">Block task</button>
                            <button type="button" onClick={() => setChoosingBlocked(false)} className="h-9 rounded-lg px-3 text-sm text-zinc-400 hover:text-zinc-200">Cancel</button>
                        </div>
                    </div>
                )}
                {canAssign && (
                    <label className="grid gap-1.5">
                        <span className="text-xs font-medium text-zinc-400">Owner</span>
                        <select value={ownerValue} disabled={disabled} onChange={(event) => onAssignee(event.target.value)} className={selectClass}>
                            <option value="">Unassigned</option>
                            {task.owner && !assignees.agents.some((a) => `agent:${a.id}` === ownerValue) && !assignees.members.some((m) => `human:${m.id}` === ownerValue) && (
                                <option value={ownerValue}>{task.owner.name}</option>
                            )}
                            {assignees.agents.length > 0 && (
                                <optgroup label="Agents">
                                    {assignees.agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}
                                </optgroup>
                            )}
                            {assignees.members.length > 0 && (
                                <optgroup label="People">
                                    {assignees.members.map((member) => <option key={member.id} value={`human:${member.id}`}>{member.name}</option>)}
                                </optgroup>
                            )}
                        </select>
                    </label>
                )}
            </div>

            <div className="grid gap-1.5">
                <label htmlFor={`note-${task.id}`} className="text-xs font-medium text-zinc-400">Add a note</label>
                <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 focus-within:border-cyan-400/60">
                    <textarea
                        id={`note-${task.id}`}
                        value={note}
                        onChange={(event) => setNote(event.target.value)}
                        onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void sendNote(); }}
                        rows={3}
                        className="block w-full resize-none bg-transparent px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-600"
                        placeholder="Context or instructions for this task"
                    />
                    <div className="flex items-center justify-between gap-2 border-t border-zinc-800/80 px-3 py-2">
                        <span className="text-[11px] text-zinc-500">{task.owner?.type === "agent" ? `${task.owner.name} gets it too` : "Saved to the timeline"}</span>
                        <button type="button" onClick={() => void sendNote()} disabled={disabled || !note.trim()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-cyan-400/10 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-400/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                            {busy ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <IconSend className="h-3.5 w-3.5" aria-hidden="true" />}
                            Save note
                        </button>
                    </div>
                </div>
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                <Link href={`/projects?project=${encodeURIComponent(task.projectId)}&task=${encodeURIComponent(task.id)}`} className="inline-flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                    <IconLayoutKanban className="h-3.5 w-3.5" aria-hidden="true" />
                    Open on the board (edit, priority, archive)
                </Link>
                <Link href={`/timeline?projectId=${encodeURIComponent(task.projectId)}`} className="inline-flex items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200">
                    <IconHistory className="h-3.5 w-3.5" aria-hidden="true" />
                    See this project on the timeline
                </Link>
            </div>
        </div>
    );
}

export function TaskPageClient({ story, canEdit, canAdmin = false }: { story: Story; canEdit: boolean; canAdmin?: boolean }) {
    const { task } = story;
    const timeZone = useTimeZone();
    const nowMs = useNow();
    const live = useTaskLive(task.id, story.live);
    const stall = strongestStall(live, nowMs);
    const [older, setOlder] = useState<{ entries: StoryEntry[]; hasMore: boolean; nextBefore: string | null; forFirst: string | null }>({ entries: [], hasMore: story.hasMore, nextBefore: story.nextBefore, forFirst: story.nextBefore });
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [sheetOpen, setSheetOpen] = useState(false);

    // A refreshed first page resets the "older" pages that hung off the previous one.
    const olderPages = older.forFirst === story.nextBefore ? older : { entries: [], hasMore: story.hasMore, nextBefore: story.nextBefore, forFirst: story.nextBefore };
    const entries = olderPages.entries.length > 0 ? [...story.entries, ...olderPages.entries] : story.entries;

    const loadOlder = async () => {
        if (!olderPages.nextBefore) return;
        setLoadingOlder(true);
        try {
            const res = await fetch(`/api/tasks/${encodeURIComponent(task.id)}/story?before=${encodeURIComponent(olderPages.nextBefore)}`, { cache: "no-store" });
            if (!res.ok) throw new Error();
            const page = await res.json() as { entries: StoryEntry[]; hasMore: boolean; nextBefore: string | null };
            setOlder({ entries: [...olderPages.entries, ...page.entries], hasMore: page.hasMore, nextBefore: page.nextBefore, forFirst: story.nextBefore });
        } catch {
            toast.error("Could not load older entries");
        } finally {
            setLoadingOlder(false);
        }
    };

    const OwnerIcon = task.owner?.type === "human" ? IconUser : IconRobot;
    // Agents often write a whole brief into the project name; show the short label, keep the rest in the tooltip.
    const project = projectTitle({ goal: task.projectName });
    const projectTooltip = project.description ? `${project.name}

${project.description}` : project.name;

    return (
        <div className="mx-auto w-full max-w-6xl space-y-6 pb-10">
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                <Link href={`/projects?project=${encodeURIComponent(task.projectId)}`} className="inline-flex shrink-0 items-center gap-1 rounded-md py-1 text-zinc-400 transition-colors hover:text-zinc-100">
                    <IconArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
                    Projects
                </Link>
                <span aria-hidden="true">/</span>
                {task.customerName && <><span className="truncate">{task.customerName}</span><span aria-hidden="true">/</span></>}
                <span className="truncate" title={projectTooltip}>{project.name}</span>
            </nav>

            <header className="space-y-3">
                <div className="flex items-start justify-between gap-3">
                    <h1 className="min-w-0 text-2xl font-semibold tracking-tight text-zinc-50 text-balance sm:text-3xl">{task.title}</h1>
                    {canEdit && (
                        <button type="button" onClick={() => setSheetOpen(true)} className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-3 text-sm text-zinc-200 transition-colors hover:bg-zinc-800 active:scale-[0.98] lg:hidden">
                            <IconAdjustmentsHorizontal className="h-4 w-4" aria-hidden="true" />
                            Actions
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", STATE_TONE[task.state] ?? STATE_TONE.inbox)}>{taskStateLabel(task.state)}</span>
                    {live.runs.length > 0 && (
                        <span className={cn("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium", stall?.stalled ? "border-amber-500/40 bg-amber-500/10 text-amber-300" : "border-cyan-500/30 bg-cyan-500/10 text-cyan-300")}>
                            <span className={cn("h-1.5 w-1.5 rounded-full", stall?.stalled ? "bg-amber-400" : "bg-cyan-400 motion-safe:animate-pulse")} aria-hidden="true" />
                            {stall?.stalled ? stallLabel(stall) : "Working now"}
                        </span>
                    )}
                    <span className="font-mono text-[11px] text-zinc-600">TASK-{task.id.slice(0, 8).toUpperCase()}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3 rounded-2xl border border-zinc-800/80 bg-zinc-950/40 px-4 py-3 text-sm sm:grid-cols-4">
                    <div className="min-w-0">
                        <dt className="text-[11px] text-zinc-500">Owner</dt>
                        <dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-zinc-200">
                            {task.owner ? <><OwnerIcon className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" /><span className="truncate">{task.owner.name}</span></> : <span className="text-zinc-500">Unassigned</span>}
                        </dd>
                    </div>
                    <div className="min-w-0">
                        <dt className="text-[11px] text-zinc-500">Customer</dt>
                        <dd className="mt-0.5 truncate text-zinc-200">{task.customerName ?? <span className="text-zinc-500">None</span>}</dd>
                    </div>
                    <div className="min-w-0">
                        <dt className="text-[11px] text-zinc-500">Project</dt>
                        <dd className="mt-0.5 truncate text-zinc-200" title={projectTooltip}>{project.name}</dd>
                    </div>
                    <div className="min-w-0">
                        <dt className="text-[11px] text-zinc-500">Approval</dt>
                        <dd className="mt-0.5 truncate text-sm"><ApprovalSummary approval={task.approval} /></dd>
                    </div>
                </dl>
                {task.state === "blocked" && task.blockedReason && (
                    <p className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-100"><span className="font-medium">Blocked:</span> {task.blockedReason}</p>
                )}
            </header>

            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
                <div className="min-w-0 space-y-6">
                    {task.description && (
                        <section aria-labelledby="brief-heading" className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40 px-4 py-3.5 sm:px-5">
                            <h2 id="brief-heading" className="mb-2 text-xs font-medium text-zinc-400">Brief</h2>
                            <RichText content={task.description} collapsedHeight={300} />
                        </section>
                    )}
                    {live.runs.length > 0 && (
                        <div className="space-y-3" aria-label="Running now">
                            {live.runs.map((run) => <LiveRunBlock key={run.runId} run={run} meta={live.meta[run.runId]} offsetMs={live.offsetMs} nowMs={nowMs} />)}
                        </div>
                    )}

                    <section aria-labelledby="timeline-heading" className="space-y-4">
                        <h2 id="timeline-heading" className="sr-only">Timeline</h2>
                        <TaskStoryTimeline entries={entries} timeZone={timeZone} nowIso={story.live.serverNow} fixContext={{ audience: fixAudience({ canAct: canEdit, isOwnerOrAdmin: canAdmin }), taskId: task.id, taskAssigneeId: task.owner?.type === "agent" ? task.owner.id : null }} />
                        {olderPages.hasMore && (
                            <div className="pl-[3.25rem] sm:pl-[5rem]">
                                <button type="button" onClick={() => void loadOlder()} disabled={loadingOlder} className="inline-flex h-10 items-center gap-2 rounded-lg border border-zinc-800 px-4 text-sm text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 disabled:opacity-60">
                                    {loadingOlder && <IconLoader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                                    Load older
                                </button>
                            </div>
                        )}
                    </section>
                </div>

                <aside className="hidden min-w-0 lg:block">
                    <div className="sticky top-4 space-y-5">
                        {canEdit && (
                            <section className="rounded-2xl border border-zinc-800/80 bg-zinc-950/40 p-4">
                                <h2 className="mb-3 text-xs font-medium text-zinc-400">Actions</h2>
                                <TaskActions story={story} />
                            </section>
                        )}
                    </div>
                </aside>
            </div>

            {canEdit && (
                <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
                    <DialogContent className="top-auto bottom-0 left-0 max-h-[85dvh] max-w-none translate-x-0 translate-y-0 overflow-y-auto rounded-b-none rounded-t-2xl p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] data-[state=open]:slide-in-from-bottom-8 sm:max-w-none lg:hidden">
                        <DialogTitle className="text-base">Task actions</DialogTitle>
                        <DialogDescription className="sr-only">Change the state or owner, or add a note.</DialogDescription>
                        <TaskActions story={story} onDone={() => setSheetOpen(false)} />
                    </DialogContent>
                </Dialog>
            )}
        </div>
    );
}
