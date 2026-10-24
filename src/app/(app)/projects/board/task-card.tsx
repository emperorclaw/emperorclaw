"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState } from "react";
import Link from "next/link";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
    IconArchive,
    IconArrowUpRight,
    IconCircleX,
    IconClockExclamation,
    IconDots,
    IconFileCheck,
    IconFlag,
    IconFlagFilled,
    IconLink,
    IconRepeat,
    IconShieldQuestion,
    IconUserExclamation,
} from "@tabler/icons-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
    BOARD_COLUMN_LABEL,
    CARD_SIGNAL_LABEL,
    initialsOf,
    type CardSignal,
    type PriorityLevel,
} from "@/lib/project-board-model";
import { taskHref } from "@/lib/task-story";
import { cn } from "@/lib/utils";

/** Everything a card or list row shows, computed once per task by the board. */
export type TaskView = {
    task: any;
    title: string;
    /** Muted "Customer / Project" line; empty when the filter already says it. */
    context: string;
    /** Full customer and project text for the tooltip. */
    contextTitle: string;
    owner: { name: string; kind: "agent" | "human" } | null;
    priority: PriorityLevel | null;
    age: string;
    ageTitle: string;
    signals: CardSignal[];
    recurring: boolean;
};

export const PRIORITY_CHOICES = [
    { value: 0, label: "None" },
    { value: 25, label: "Low" },
    { value: 50, label: "Medium" },
    { value: 75, label: "High" },
    { value: 100, label: "Urgent" },
];

const MOVE_TARGETS = ["inbox", "in_progress", "review", "blocked", "done"] as const;

const PRIORITY_TONE: Record<PriorityLevel["tone"], string> = {
    low: "text-zinc-400",
    medium: "text-amber-300/90",
    high: "text-orange-300",
    critical: "text-rose-300",
};

const SIGNAL_ICON: Record<CardSignal, { icon: typeof IconFlag; className: string }> = {
    failed: { icon: IconCircleX, className: "text-rose-400" },
    blocked: { icon: IconLink, className: "text-rose-300" },
    approval: { icon: IconShieldQuestion, className: "text-amber-300" },
    needs_you: { icon: IconUserExclamation, className: "text-cyan-300" },
    stalled: { icon: IconClockExclamation, className: "text-amber-300/90" },
    proof: { icon: IconFileCheck, className: "text-zinc-400" },
};

export function OwnerAvatar({ owner, size = "sm" }: { owner: TaskView["owner"]; size?: "sm" | "md" }) {
    const dims = size === "md" ? "h-6 w-6 text-[10px]" : "h-[18px] w-[18px] text-[9px]";
    if (!owner) {
        return <span className={cn("inline-flex shrink-0 items-center justify-center rounded-full border border-dashed border-zinc-700", dims)} aria-hidden="true" />;
    }
    return (
        <span
            aria-hidden="true"
            className={cn(
                "inline-flex shrink-0 items-center justify-center font-semibold leading-none",
                dims,
                // Agents are squared and tinted, people are round: the owner kind reads without a label.
                owner.kind === "agent" ? "rounded-[5px] bg-cyan-400/15 text-cyan-200 ring-1 ring-inset ring-cyan-400/25" : "rounded-full bg-zinc-700/70 text-zinc-100",
            )}
        >
            {initialsOf(owner.name)}
        </span>
    );
}

export function SignalIcons({ signals, className }: { signals: CardSignal[]; className?: string }) {
    if (signals.length === 0) return null;
    return (
        <span className={cn("flex items-center gap-1", className)}>
            {signals.map((signal) => {
                const { icon: Icon, className: tone } = SIGNAL_ICON[signal];
                return (
                    <span key={signal} title={CARD_SIGNAL_LABEL[signal]} className="inline-flex">
                        <Icon className={cn("h-3.5 w-3.5", tone)} aria-hidden="true" />
                        <span className="sr-only">{CARD_SIGNAL_LABEL[signal]}</span>
                    </span>
                );
            })}
        </span>
    );
}

export function PriorityMark({ priority }: { priority: PriorityLevel | null }) {
    if (!priority) return null;
    const Icon = priority.tone === "critical" || priority.tone === "high" ? IconFlagFilled : IconFlag;
    return (
        <span className={cn("inline-flex items-center gap-0.5 font-medium", PRIORITY_TONE[priority.tone])} title={`${priority.label} priority`}>
            <Icon className="h-3 w-3" aria-hidden="true" />
            {priority.label}
        </span>
    );
}

/** Priority, move and archive actions. Opens from the "..." button or a right-click on the card. */
export function TaskCardMenu({ view, open, onOpenChange, onSetPriority, onSetState, onArchive }: {
    view: TaskView;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSetPriority?: (priority: number) => void;
    onSetState?: (state: string) => void;
    onArchive?: () => void;
}) {
    const { task } = view;
    return (
        <DropdownMenu open={open} onOpenChange={onOpenChange}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    aria-label={`Actions for ${view.title}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                    className={cn(
                        "-mr-1 -mt-0.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-zinc-500 transition-[opacity,color,background-color] hover:bg-zinc-800 hover:text-zinc-200 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400/60",
                        open ? "bg-zinc-800 text-zinc-200 opacity-100" : "opacity-0 group-hover/card:opacity-100 group-focus-within/card:opacity-100 [@media(hover:none)]:opacity-100",
                    )}
                >
                    <IconDots className="h-4 w-4" aria-hidden="true" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52 border-zinc-800 bg-zinc-950 text-zinc-100" onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <DropdownMenuItem asChild>
                    <Link href={taskHref(task.id)}><IconArrowUpRight className="mr-2 h-4 w-4" />Open full page</Link>
                </DropdownMenuItem>
                {onSetState && (
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Move to</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                            {MOVE_TARGETS.filter((state) => state !== task.state).map((state) => (
                                <DropdownMenuItem key={state} onSelect={() => onSetState(state)}>{BOARD_COLUMN_LABEL[state]}</DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                )}
                {onSetPriority && (
                    <DropdownMenuSub>
                        <DropdownMenuSubTrigger>Priority</DropdownMenuSubTrigger>
                        <DropdownMenuSubContent className="border-zinc-800 bg-zinc-950 text-zinc-100">
                            <DropdownMenuLabel className="text-xs font-normal text-zinc-500">Current: {view.priority?.label ?? "None"}</DropdownMenuLabel>
                            {PRIORITY_CHOICES.map((choice) => (
                                <DropdownMenuItem key={choice.value} onSelect={() => onSetPriority(choice.value)}>{choice.label}</DropdownMenuItem>
                            ))}
                        </DropdownMenuSubContent>
                    </DropdownMenuSub>
                )}
                {onArchive && (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onSelect={onArchive}><IconArchive className="mr-2 h-4 w-4" />Archive task</DropdownMenuItem>
                    </>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The card body shared by the board card, the drag overlay and the list row. */
function CardBody({ view, menu }: { view: TaskView; menu?: React.ReactNode }) {
    return (
        <>
            <div className="flex items-start gap-1.5">
                <h4 className="line-clamp-2 min-w-0 flex-1 break-words text-[13px] font-medium leading-snug text-zinc-100">{view.title}</h4>
                {menu}
            </div>
            {view.context && <p className="mt-0.5 truncate text-xs text-zinc-500" title={view.contextTitle}>{view.context}</p>}
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-[11px] text-zinc-500">
                <OwnerAvatar owner={view.owner} />
                <span className={cn("min-w-0 truncate", view.owner ? "text-zinc-400" : "text-zinc-600")}>{view.owner?.name ?? "No owner"}</span>
                <span className="ml-auto flex shrink-0 items-center gap-2">
                    {view.recurring && <IconRepeat className="h-3.5 w-3.5 text-cyan-300/80" aria-label="Recurring" />}
                    <SignalIcons signals={view.signals} />
                    <PriorityMark priority={view.priority} />
                    {view.age && <time className="tabular-nums text-zinc-500" title={view.ageTitle}>{view.age}</time>}
                </span>
            </div>
        </>
    );
}

export function TaskCard({ view, canEdit, onOpen, onSetPriority, onSetState, onArchive, overlay, selected }: {
    view: TaskView;
    canEdit: boolean;
    onOpen: () => void;
    onSetPriority?: (priority: number) => void;
    onSetState?: (state: string) => void;
    onArchive?: () => void;
    overlay?: boolean;
    selected?: boolean;
}) {
    const draggable = useDraggable({ id: view.task.id, disabled: overlay || !canEdit });
    const [menuOpen, setMenuOpen] = useState(false);
    const style = overlay ? undefined : { transform: CSS.Translate.toString(draggable.transform) };

    if (overlay) {
        return (
            <div className="w-full rotate-[1.2deg] cursor-grabbing rounded-lg border border-cyan-400/40 bg-zinc-900 px-3 py-2.5 shadow-[0_18px_40px_-12px_rgba(0,0,0,0.7)]">
                <CardBody view={view} />
            </div>
        );
    }

    return (
        <div
            ref={draggable.setNodeRef}
            style={style}
            {...draggable.listeners}
            {...draggable.attributes}
            role="button"
            tabIndex={0}
            aria-roledescription={canEdit ? "Draggable task" : undefined}
            aria-label={view.title}
            onClick={onOpen}
            onContextMenu={canEdit ? (event) => { event.preventDefault(); setMenuOpen(true); } : undefined}
            onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onOpen();
                }
            }}
            className={cn(
                "group/card relative w-full rounded-lg border bg-zinc-950 px-3 py-2.5 text-left outline-none transition-[border-color,background-color,opacity] duration-150",
                "hover:border-zinc-700 hover:bg-zinc-900/70 focus-visible:border-cyan-400/60 focus-visible:ring-2 focus-visible:ring-cyan-400/40",
                selected ? "border-cyan-400/50 bg-zinc-900/80" : "border-zinc-800/80",
                canEdit ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
                draggable.isDragging && "opacity-30",
            )}
        >
            <CardBody
                view={view}
                menu={canEdit ? <TaskCardMenu view={view} open={menuOpen} onOpenChange={setMenuOpen} onSetPriority={onSetPriority} onSetState={onSetState} onArchive={onArchive} /> : undefined}
            />
        </div>
    );
}

/** A compact row for the list view and phones. Tapping opens the task. */
export function TaskRow({ view, canEdit, onOpen, onSetPriority, onSetState, onArchive, selected }: {
    view: TaskView;
    canEdit: boolean;
    onOpen: () => void;
    onSetPriority?: (priority: number) => void;
    onSetState?: (state: string) => void;
    onArchive?: () => void;
    selected?: boolean;
}) {
    const [menuOpen, setMenuOpen] = useState(false);
    return (
        <li className="group/card relative">
            <button
                type="button"
                onClick={onOpen}
                onContextMenu={canEdit ? (event) => { event.preventDefault(); setMenuOpen(true); } : undefined}
                className={cn(
                    "flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 pr-10 text-left outline-none transition-colors",
                    "hover:bg-zinc-900/70 focus-visible:bg-zinc-900/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-400/50",
                    selected && "bg-zinc-900/80",
                )}
            >
                <OwnerAvatar owner={view.owner} size="md" />
                <span className="min-w-0 flex-1">
                    <span className="line-clamp-2 break-words text-sm font-medium leading-snug text-zinc-100 sm:line-clamp-1">{view.title}</span>
                    <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-zinc-500">
                        <span className="min-w-0 truncate" title={view.contextTitle}>
                            {[view.owner?.name ?? "No owner", view.context].filter(Boolean).join(" · ")}
                        </span>
                    </span>
                </span>
                <span className="flex shrink-0 items-center gap-2 text-[11px] text-zinc-500">
                    {view.recurring && <IconRepeat className="h-3.5 w-3.5 text-cyan-300/80" aria-label="Recurring" />}
                    <SignalIcons signals={view.signals} />
                    <PriorityMark priority={view.priority} />
                    {view.age && <time className="w-7 text-right tabular-nums" title={view.ageTitle}>{view.age}</time>}
                </span>
            </button>
            {canEdit && (
                <div className="absolute right-2 top-1/2 -translate-y-1/2">
                    <TaskCardMenu view={view} open={menuOpen} onOpenChange={setMenuOpen} onSetPriority={onSetPriority} onSetState={onSetState} onArchive={onArchive} />
                </div>
            )}
        </li>
    );
}

export function RecurringCard({ definition, projectName, ownerName }: { definition: any; projectName: string; ownerName: string }) {
    const next = definition.nextRunAt ? new Date(definition.nextRunAt) : null;
    return (
        <div className="w-full rounded-lg border border-dashed border-zinc-800 bg-zinc-950/60 px-3 py-2.5">
            <div className="flex items-start gap-2">
                <IconRepeat className="mt-0.5 h-3.5 w-3.5 shrink-0 text-cyan-300/80" aria-hidden="true" />
                <h4 className="line-clamp-2 min-w-0 flex-1 text-[13px] font-medium leading-snug text-zinc-100">{definition.name}</h4>
                <span className={cn("shrink-0 text-[11px]", definition.active ? "text-emerald-300" : "text-zinc-500")}>{definition.active ? "Active" : "Paused"}</span>
            </div>
            {projectName && <p className="mt-0.5 truncate pl-5 text-xs text-zinc-500" title={projectName}>{projectName}</p>}
            <p className="mt-1.5 truncate pl-5 text-[11px] text-zinc-500">
                {[ownerName, definition.cronExpression, next && !Number.isNaN(next.getTime()) ? `Next ${next.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` : null].filter(Boolean).join(" · ")}
            </p>
        </div>
    );
}
