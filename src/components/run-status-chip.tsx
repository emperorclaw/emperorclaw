"use client";

import {
    IconAlertTriangle,
    IconCircleCheck,
    IconCircleX,
    IconClockHour4,
    IconLoader2,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { copy } from "@/lib/coded-copy";
import { useCopy } from "@/lib/i18n/use-copy";
import { runStatusCopy, type RunStatusTone } from "@/lib/run-ledger-copy";

/**
 * A run status as a chip: an icon AND a label, never colour alone. Shared by the
 * delivery inspector and the Agent → Runs tab so the two never drift.
 */
const TONE: Record<RunStatusTone, { chip: string; Icon: typeof IconCircleCheck; spin?: boolean }> = {
    ok: { chip: "border-emerald-500/25 bg-emerald-500/10 text-emerald-300", Icon: IconCircleCheck },
    bad: { chip: "border-rose-500/25 bg-rose-500/10 text-rose-300", Icon: IconCircleX },
    warn: { chip: "border-amber-500/25 bg-amber-500/10 text-amber-300", Icon: IconAlertTriangle },
    info: { chip: "border-cyan-500/25 bg-cyan-500/10 text-cyan-300", Icon: IconLoader2, spin: true },
    muted: { chip: "border-zinc-700/70 bg-zinc-900/80 text-zinc-400", Icon: IconClockHour4 },
};

export function RunStatusChip({ status, className }: { status: string; className?: string }) {
    const render = useCopy();
    const { label, tone } = runStatusCopy(status);
    const { chip, Icon, spin } = TONE[tone];
    return (
        <span className={cn("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold", chip, className)}>
            <Icon className={cn("h-3 w-3", spin && "animate-spin motion-reduce:animate-none")} aria-hidden="true" />
            {render(copy(`runStatus.${status}`), label)}
        </span>
    );
}
