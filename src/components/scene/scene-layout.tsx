"use client";

import { useState } from "react";
import { IsometricOffice } from "./isometric-office";
import { TeamKPI } from "./team-kpi";
import { NeedsAttention } from "./needs-attention";
import { WorkInMotion } from "./work-in-motion";
import { AgentDetailPanel } from "../agent-detail-panel";
import type { Worker } from "../agent-office-scene";

/* ── Full scene dashboard layout ── */
export function SceneDashboard({ workers }: { workers: Worker[] }) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [kpiFilter, setKpiFilter] = useState<string | null>(null);

  const selectedWorker = selectedKey
    ? workers.find((w) => w.key === selectedKey) || null
    : null;

  // Apply KPI filter
  let filtered = workers;
  if (kpiFilter === "working") filtered = workers.filter((w) => w.working.length > 0);
  else if (kpiFilter === "waiting") filtered = workers.filter((w) => w.waiting.length > 0);
  else if (kpiFilter === "need") filtered = workers.filter((w) => w.status === "attention" || w.status === "down");

  return (
    <div className="space-y-4 animate-in fade-in duration-500">
      {/* Header row: title + KPIs */}
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm text-zinc-500">Dashboard</div>
          <h1 className="text-xl font-bold text-zinc-100">Your team, in motion</h1>
          <p className="text-xs text-zinc-500 mt-0.5">See what is moving. Step in where it matters.</p>
        </div>
        <TeamKPI workers={workers} onFilter={setKpiFilter} />
      </div>

      {/* Main content: Office + Right panels */}
      <div className="grid grid-cols-[1fr_320px] gap-4">
        {/* Office scene */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-3">
          <div className="flex items-center justify-between mb-2">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
              LIVE
            </span>
          </div>
          <IsometricOffice
            workers={filtered}
            selectedKey={selectedKey}
            onAgentSelect={setSelectedKey}
          />
        </div>

        {/* Right panels */}
        <div className="space-y-4">
          <NeedsAttention workers={workers} />
          {selectedWorker && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
              <AgentDetailPanel
                worker={selectedWorker}
                onClose={() => setSelectedKey(null)}
                onNavigate={(href) => { window.location.href = href; }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Work in motion board */}
      <WorkInMotion workers={workers} />
    </div>
  );
}
