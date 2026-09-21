"use client";

import { agentRoleTemplates, getPinnedAgentTemplates, type AgentRoleTemplate } from "@/lib/agent-templates";
import { cn } from "@/lib/utils";

/**
 * One role card, shared by the pinned lead slot and the specialist grid so the
 * two stay visually identical.
 */
function RoleCard({
    template,
    selected,
    onSelect,
}: {
    template: AgentRoleTemplate;
    selected: boolean;
    onSelect: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onSelect}
            className={cn(
                "flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-left transition-colors group",
                selected
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
    );
}

/**
 * Controlled role-template card grid — extracted from `create-agent-dialog.tsx`'s
 * step 1 so it can be reused by the Easy Setup wizard (one per agent row) as
 * well as the original single-agent dialog.
 *
 * Pinned (lead/manager) templates render ABOVE the scrollable specialist grid
 * so a first-time user sees the Boss before the individual roles. The Custom
 * card is deliberately rendered OUTSIDE the scrollable template grid: when it
 * lived inside, it was the last cell of a two-column grid and fell below the
 * fold of the grid's `overflow-y-auto` viewport; inside Easy Setup that grid
 * was itself nested in a second scroll container, so the card could not be
 * reached and read as unclickable. Keeping it pinned below the scroll area
 * makes it always visible and clickable, and leaves a single scroll region per
 * picker.
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
    const pinned = getPinnedAgentTemplates();
    return (
        <div className="space-y-2">
            {pinned.length > 0 && (
                <div className="space-y-1.5">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">
                        Lead your team
                    </span>
                    <div className="grid grid-cols-1 gap-2">
                        {pinned.map((template) => (
                            <RoleCard
                                key={template.id}
                                template={template}
                                selected={selectedId === template.id}
                                onSelect={() => onSelect(template.id)}
                            />
                        ))}
                    </div>
                </div>
            )}
            <div className="grid grid-cols-2 gap-2 max-h-[240px] overflow-y-auto py-2">
                {agentRoleTemplates.map((template) =>
                    template.pinned ? null : (
                        <RoleCard
                            key={template.id}
                            template={template}
                            selected={selectedId === template.id}
                            onSelect={() => onSelect(template.id)}
                        />
                    )
                )}
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
