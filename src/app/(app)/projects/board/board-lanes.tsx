"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import type { ReactNode } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
    IconAlertTriangle,
    IconArchive,
    IconCircleCheck,
    IconCircleDashed,
    IconCircleX,
    IconDots,
    IconEye,
    IconInbox,
    IconLoader,
    IconRepeat,
} from "@tabler/icons-react";
import { EmptyState } from "@/components/ui/empty-state";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { BoardColumnKey } from "@/lib/project-board-model";
import { cn } from "@/lib/utils";
import { RecurringCard, TaskCard, TaskRow, type TaskView } from "./task-card";

export type LaneTone = "neutral" | "active" | "review" | "problem" | "done";

export type Lane = {
    key: string;
    title: string;
    tone: LaneTone;
    icon: "inbox" | "progress" | "blocked" | "review" | "done" | "failed" | "recurring" | "stale";
    views: TaskView[];
    /** Recurring definitions (only on the recurring lane). */
    definitions?: { definition: any; projectName: string; ownerName: string }[];
    /** Column state a drop sets; lanes without one do not accept drops. */
    dropId?: BoardColumnKey;
    emptyText: string;
    /** An empty lane shrinks to a thin rail on the board so busy lanes get the width. */
    collapseWhenEmpty?: boolean;
    /** Extra controls under the lane header (review sub-buckets). */
    header?: ReactNode;
    count?: number;
    /** Set when every task in the lane is finished and the person may archive: "Archive all" in the lane menu. */
    onArchiveAll?: () => void;
};

/** List-view multi-select (desktop list only). */
export type RowSelection = {
    ids: ReadonlySet<string>;
    toggle: (taskId: string) => void;
    setMany: (taskIds: string[], selected: boolean) => void;
};

const ICONS = {
    inbox: IconInbox,
    progress: IconLoader,
    blocked: IconAlertTriangle,
    review: IconEye,
    done: IconCircleCheck,
    failed: IconCircleX,
    recurring: IconRepeat,
    stale: IconCircleDashed,
} as const;

const ICON_TONE: Record<LaneTone, string> = {
    neutral: "text-zinc-500",
    active: "text-cyan-300",
    review: "text-violet-300",
    problem: "text-rose-300",
    done: "text-emerald-300",
};

export type CardHandlers = {
    canEdit: boolean;
    selectedId: string | null;
    onOpen: (task: any) => void;
    onSetPriority: (task: any, priority: number) => void;
    onSetState: (task: any, state: string) => void;
    onArchive: (task: any) => void;
};

export function laneCount(lane: Lane) {
    return lane.count ?? lane.views.length + (lane.definitions?.length ?? 0);
}

/** The lane "..." menu. Only rendered when the lane offers an action. */
function LaneMenu({ lane }: { lane: Lane }) {
    if (!lane.onArchiveAll) return null;
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Actions for ${lane.title}`}
                    className="-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-colors hover:bg-zinc-800 hover:text-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60 data-[state=open]:bg-zinc-800 data-[state=open]:text-zinc-200"
                >
                    <IconDots className="h-4 w-4" aria-hidden="true" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48 border-zinc-800 bg-zinc-950 text-zinc-100">
                <DropdownMenuItem variant="destructive" onSelect={lane.onArchiveAll}><IconArchive className="mr-2 h-4 w-4" />Archive all {lane.views.length}</DropdownMenuItem>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function LaneIcon({ lane, className }: { lane: Lane; className?: string }) {
    const Icon = ICONS[lane.icon];
    return <Icon className={cn("h-4 w-4 shrink-0", ICON_TONE[lane.tone], className)} aria-hidden="true" />;
}

/** One board column. Droppable when it maps to a task state. */
export function BoardLane({ lane, handlers, dragging }: { lane: Lane; handlers: CardHandlers; dragging: boolean }) {
    const { setNodeRef, isOver } = useDroppable({ id: lane.dropId ?? `__lane-${lane.key}`, disabled: !lane.dropId || !handlers.canEdit });
    const count = laneCount(lane);
    const rail = Boolean(lane.collapseWhenEmpty) && count === 0;
    const canDrop = dragging && Boolean(lane.dropId) && handlers.canEdit;

    if (rail) {
        return (
            <section
                ref={setNodeRef}
                aria-label={`${lane.title}, empty`}
                title={`${lane.title}: ${lane.emptyText}`}
                className={cn(
                    "flex w-11 shrink-0 flex-col items-center gap-3 rounded-xl border border-zinc-800/60 bg-zinc-950/30 py-3 transition-[width,background-color,border-color] duration-200",
                    canDrop && "w-40 border-dashed border-zinc-700",
                    isOver && "border-cyan-400/60 bg-cyan-400/[0.06]",
                )}
            >
                <LaneIcon lane={lane} />
                <span className={cn("text-xs font-medium text-zinc-500 [writing-mode:vertical-rl]", canDrop && "[writing-mode:horizontal-tb]")}>{canDrop ? `Drop to ${lane.title.toLowerCase()}` : lane.title}</span>
            </section>
        );
    }

    return (
        <section
            ref={setNodeRef}
            aria-labelledby={`lane-${lane.key}`}
            className={cn(
                "flex min-h-0 min-w-[13rem] max-w-[24rem] flex-1 basis-0 flex-col rounded-xl border border-zinc-800/60 bg-zinc-950/30 transition-[background-color,border-color] duration-150",
                canDrop && "border-dashed border-zinc-700",
                isOver && "border-cyan-400/60 bg-cyan-400/[0.05]",
            )}
        >
            <header className="flex items-center gap-2 px-3 pb-2 pt-3">
                <LaneIcon lane={lane} />
                <h3 id={`lane-${lane.key}`} className="min-w-0 truncate text-sm font-medium text-zinc-200">{lane.title}</h3>
                <span className="ml-auto rounded-md bg-zinc-800/60 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-400">{count}</span>
                <LaneMenu lane={lane} />
            </header>
            {lane.header && <div className="px-3 pb-2">{lane.header}</div>}
            <div className="custom-scrollbar min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
                {count === 0 ? (
                    <EmptyState compact className="rounded-lg" title={<span className="text-xs font-normal text-muted-foreground">{lane.emptyText}</span>} />
                ) : (
                    <>
                        {lane.definitions?.map(({ definition, projectName, ownerName }) => (
                            <RecurringCard key={definition.id} definition={definition} projectName={projectName} ownerName={ownerName} />
                        ))}
                        {lane.views.map((view) => (
                            <TaskCard
                                key={view.task.id}
                                view={view}
                                canEdit={handlers.canEdit}
                                selected={handlers.selectedId === view.task.id}
                                onOpen={() => handlers.onOpen(view.task)}
                                onSetPriority={(priority) => handlers.onSetPriority(view.task, priority)}
                                onSetState={(state) => handlers.onSetState(view.task, state)}
                                onArchive={view.task.state === "done" ? () => handlers.onArchive(view.task) : undefined}
                            />
                        ))}
                    </>
                )}
            </div>
        </section>
    );
}

/** Segmented control that picks one lane on phones and in the list view. */
export function LaneSwitcher({ lanes, active, onChange }: { lanes: Lane[]; active: string; onChange: (key: string) => void }) {
    return (
        <div role="tablist" aria-label="Task state" className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0 [&::-webkit-scrollbar]:hidden">
            {lanes.map((lane) => {
                const selected = lane.key === active;
                const count = laneCount(lane);
                return (
                    <button
                        key={lane.key}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => onChange(lane.key)}
                        className={cn(
                            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
                            selected ? "border-zinc-600 bg-zinc-800 text-zinc-50" : "border-zinc-800 bg-zinc-950/60 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200",
                        )}
                    >
                        <LaneIcon lane={lane} className="h-3.5 w-3.5" />
                        {lane.title}
                        <span className={cn("tabular-nums text-xs", selected ? "text-zinc-300" : "text-zinc-500")}>{count}</span>
                    </button>
                );
            })}
        </div>
    );
}

/** Rows of one lane, or every lane as a section (dense desktop list). */
export function LaneList({ lanes, handlers, selection }: { lanes: Lane[]; handlers: CardHandlers; selection?: RowSelection }) {
    return (
        <div className="space-y-5">
            {lanes.map((lane) => {
                const count = laneCount(lane);
                const laneIds = lane.views.map((view) => view.task.id);
                const selectedInLane = selection ? laneIds.filter((id) => selection.ids.has(id)).length : 0;
                const allSelected = laneIds.length > 0 && selectedInLane === laneIds.length;
                return (
                    <section key={lane.key} aria-labelledby={`list-${lane.key}`} className="min-w-0">
                        {lanes.length > 1 ? (
                            <div className="mb-1 flex min-h-6 items-center gap-2 px-3">
                                {selection && laneIds.length > 0 && (
                                    <input
                                        type="checkbox"
                                        aria-label={`Select all in ${lane.title}`}
                                        checked={allSelected}
                                        ref={(node) => { if (node) node.indeterminate = selectedInLane > 0 && !allSelected; }}
                                        onChange={(event) => selection.setMany(laneIds, event.target.checked)}
                                        className="h-4 w-4 cursor-pointer accent-cyan-500"
                                    />
                                )}
                                <h3 id={`list-${lane.key}`} className="flex min-w-0 items-center gap-2 text-xs font-medium text-zinc-400">
                                    <LaneIcon lane={lane} className="h-3.5 w-3.5" />
                                    {lane.title}
                                    <span className="tabular-nums text-zinc-500">{count}</span>
                                </h3>
                                <span className="ml-auto" />
                                <LaneMenu lane={lane} />
                            </div>
                        ) : lane.onArchiveAll ? (
                            <div className="mb-1 flex justify-end px-1"><LaneMenu lane={lane} /></div>
                        ) : null}
                        {lane.header && <div className="mb-2 px-1">{lane.header}</div>}
                        {count === 0 ? (
                            <EmptyState compact className="rounded-lg" title={<span className="font-normal text-muted-foreground">{lane.emptyText}</span>} />
                        ) : (
                            <ul className="divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800/70 bg-zinc-950/40">
                                {lane.definitions?.map(({ definition, projectName, ownerName }) => (
                                    <li key={definition.id} className="p-1.5"><RecurringCard definition={definition} projectName={projectName} ownerName={ownerName} /></li>
                                ))}
                                {lane.views.map((view) => (
                                    <TaskRow
                                        key={view.task.id}
                                        view={view}
                                        canEdit={handlers.canEdit}
                                        selected={handlers.selectedId === view.task.id}
                                        onOpen={() => handlers.onOpen(view.task)}
                                        onSetPriority={(priority) => handlers.onSetPriority(view.task, priority)}
                                        onSetState={(state) => handlers.onSetState(view.task, state)}
                                        onArchive={view.task.state === "done" ? () => handlers.onArchive(view.task) : undefined}
                                        selection={selection ? { checked: selection.ids.has(view.task.id), onToggle: () => selection.toggle(view.task.id) } : undefined}
                                    />
                                ))}
                            </ul>
                        )}
                    </section>
                );
            })}
        </div>
    );
}
