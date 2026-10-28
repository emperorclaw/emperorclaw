"use client";
/* eslint-disable @typescript-eslint/no-explicit-any */

import { useState, type ReactNode } from "react";
import { IconBrain, IconCircleCheck, IconDots, IconPencil, IconRotate, IconTrash, IconX } from "@tabler/icons-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import type { ProjectTitle } from "@/lib/project-title";
import { sentenceCase } from "@/lib/project-board-model";
import { cn } from "@/lib/utils";

const STATUS_TONE: Record<string, string> = {
    active: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300",
    paused: "border-amber-500/25 bg-amber-500/10 text-amber-300",
    completed: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300",
    killed: "border-rose-500/25 bg-rose-500/10 text-rose-300",
};

/**
 * The selected project, shown once above the board: short name, the
 * description agents tend to cram into the name, customer, lead and status,
 * plus project actions. Cards below then skip the project line.
 */
export function ProjectHeader({
    project,
    title,
    customerName,
    leadName,
    taskCount,
    canEdit,
    archiveArmed,
    completing,
    onClear,
    onNotes,
    onEdit,
    onComplete,
    onReopen,
    onArchive,
    accessSlot,
}: {
    project: any;
    title: ProjectTitle;
    customerName: string | null;
    leadName: string | null;
    taskCount: number;
    canEdit: boolean;
    archiveArmed: boolean;
    completing: boolean;
    onClear: () => void;
    onNotes: () => void;
    onEdit: () => void;
    onComplete: () => void;
    onReopen: () => void;
    onArchive: () => void;
    /** The project's Access button (0.20). */
    accessSlot?: ReactNode;
}) {
    const [showAll, setShowAll] = useState(false);
    const finished = project.status === "completed" || project.status === "killed";
    const description = title.description;
    const long = Boolean(description && description.length > 180);

    return (
        <section aria-label="Selected project" className="emperor-panel flex flex-col gap-3 rounded-2xl px-4 py-3.5 sm:flex-row sm:items-start sm:gap-6 sm:px-5">
            <div className="min-w-0 flex-1 space-y-1.5">
                <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                    <h2 className="min-w-0 truncate text-lg font-semibold text-zinc-50" title={title.name}>{title.name}</h2>
                    <span className={cn("inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", STATUS_TONE[project.status] ?? STATUS_TONE.active)}>{sentenceCase(project.status) || "Active"}</span>
                </div>
                {description && (
                    <div className="max-w-3xl text-sm leading-relaxed text-zinc-400">
                        <p className={cn("whitespace-pre-line break-words", !showAll && "line-clamp-2")}>{description}</p>
                        {long && (
                            <button type="button" onClick={() => setShowAll((value) => !value)} className="mt-0.5 text-xs font-medium text-cyan-300 hover:text-cyan-200">
                                {showAll ? "Show less" : "Show more"}
                            </button>
                        )}
                    </div>
                )}
                <p className="text-xs text-zinc-500">
                    {[customerName ?? "No customer", leadName ? `Lead ${leadName}` : null, `${taskCount} ${taskCount === 1 ? "task" : "tasks"}`].filter(Boolean).join(" · ")}
                </p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
                {accessSlot}
                <button type="button" onClick={onNotes} className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 text-sm text-zinc-200 transition-colors hover:border-zinc-700 hover:bg-zinc-900">
                    <IconBrain className="h-4 w-4 text-cyan-300" aria-hidden="true" />
                    Notes
                </button>
                {canEdit && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <button type="button" aria-label="Project actions" className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-950/60 text-zinc-300 transition-colors hover:border-zinc-700 hover:bg-zinc-900 hover:text-zinc-100">
                                <IconDots className="h-4 w-4" aria-hidden="true" />
                            </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-52 border-zinc-800 bg-zinc-950 text-zinc-100">
                            <DropdownMenuItem onSelect={onEdit}><IconPencil className="mr-2 h-4 w-4" />Edit project</DropdownMenuItem>
                            {finished ? (
                                <DropdownMenuItem onSelect={onReopen}><IconRotate className="mr-2 h-4 w-4 text-amber-400" />Reopen project</DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem onSelect={onComplete} disabled={completing}><IconCircleCheck className="mr-2 h-4 w-4 text-emerald-400" />{completing ? "Completing..." : "Complete project"}</DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            <DropdownMenuItem variant="destructive" onSelect={(event) => { event.preventDefault(); onArchive(); }}>
                                <IconTrash className="mr-2 h-4 w-4" />{archiveArmed ? "Click again to archive" : "Archive project"}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
                <button type="button" onClick={onClear} aria-label="Show all projects" title="Show all projects" className="inline-flex h-9 w-9 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-zinc-900 hover:text-zinc-200">
                    <IconX className="h-4 w-4" aria-hidden="true" />
                </button>
            </div>
        </section>
    );
}
