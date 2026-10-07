"use client";

import { useState } from "react";
import { AgentOfficeScene } from "./agent-office-scene";
import { AgentDetailPanel } from "./agent-detail-panel";
import type { Worker } from "./agent-office-scene";

export function AgentSceneWrapper({ workers }: { workers: Worker[] }) {
  const [selected, setSelected] = useState<Worker | null>(null);

  return (
    <div className="relative">
      <AgentOfficeScene
        workers={workers}
        onAgentSelect={(w) => setSelected(w ?? null)}
      />
      {selected && (
        <>
          <div
            className="fixed inset-0 z-40 bg-black/30"
            onClick={() => setSelected(null)}
          />
          <AgentDetailPanel
            worker={selected}
            onClose={() => setSelected(null)}
            onNavigate={(href) => { window.location.href = href; }}
          />
        </>
      )}
    </div>
  );
}
