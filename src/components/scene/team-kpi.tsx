"use client";

import { cn } from "@/lib/utils";
import type { Worker } from "../agent-office-scene";

export function TeamKPI({ workers, onFilter }: {
  workers: Worker[];
  onFilter?: (filter: string) => void;
}) {
  const working = workers.filter((w) => w.working.length > 0).length;
  const waiting = workers.filter((w) => w.waiting.length > 0).length;
  const doneToday = workers.reduce((s, w) => s + w.doneToday, 0);
  const needYou = workers.filter((w) => w.status === "attention" || w.status === "down").length;

  const items = [
    { key: "working", label: "working", value: working, color: "emerald" },
    { key: "waiting", label: "waiting", value: waiting, color: "amber" },
    { key: "done", label: "completed today", value: doneToday, color: "cyan" },
    { key: "need", label: "need you", value: needYou, color: "rose" },
  ] as const;

  return (
    <div className="flex items-center gap-3">
      {items.map((item) => (
        <button
          key={item.key}
          onClick={() => onFilter?.(item.key)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs transition-colors cursor-pointer",
            "bg-" + item.color + "-500/8 text-" + item.color + "-200 hover:bg-" + item.color + "-500/15",
          )}
        >
          <span className={cn("h-2 w-2 rounded-full", "bg-" + item.color + "-400")} />
          <span className="tabular-nums font-semibold">{item.value}</span>
          <span className="text-zinc-400">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
