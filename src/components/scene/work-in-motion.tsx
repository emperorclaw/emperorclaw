'use client';

import Link from "next/link";
import { cn } from "@/lib/utils";
import type { Worker } from "../agent-office-scene";

export function WorkInMotion({ workers }: { workers: Worker[] }) {
  const inProgress = workers.flatMap((w) =>
    w.working.map((t) => ({ ...t, assignee: w.name, assigneeKey: w.key }))
  );
  const inReview = workers.flatMap((w) =>
    w.waiting.map((t) => ({ ...t, assignee: w.name, assigneeKey: w.key }))
  );
  const doneToday = workers.flatMap((w) =>
    Array.from({ length: Math.min(w.doneToday, 5) }, (_, i) => ({
      id: w.key + "-done-" + i,
      title: "Task completed",
      projectName: null,
      projectId: null,
      assignee: w.name,
      assigneeKey: w.key,
    }))
  );

  const columns = [
    { title: "In progress", tasks: inProgress, color: "cyan" },
    { title: "In review", tasks: inReview, color: "amber" },
    { title: "Done today", tasks: doneToday, color: "emerald" },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {columns.map((col) => (
        <div key={col.title} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
          <div className={"mb-2 text-[10px] font-semibold uppercase tracking-wider text-" + col.color + "-300"}>
            {col.title} · {col.tasks.length}
          </div>
          {col.tasks.length === 0 ? (
            <p className="text-[10px] text-zinc-600">Nothing here yet.</p>
          ) : (
            <ul className="space-y-1">
              {col.tasks.slice(0, 6).map((t) => (
                <li key={t.id}>
                  <Link
                    href={"/projects?project=" + (t.projectId || "") + "&task=" + t.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs transition-colors hover:bg-zinc-800/50"
                  >
                    <span className={"h-1.5 w-1.5 rounded-full bg-" + col.color + "-400"} />
                    <span className="min-w-0 flex-1 text-xs text-zinc-300 overflow-hidden text-ellipsis">{t.title}</span>
                    {t.projectName && <span className="text-zinc-500">{t.projectName}</span>}
                    <span className="text-zinc-600">{t.assignee}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
