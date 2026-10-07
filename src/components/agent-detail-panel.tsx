"use client";

import { IconArrowRight, IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import type { Worker, HealthStatus } from "./agent-office-scene";

function ago(date: Date | string | null): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  const minutes = Math.round((Date.now() - d.getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

export function AgentDetailPanel({
  worker,
  onClose,
  onNavigate,
}: {
  worker: Worker | null;
  onClose: () => void;
  onNavigate?: (href: string) => void;
}) {
  if (!worker) return null;

  const statusColor: Record<HealthStatus | "none", string> = {
    healthy: "emerald",
    attention: "amber",
    down: "rose",
    idle: "zinc",
    none: "zinc",
  };
  const statusLabel: Record<HealthStatus | "none", string> = {
    healthy: "Online",
    attention: "Needs attention",
    down: "Down",
    idle: "Idle",
    none: "Unknown",
  };
  const color = statusColor[worker.status ?? "none"];

  return (
    <aside
      className={cn(
        "fixed inset-y-0 right-0 z-50 w-[380px] border-l border-zinc-800 bg-zinc-950 shadow-2xl",
        "translate-x-full transition-transform duration-300 ease-out",
        worker && "translate-x-0",
      )}
      role="dialog"
      aria-label={`${worker.name} detail`}
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`h-2.5 w-2.5 rounded-full bg-${color}-400`} />
          <span className={`inline-flex rounded-full bg-${color}-500/12 px-2 py-0.5 text-[11px] font-medium text-${color}-300`}>
            {statusLabel[worker.status ?? "none"]}
          </span>
        </div>
        <button onClick={onClose} className="cursor-pointer text-zinc-400 hover:text-zinc-200" aria-label="Close panel">
          <IconX className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 py-3.5">
        <div className="flex items-center gap-3">
          {worker.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={worker.avatarUrl} alt="" className="h-10 w-10 rounded-xl border border-zinc-700 bg-zinc-900 object-cover" />
          ) : (
            <span className="grid h-10 w-10 place-items-center rounded-xl border border-zinc-700 bg-zinc-900 text-sm font-semibold text-zinc-400">
              {worker.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <div>
            <div className="text-sm font-semibold text-zinc-100">{worker.name}</div>
            <div className="text-xs text-zinc-500">{worker.subtitle || (worker.kind === "agent" ? "Agent" : "Person")}</div>
          </div>
        </div>
      </div>

      {worker.activity && (
        <div className="mx-4 mb-3 rounded-lg bg-zinc-900 px-3 py-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Current activity</div>
          <div className="mt-0.5 text-sm text-cyan-300">{worker.activity}</div>
        </div>
      )}

      <div className="space-y-1 px-4">
        {worker.working.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Working on &middot; {worker.working.length}
            </div>
            <ul className="divide-y divide-zinc-800/50">
              {worker.working.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
                  <span className="min-w-0 flex-1 text-xs text-zinc-300">{t.title}</span>
                  {t.projectName && <span className="text-[10px] text-zinc-600">{t.projectName}</span>}
                  {t.dueAt && <span className="text-[10px] text-rose-400">{ago(t.dueAt)}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {worker.waiting.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
              Waiting &middot; {worker.waiting.length}
            </div>
            <ul className="divide-y divide-zinc-800/50">
              {worker.waiting.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  <span className="min-w-0 flex-1 text-xs text-zinc-300">{t.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {worker.next.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Next up</div>
            <ul className="divide-y divide-zinc-800/50">
              {worker.next.map((t) => (
                <li key={t.id} className="flex items-center gap-2 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-zinc-600" />
                  <span className="min-w-0 flex-1 text-xs text-zinc-400">{t.title}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="mx-4 mt-3 flex items-center justify-between rounded-lg bg-zinc-900 px-3 py-2">
        <span className="text-xs text-zinc-500">
          <span className="tabular-nums text-zinc-300">{worker.doneToday}</span> done today
        </span>
        <button
          onClick={() => onNavigate?.(worker.href)}
          className="inline-flex items-center gap-1 text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer"
        >
          View all tasks
          <IconArrowRight className="h-3 w-3" />
        </button>
      </div>
    </aside>
  );
}
