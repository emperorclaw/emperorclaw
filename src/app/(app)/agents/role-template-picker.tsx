"use client";

import { agentRoleTemplates } from "@/lib/agent-templates";
import { cn } from "@/lib/utils";

/**
 * Controlled role-template card grid — extracted from `create-agent-dialog.tsx`'s
 * step 1 so it can be reused by the Easy Setup wizard (one per agent row) as
 * well as the original single-agent dialog.
 *
 * Note: the single-select highlight (`selectedId === template.id`) is a small,
 * deliberate addition over the original inline markup. The original never
 * needed it because picking a role immediately advanced to the next step; here
 * `selectedId` is a persistent controlled value (e.g. Easy Setup keeps every
 * agent row visible at once), so some visual indication of the current pick is
 * necessary. The highlight styling mirrors the existing provider-picker pattern
 * already used elsewhere in `create-agent-dialog.tsx` for consistency.
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
        <div className="grid grid-cols-2 gap-2 max-h-[340px] overflow-y-auto py-2">
            {agentRoleTemplates.map((template) => (
                <button
                    key={template.id}
                    type="button"
                    onClick={() => onSelect(template.id)}
                    className={cn(
                        "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors group",
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
            {allowCustom && (
                <button
                    type="button"
                    onClick={() => onSelect(null)}
                    className={cn(
                        "flex items-center gap-3 rounded-xl border border-dashed p-3 text-left transition-colors",
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
