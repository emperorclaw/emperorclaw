"use client";

import { agentRoleTemplates } from "@/lib/agent-templates";
import { cn } from "@/lib/utils";

/**
 * Controlled role-template card grid — extracted from `create-agent-dialog.tsx`'s
 * step 1 so it can be reused by the Easy Setup wizard (one per agent row) as
 * well as the original single-agent dialog.
 *
 * The Custom card is deliberately rendered OUTSIDE the scrollable template grid.
 * When it lived inside, it was the last cell of a two-column grid and fell below
 * the fold of the grid's `overflow-y-auto` viewport; inside Easy Setup that grid
 * was itself nested in a second scroll container, so the card could not be
 * reached and read as unclickable. Keeping it pinned below the scroll area makes
 * it always visible and clickable, and leaves a single scroll region per picker.
 */
export function RoleTemplatePicker({
    selectedId,
    onSelect,
    allowCustom,
}: {
    selectedId: string | null;
    onSelect: (roleId: string | null) => void;
    allowCustom?: boolean;
}) {
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2 max-h-[240px] overflow-y-auto py-2">
                {agentRoleTemplates.map((template) => (
                    <button
                        key={template.id}
                        type="button"
                        onClick={() => onSelect(template.id)}
                        className={cn(
                            "flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-left transition-colors group",
                            selectedId === template.id
                                ? "border-cyan-400/40 bg-cyan-400/10"
                                : "border-zinc-800 bg-zinc-900/70 hover:border-cyan-500/40 hover:bg-cyan-500/5"
                        )}
                    >
                        <span className="text-2xl shrink-0">{template.emoji}</span>
                        <div className="min-w-0">
                            <span className="block text-sm font-medium text-zinc-100 group-hover:text-cyan-200 transition-colors">
                                {template.title}
                            </span>
                            <span className="block text-[11px] leading-tight text-zinc-400 mt-0.5 line-clamp-2">
                                {template.description}
                            </span>
                        </div>
                    </button>
                ))}
            </div>
            {allowCustom && (
                <button
                    type="button"
                    onClick={() => onSelect(null)}
                    className={cn(
                        "flex w-full cursor-pointer items-center gap-3 rounded-xl border border-dashed p-3 text-left transition-colors",
                        selectedId === null
                            ? "border-zinc-500 bg-zinc-900/70"
                            : "border-zinc-700 bg-zinc-900/40 hover:border-zinc-500 hover:bg-zinc-900/70"
                    )}
                >
                    <span className="text-2xl shrink-0">✨</span>
                    <div className="min-w-0">
                        <span className="block text-sm font-medium text-zinc-400">Custom Role</span>
                        <span className="block text-[11px] leading-tight text-zinc-400 mt-0.5">
                            Blank slate
                        </span>
                    </div>
                </button>
            )}
        </div>
    );
}
