"use client";

import { IconArrowRight } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { Worker } from "../agent-office-scene";

/* ── Needs your attention panel ── */
export function NeedsAttention({ workers }: { workers: Worker[] }) {
  const blocked = workers.filter((w) => w.waiting.length > 0 || w.status === "attention" || w.status === "down");

  if (blocked.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Needs your attention</div>
        <p className="mt-3 text-xs text-zinc-600">Nothing needs you right now.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Needs your attention</div>
      {blocked.slice(0, 5).map((w) => {
        const waitingTask = w.waiting[0];
        return (
          <div key={w.key} className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 transition-colors hover:border-zinc-700">
            <div className="flex items-center gap-2">
              <span className={cn("h-2 w-2 rounded-full", w.status === "down" ? "bg-rose-400" : w.status === "attention" ? "bg-amber-400" : "bg-amber-400")} />
              <span className="text-xs font-medium text-zinc-200">{w.name}</span>
              {w.subtitle && <span className="text-[10px] text-zinc-500">{w.subtitle}</span>}
            </div>
            <div className="mt-1 text-[10px] text-zinc-400">
              {w.status === "down"
                ? "Agent is offline. Needs investigation."
                : waitingTask
                  ? `Waiting: ${waitingTask.title.slice(0, 40)}${waitingTask.title.length > 40 ? "..." : ""}`
                  : "Needs review or input."}
            </div>
          </div>
        );
      })}
    </div>
  );
}
