"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
    IconArchive,
    IconArrowRight,
    IconArrowUpRight,
    IconFileText,
    IconLoader2,
    IconNote,
    IconPencil,
    IconSend,
    IconSparkles,
    IconUserShare,
    IconX,
} from "@tabler/icons-react";
import { RichText } from "@/components/rich-text";
import { getArtifactClassLabel } from "@/lib/artifact-taxonomy";
import { blockedReason, sentenceCase, taskBriefMarkdown, type BoardTask } from "@/lib/project-board-model";
import type { ProjectTitle } from "@/lib/project-title";
import { taskHref } from "@/lib/task-story";
import { cn } from "@/lib/utils";
import { OwnerAvatar, PRIORITY_CHOICES, SignalIcons, type TaskView } from "./task-card";

const DRAWER_STATES = ["inbox", "in_progress", "review", "blocked", "done", "failed", "dead_letter"];

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

function when(iso: string | Date | null | undefined): string {
    if (!iso) return "";
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const sameDay = date.toDateString() === new Date().toDateString();
    return sameDay
        ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
        : date.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export type DrawerLookups = {
    agentName: (id?: string | null) => string;
    memberName: (id?: string | null) => string;
};

function describeEvent(event: any, lookups: DrawerLookups): { icon: typeof IconNote; text: string; note: string | null } {
    const payload = event.payloadJson && typeof event.payloadJson === "object" ? event.payloadJson : {};
    if (event.eventType === "task_note") return { icon: IconNote, text: "Note", note: typeof payload.note === "string" ? payload.note : null };
    if (event.eventType === "task_handoff" && payload.handoff) {
        return { icon: IconUserShare, text: `Handed off from ${payload.handoff.fromRole ?? "?"} to ${payload.handoff.toRole ?? "?"}`, note: typeof payload.note === "string" ? payload.note : null };
    }
    if (event.eventType === "task_reassigned") {
        const assignee = payload.assignee;
        const label = assignee?.type === "human" ? lookups.memberName(assignee.id) : assignee?.type === "agent" ? lookups.agentName(assignee.id) : null;
        return { icon: IconUserShare, text: label ? `Assigned to ${label}` : "Unassigned", note: null };
    }
    if (event.eventType === "task_generated" || event.eventType === "task_created") return { icon: IconSparkles, text: "Created", note: null };
    if (typeof event.eventType === "string" && event.eventType.startsWith("task_")) {
        const state = typeof payload.state === "string" ? payload.state : event.eventType.replace("task_", "");
        const note = typeof payload.comment === "string" ? payload.comment : typeof payload.blockedReason === "string" ? payload.blockedReason : null;
        return { icon: IconArrowRight, text: `Moved to ${sentenceCase(state).toLowerCase()}`, note };
    }
    return { icon: IconArrowRight, text: sentenceCase(event.eventType), note: null };
}

function actorOf(event: any, lookups: DrawerLookups): string | null {
    if (event.actorType === "agent" && event.actorId) return lookups.agentName(event.actorId);
    if (event.actorType === "human" && event.actorId) return lookups.memberName(event.actorId);
    if (event.actorType === "system") return "System";
    return null;
}

export function TaskDrawer({
    task,
    view,
    project,
    customerName,
    workTypeLabel,
    events,
    artifacts,
    agents,
    members,
    lookups,
    canEdit,
    busy,
    onClose,
    onSetState,
    onAssign,
    onSetPriority,
    onEdit,
    onArchive,
    onSendNote,
}: {
    task: BoardTask & Record<string, any>;
    view: TaskView | null;
    project: ProjectTitle;
    customerName: string | null;
    workTypeLabel: string;
    events: any[];
    artifacts: any[];
    agents: any[];
    members: any[];
    lookups: DrawerLookups;
    canEdit: boolean;
    busy: boolean;
    onClose: () => void;
    onSetState: (state: string) => void;
    onAssign: (value: string) => void;
    onSetPriority: (priority: number) => void;
    onEdit: () => void;
    onArchive: () => void;
    onSendNote: (text: string) => Promise<boolean>;
}) {
    const [note, setNote] = useState("");
    const [sending, setSending] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);
    const brief = taskBriefMarkdown(task);
    const reason = blockedReason(task);
    const ownerValue = task.assignedMemberId ? `human:${task.assignedMemberId}` : task.assignedAgentId ? `agent:${task.assignedAgentId}` : "";
    const sortedEvents = [...events].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    // Escape closes; focus moves into the panel when a new task opens.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape" && !event.defaultPrevented && !(event.target as HTMLElement)?.closest?.("[role=menu],[role=dialog]")) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [onClose]);
    useEffect(() => { panelRef.current?.focus({ preventScroll: true }); }, [task.id]);

    const send = async () => {
        const text = note.trim();
        if (!text) return;
        setSending(true);
        const ok = await onSendNote(text);
        setSending(false);
        if (ok) setNote("");
    };

    const selectClass = "h-10 w-full rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 text-sm text-zinc-200 outline-none transition-colors focus:border-cyan-400 disabled:opacity-60 sm:h-9";

    return (
        <>
            <button type="button" aria-label="Close task" onClick={onClose} className="fixed inset-0 z-40 bg-black/50 lg:bg-black/25 motion-safe:animate-in motion-safe:fade-in" />
            <aside
                ref={panelRef}
                tabIndex={-1}
                aria-labelledby="task-drawer-title"
                className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-zinc-800 bg-zinc-950 shadow-[-24px_0_48px_-24px_rgba(0,0,0,0.6)] outline-none sm:w-[min(38rem,92vw)] motion-safe:animate-in motion-safe:slide-in-from-right-6 motion-safe:duration-200"
            >
                <div className="flex items-center gap-2 border-b border-zinc-800/80 px-4 py-2.5 sm:px-5">
                    <span className="hidden font-mono text-[11px] text-zinc-500 sm:inline">TASK-{String(task.id).slice(0, 8).toUpperCase()}</span>
                    <Link href={taskHref(task.id)} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-cyan-300 transition-colors hover:bg-cyan-400/10 hover:text-cyan-200">
                        Open full page
                        <IconArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                    </Link>
                    <span className="ml-auto flex items-center gap-1">
                        {canEdit && (
                            <>
                                <button type="button" onClick={onEdit} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-zinc-100"><IconPencil className="h-3.5 w-3.5" aria-hidden="true" />Edit</button>
                                <button type="button" onClick={onArchive} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-300 transition-colors hover:bg-rose-500/10 hover:text-rose-200"><IconArchive className="h-3.5 w-3.5" aria-hidden="true" />Archive</button>
                            </>
                        )}
                        <button type="button" onClick={onClose} aria-label="Close" className="inline-flex h-8 w-8 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-100"><IconX className="h-4 w-4" aria-hidden="true" /></button>
                    </span>
                </div>

                <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-4 py-5 sm:px-5">
                    <header className="space-y-2">
                        <h2 id="task-drawer-title" className="text-lg font-semibold leading-snug text-zinc-50 text-balance">{view?.title ?? "Task"}</h2>
                        <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
                            <span className="max-w-full truncate text-zinc-300" title={project.description ? `${project.name}\n\n${project.description}` : project.name}>{project.name || "No project"}</span>
                            {customerName && <><span aria-hidden="true">/</span><span className="truncate">{customerName}</span></>}
                            <span aria-hidden="true">·</span>
                            <span>{workTypeLabel}</span>
                        </p>
                        <div className="flex flex-wrap items-center gap-2 pt-1">
                            <span className={cn("inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium", STATE_TONE[task.state ?? "inbox"] ?? STATE_TONE.inbox)}>{sentenceCase(task.state === "queued" ? "inbox" : task.state)}</span>
                            {view && <SignalIcons signals={view.signals} className="gap-1.5" />}
                            {view?.age && <span className="text-xs text-zinc-500" title={view.ageTitle}>Updated {view.age === "now" ? "just now" : `${view.age} ago`}</span>}
                        </div>
                        {task.state === "blocked" && reason && (
                            <p className="rounded-lg border border-rose-500/20 bg-rose-500/[0.06] px-3 py-2 text-sm text-rose-100"><span className="font-medium">Blocked:</span> {reason}</p>
                        )}
                    </header>

                    {canEdit ? (
                        <div className="grid grid-cols-3 gap-2 sm:gap-3">
                            <label className="grid gap-1.5 text-xs text-zinc-400">
                                <span>State</span>
                                <select value={task.state === "queued" ? "inbox" : task.state ?? "inbox"} disabled={busy} onChange={(event) => onSetState(event.target.value)} className={selectClass}>
                                    {DRAWER_STATES.map((state) => <option key={state} value={state}>{sentenceCase(state)}</option>)}
                                </select>
                            </label>
                            <label className="grid gap-1.5 text-xs text-zinc-400">
                                <span>Owner</span>
                                <select value={ownerValue} disabled={busy} onChange={(event) => onAssign(event.target.value)} className={selectClass}>
                                    <option value="">No owner</option>
                                    {agents.length > 0 && <optgroup label="Agents">{agents.map((agent) => <option key={agent.id} value={`agent:${agent.id}`}>{agent.name}</option>)}</optgroup>}
                                    {members.length > 0 && <optgroup label="People">{members.map((member) => <option key={member.id} value={`human:${member.id}`}>{member.displayName || member.email}</option>)}</optgroup>}
                                </select>
                            </label>
                            <label className="grid gap-1.5 text-xs text-zinc-400">
                                <span>Priority</span>
                                <select value={PRIORITY_CHOICES.reduce((best, choice) => ((task.priority ?? 0) >= choice.value ? choice : best), PRIORITY_CHOICES[0]).value} disabled={busy} onChange={(event) => onSetPriority(Number(event.target.value) || 0)} className={selectClass}>
                                    {PRIORITY_CHOICES.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
                                </select>
                            </label>
                        </div>
                    ) : (
                        <dl className="grid grid-cols-2 gap-3 rounded-xl border border-zinc-800/80 px-3 py-2.5 text-sm">
                            <div className="min-w-0"><dt className="text-[11px] text-zinc-500">Owner</dt><dd className="mt-0.5 flex min-w-0 items-center gap-1.5 text-zinc-200"><OwnerAvatar owner={view?.owner ?? null} /><span className="truncate">{view?.owner?.name ?? "No owner"}</span></dd></div>
                            <div className="min-w-0"><dt className="text-[11px] text-zinc-500">Priority</dt><dd className="mt-0.5 text-zinc-200">{view?.priority?.label ?? "None"}</dd></div>
                        </dl>
                    )}

                    <section aria-labelledby="drawer-brief" className="space-y-2">
                        <h3 id="drawer-brief" className="text-xs font-medium text-zinc-400">Brief</h3>
                        {brief ? (
                            <div className="rounded-xl border border-zinc-800/80 bg-zinc-900/30 px-4 py-3">
                                <RichText content={brief} collapsedHeight={280} />
                            </div>
                        ) : (
                            <p className="text-sm text-zinc-500">No instructions yet.{canEdit ? " Use Edit to add a goal and what done looks like." : ""}</p>
                        )}
                    </section>

                    {artifacts.length > 0 && (
                        <section aria-labelledby="drawer-files" className="space-y-2">
                            <h3 id="drawer-files" className="text-xs font-medium text-zinc-400">Files <span className="tabular-nums text-zinc-500">{artifacts.length}</span></h3>
                            <ul className="space-y-2">
                                {artifacts.map((artifact) => (
                                    <li key={artifact.id} className="rounded-xl border border-zinc-800/80 bg-zinc-900/30">
                                        <Link href={`/artifacts?artifact=${encodeURIComponent(artifact.id)}`} className="flex min-w-0 items-center gap-2.5 px-3 py-2 transition-colors hover:bg-zinc-900/60">
                                            <IconFileText className="h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />
                                            <span className="min-w-0 flex-1">
                                                <span className="block truncate text-sm text-zinc-100">{artifact.title || artifact.originalFilename || artifact.kind}</span>
                                                <span className="block truncate text-[11px] text-zinc-500">{[getArtifactClassLabel(artifact.artifactClass || artifact.kind), artifact.isCanonical ? "Canonical" : null, artifact.contentType].filter(Boolean).join(" · ")}</span>
                                            </span>
                                        </Link>
                                        {artifact.contentText && (
                                            <div className="border-t border-zinc-800/60 px-3 py-2.5">
                                                <RichText content={artifact.contentText} collapsedHeight={140} />
                                            </div>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </section>
                    )}

                    <section aria-labelledby="drawer-activity" className="space-y-3">
                        <h3 id="drawer-activity" className="text-xs font-medium text-zinc-400">Activity</h3>
                        {sortedEvents.length === 0 ? (
                            <p className="text-sm text-zinc-500">Created {when(task.createdAt)}. Notes, handoffs and state changes show up here.</p>
                        ) : (
                            <ol className="space-y-3">
                                {sortedEvents.map((event) => {
                                    const { icon: Icon, text, note: body } = describeEvent(event, lookups);
                                    const actor = actorOf(event, lookups);
                                    return (
                                        <li key={event.id} className="flex gap-2.5">
                                            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-zinc-800 bg-zinc-900"><Icon className="h-3 w-3 text-zinc-400" aria-hidden="true" /></span>
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm text-zinc-300">
                                                    <span className="text-zinc-100">{text}</span>
                                                    {actor && <span className="text-zinc-500"> · {actor}</span>}
                                                    <time className="ml-1.5 text-xs text-zinc-500" dateTime={new Date(event.createdAt).toISOString()}>{when(event.createdAt)}</time>
                                                </p>
                                                {body && (
                                                    <div className="mt-1.5 rounded-xl border border-zinc-800/80 bg-zinc-900/40 px-3 py-2">
                                                        <RichText content={body} collapsedHeight={180} />
                                                    </div>
                                                )}
                                            </div>
                                        </li>
                                    );
                                })}
                            </ol>
                        )}
                    </section>
                </div>

                {canEdit && (
                    <div className="border-t border-zinc-800/80 px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5">
                        <label htmlFor="drawer-note" className="sr-only">Add a note</label>
                        <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/40 focus-within:border-cyan-400/60">
                            <textarea
                                id="drawer-note"
                                value={note}
                                onChange={(event) => setNote(event.target.value)}
                                onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void send(); }}
                                rows={2}
                                placeholder={task.assignedAgentId ? `Note for ${lookups.agentName(task.assignedAgentId)}. Markdown works.` : "Add a note. Markdown works."}
                                className="block w-full resize-none bg-transparent px-3 py-2 text-sm text-zinc-200 outline-none placeholder:text-zinc-500"
                            />
                            {/* Save sits on the left: the app's chat button floats over the bottom-right corner. */}
                            <div className="flex flex-row-reverse items-center justify-end gap-3 border-t border-zinc-800/80 px-3 py-1.5">
                                <span className="text-[11px] text-zinc-500">{task.assignedAgentId ? `${lookups.agentName(task.assignedAgentId)} gets it too` : "Saved to the activity"}</span>
                                <button type="button" onClick={() => void send()} disabled={sending || !note.trim()} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-cyan-400/10 px-3 text-xs font-medium text-cyan-100 transition-colors hover:bg-cyan-400/20 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-50">
                                    {sending ? <IconLoader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <IconSend className="h-3.5 w-3.5" aria-hidden="true" />}
                                    Save note
                                </button>
                            </div>
                        </div>
                    </div>
                )}
            </aside>
        </>
    );
}
