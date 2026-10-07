"use client";
import { useState } from "react";

import {
  IconCircleCheck,
  IconCoffee,
  IconHandStop,
  IconPlayerPause,
  IconAlertTriangle,
} from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { TASK_STATES } from "@/lib/task-state";

/* ── Re-export the types the dashboard server component builds ── */
export type HealthStatus = "healthy" | "attention" | "down" | "idle";

export interface BoardTask {
  id: string;
  projectId: string;
  title: string;
  state: string;
  dueAt: Date | string | null;
  projectName: string | null;
}

export interface Worker {
  key: string;
  kind: "agent" | "human";
  id: string;
  name: string;
  subtitle: string | null;
  avatarUrl: string | null;
  status: HealthStatus | null;
  activity: string | null;
  working: BoardTask[];
  waiting: BoardTask[];
  next: BoardTask[];
  doneToday: number;
  href: string;
}

/* ── Activity icons for agent state visual ── */
const ACTIVITY_ICON: Record<string, React.FC<{ className?: string }>> = {
  working: IconCircleCheck,
  waiting: IconHandStop,
  idle: IconCoffee,
  down: IconAlertTriangle,
  typing: IconPlayerPause,
};

function activityLabel(worker: Worker): { label: string; emoji: string; animClass: string } {
  if (worker.status === "down") return { label: "Offline", emoji: "💤", animClass: "anim-down" };
  if (worker.waiting.length > 0) return { label: "Blocked", emoji: "✋", animClass: "anim-waiting" };
  if (worker.working.length > 0) {
    const act = worker.activity?.toLowerCase() || "";
    if (act.includes("type") || act.includes("code") || act.includes("write"))
      return { label: "Coding", emoji: "⌨️", animClass: "anim-typing" };
    if (act.includes("search") || act.includes("read") || act.includes("research"))
      return { label: "Researching", emoji: "🔍", animClass: "anim-working" };
    if (act.includes("review") || act.includes("check") || act.includes("test"))
      return { label: "Reviewing", emoji: "🔎", animClass: "anim-working" };
    return { label: "Working", emoji: "⚙️", animClass: "anim-working" };
  }
  if (worker.next.length > 0) return { label: "Ready", emoji: "📋", animClass: "" };
  if (worker.doneToday > 0) return { label: "Done for now", emoji: "☕", animClass: "anim-idle" };
  return { label: "Idle", emoji: "☕", animClass: "anim-idle" };
}

/* ── Scene dimensions ── */
const SCENE_W = 1200;
const SCENE_H = 800;
const AGENT_R = 40;         // node radius
const COL_GAP = 140;        // horizontal between agents
const ROW_GAP = 140;        // vertical between rows
const CLUSTER_GAP = 80;     // extra gap between project clusters
const MARGIN = 60;          // scene edge margin
const LABEL_H = 32;         // project label height

/* ── Layout result ── */
interface PlacedAgent {
  worker: Worker;
  x: number;
  y: number;
  projectLabel: string | null;
}

interface Connection {
  fromId: string;
  toId: string;
  projectName: string;
}

function layoutAgents(workers: Worker[]): {
  agents: PlacedAgent[];
  connections: Connection[];
  sceneW: number;
  sceneH: number;
} {
  // Group workers by project (use first project they share)
  const projectMap = new Map<string, { label: string; members: Worker[] }>();

  // Workers with no project go into "General"
  const general: Worker[] = [];

  for (const w of workers) {
    // Find all unique projects this worker touches
    const allProjects = new Set<string>();
    for (const t of [...w.working, ...w.waiting, ...w.next]) {
      if (t.projectId) allProjects.add(t.projectId);
    }
    if (allProjects.size === 0) {
      general.push(w);
      continue;
    }
    for (const pid of allProjects) {
      const label = w.working.find((t) => t.projectId === pid)?.projectName
        ?? w.waiting.find((t) => t.projectId === pid)?.projectName
        ?? w.next.find((t) => t.projectId === pid)?.projectName
        ?? pid.slice(0, 12);
      if (!projectMap.has(pid)) projectMap.set(pid, { label, members: [] });
      projectMap.get(pid)!.members.push(w);
    }
  }

  // Deduplicate workers across projects — a worker can be in multiple projects but we place them once
  const placedWorkers = new Set<string>();
  const clusters: Array<{ label: string; members: Worker[] }> = [];

  for (const [, cluster] of projectMap) {
    const unique: Worker[] = [];
    for (const w of cluster.members) {
      if (!placedWorkers.has(w.key)) {
        placedWorkers.add(w.key);
        unique.push(w);
      }
    }
    if (unique.length > 0) clusters.push({ label: cluster.label, members: unique });
  }

  // Remaining unplaced workers go to general
  const unplaced = workers.filter((w) => !placedWorkers.has(w.key));
  if (unplaced.length > 0) {
    clusters.push({ label: "General", members: unplaced });
  }

  // Compute positions
  const agents: PlacedAgent[] = [];
  const connections: Connection[] = [];
  let cursorY = MARGIN;

  for (const cluster of clusters) {
    const members = cluster.members;
    const perRow = Math.max(1, Math.min(members.length, Math.floor((SCENE_W - MARGIN * 2) / COL_GAP) + 1));
    const rows = Math.ceil(members.length / perRow);

    // Label
    cursorY += LABEL_H;
    let cursorX = MARGIN;
    let row = 0;

    for (let i = 0; i < members.length; i++) {
      const x = cursorX + (i % perRow) * COL_GAP;
      const y = cursorY + row * ROW_GAP;
      agents.push({ worker: members[i], x, y, projectLabel: cluster.label });

      if (i > 0 && i % perRow === 0) {
        row++;
        cursorX = MARGIN;
      }
    }

    // Connections: pair adjacent agents in this project cluster
    for (let i = 0; i < members.length - 1; i++) {
      connections.push({
        fromId: members[i].id,
        toId: members[i + 1].id,
        projectName: cluster.label,
      });
    }

    cursorY += rows * ROW_GAP + CLUSTER_GAP;
  }

  return {
    agents,
    connections,
    sceneW: SCENE_W,
    sceneH: Math.max(SCENE_H, cursorY + MARGIN),
  };
}

/* ── Connection line with animated particle ── */
function ConnectionLine({
  x1, y1, x2, y2, label, animId,
}: {
  x1: number; y1: number; x2: number; y2: number;
  label: string; animId: string;
}) {
  // Calculate midpoint for particle
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  return (
    <g className="connection-group">
      <line
        x1={x1} y1={y1} x2={x2} y2={y2}
        stroke="var(--zinc-600)"
        strokeWidth={1.5}
        strokeDasharray="6 4"
        className="connection-line"
      />
      {/* Animated particle along the line */}
      <circle r={3} fill="var(--cyan-400)" className={`connection-particle anim-connection-particle-${animId}`}>
        <animateMotion
          dur="3s"
          repeatCount="indefinite"
          path={`M${x1},${y1} L${x2},${y2}`}
        />
      </circle>
    </g>
  );
}

/* ── Single agent sprite ── */
function AgentSprite({
  worker, x, y,
  selected, onClick,
}: {
  worker: Worker; x: number; y: number;
  selected: boolean; onClick: () => void;
}) {
  const { label, emoji, animClass } = activityLabel(worker);
  const statusColor = worker.status === "healthy" ? "emerald" :
    worker.status === "attention" ? "amber" :
    worker.status === "down" ? "rose" : "zinc";

  return (
    <g
      className={cn(
        "agent-sprite cursor-pointer select-none transition-all duration-300",
        selected && "agent-selected",
        animClass,
      )}
      transform={`translate(${x}, ${y})`}
      onClick={onClick}
      role="button"
      aria-label={`${worker.name}: ${label}`}
      tabIndex={0}
    >
      {/* Status ring */}
      <circle
        r={AGENT_R + 4}
        fill="none"
        stroke={`var(--${statusColor}-400)`}
        strokeWidth={3}
        className={cn("agent-ring", worker.status === "down" && "animate-pulse")}
      />

      {/* Agent body — hexagon background */}
      <polygon
        points={hexagonPoints(AGENT_R)}
        fill="var(--zinc-900)"
        stroke="var(--zinc-700)"
        strokeWidth={1}
        className="agent-body"
      />

      {/* Avatar or emoji */}
      {worker.avatarUrl ? (
        <image href={worker.avatarUrl} x={-14} y={-14} width={28} height={28} className="agent-avatar rounded-xl" />
      ) : (
        <text x={0} y={5} textAnchor="middle" fontSize={18} fill="var(--zinc-300)" className="agent-emoji">
          {worker.kind === "agent" ? "🤖" : "👤"}
        </text>
      )}

      {/* Activity emoji above */}
      <text x={0} y={-AGENT_R - 10} textAnchor="middle" fontSize={14} className="agent-activity-emoji">
        {emoji}
      </text>

      {/* Name */}
      <text x={0} y={AGENT_R + 18} textAnchor="middle" fontSize={11} fill="var(--zinc-200)" className="agent-name">
        {worker.name.length > 12 ? worker.name.slice(0, 11) + "…" : worker.name}
      </text>

      {/* Activity label */}
      <text x={0} y={AGENT_R + 32} textAnchor="middle" fontSize={9}
        fill={`var(--${statusColor}-300)`}
        className="agent-activity-label"
      >
        {label}
      </text>

      {/* Done counter if > 0 */}
      {worker.doneToday > 0 && (
        <text x={AGENT_R + 12} y={-AGENT_R + 4} textAnchor="start" fontSize={9}
          fill="var(--emerald-400)" className="agent-done-badge"
        >
          ✓{worker.doneToday}
        </text>
      )}
    </g>
  );
}

function hexagonPoints(r: number): string {
  const pts: string[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 3) * i - Math.PI / 2;
    pts.push(`${r * Math.cos(angle)},${r * Math.sin(angle)}`);
  }
  return pts.join(" ");
}

/* ── Main scene component ── */
export function AgentOfficeScene({
  workers,
  onAgentSelect,
}: {
  workers: Worker[];
  onAgentSelect?: (worker: Worker) => void;
}) {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const { agents, connections, sceneW, sceneH } = layoutAgents(workers);
  const showLines = workers.length <= 30; // disable connections for huge teams

  return (
    <svg
      viewBox={`0 0 ${sceneW} ${sceneH}`}
      className="w-full h-auto agent-office-scene"
      role="img"
      aria-label="Agent office scene"
      style={{ maxHeight: "700px" }}
    >
      <defs>
        <style>{`
          .agent-sprite { transition: transform 0.3s ease; }
          .agent-sprite:hover { transform: scale(1.08); }
          .agent-sprite:focus-visible { outline: 2px solid var(--cyan-400); }
          .agent-selected .agent-ring { stroke-width: 4; }
          .connection-line { transition: opacity 0.4s ease; }
          .connection-particle { filter: drop-shadow(0 0 4px var(--cyan-400)); }
          .agent-name { font-weight: 600; }
          .agent-activity-label { font-weight: 500; }
          .agent-done-badge { font-weight: 700; }

          @media (prefers-reduced-motion) {
            .connection-particle { display: none; }
            .agent-activity-emoji { animation: none !important; }
          }

          .anim-working .agent-activity-emoji {
            animation: float-work 2s ease-in-out infinite;
          }
          .anim-typing .agent-activity-emoji {
            animation: type-shake 1.5s ease-in-out infinite;
          }
          .anim-waiting .agent-activity-emoji {
            animation: pulse-wait 2s ease-in-out infinite;
          }
          .anim-idle .agent-activity-emoji {
            animation: idle-bob 3s ease-in-out infinite;
          }
          .anim-down .agent-activity-emoji {
            animation: fade-down 3s ease-in-out infinite;
          }

          @keyframes float-work {
            0%, 100% { transform: translateY(0); }
            50% { transform: translateY(-6px); }
          }
          @keyframes type-shake {
            0%, 100% { transform: rotate(0); }
            25% { transform: rotate(-8deg); }
            75% { transform: rotate(8deg); }
          }
          @keyframes pulse-wait {
            0%, 100% { transform: scale(1); }
            50% { transform: scale(1.2); }
          }
          @keyframes idle-bob {
            0%, 100% { transform: rotate(-3deg) translateY(0); }
            50% { transform: rotate(3deg) translateY(-3px); }
          }
          @keyframes fade-down {
            0%, 100% { opacity: 0.4; }
            50% { opacity: 1; }
          }

          @keyframes particle-flow {
            0% { transform: translateX(0); }
            100% { transform: translateX(100%); }
          }
          .animate-pulse { animation: pulse-ring 2s ease-in-out infinite; }
          @keyframes pulse-ring {
            0%, 100% { stroke-opacity: 1; }
            50% { stroke-opacity: 0.4; }
          }
        `}</style>
      </defs>

      {/* Background */}
      <rect width={sceneW} height={sceneH} fill="var(--zinc-950)" rx={16} />
      <pattern id="floorGrid" width={40} height={40} patternUnits="userSpaceOnUse">
        <rect width={40} height={40} fill="none" stroke="var(--zinc-800)" strokeWidth={0.5} />
      </pattern>
      <rect width={sceneW} height={sceneH} fill="url(#floorGrid)" opacity={0.3} />

      {/* Title */}
      <text x={MARGIN} y={28} fontSize={16} fontWeight={700} fill="var(--zinc-100)">
        🏢 Agent Office · {workers.length} agent{workers.length === 1 ? "" : "s"}
      </text>

      {/* Project connections */}
      {showLines && connections.map((c, i) => {
        const from = agents.find((a) => a.worker.id === c.fromId);
        const to = agents.find((a) => a.worker.id === c.toId);
        if (!from || !to) return null;
        return (
          <ConnectionLine
            key={`conn-${i}`}
            x1={from.x} y1={from.y}
            x2={to.x} y2={to.y}
            label={c.projectName}
            animId={`particle-${i}`}
          />
        );
      })}

      {/* Agents */}
      {agents.map((a) => (
        <AgentSprite
          key={a.worker.key}
          worker={a.worker}
          x={a.x}
          y={a.y}
          selected={selectedKey === a.worker.key}
          onClick={() => {
            const newKey = selectedKey === a.worker.key ? null : a.worker.key;
            setSelectedKey(newKey);
            onAgentSelect?.(newKey ? a.worker : null as unknown as Worker);
          }}
        />
      ))}

      {/* Project labels */}
      {(() => {
        const seen = new Set<string>();
        return agents.filter((a) => a.projectLabel && !seen.has(a.projectLabel!)).map((a) => {
          seen.add(a.projectLabel!);
          return (
            <text key={`label-${a.projectLabel}`}
              x={a.x} y={a.y - AGENT_R - 32}
              textAnchor="middle" fontSize={11} fontWeight={600}
              fill="var(--zinc-400)"
              className="project-label"
            >
              📁 {a.projectLabel}
            </text>
          );
        });
      })()}

      {/* Legend */}
      <g transform={`translate(${MARGIN}, ${sceneH - 50})`}>
        <rect x={0} y={0} width={320} height={40} rx={8} fill="var(--zinc-900)" opacity={0.8} />
        <text x={10} y={16} fontSize={9} fill="var(--zinc-400)">Status:</text>
        {[
          { color: "emerald", label: "Online" },
          { color: "amber", label: "Needs attention" },
          { color: "rose", label: "Down" },
          { color: "zinc", label: "Idle" },
        ].map((s, i) => (
          <g key={i} transform={`translate(${80 + i * 65}, 0)`}>
            <circle cx={0} cy={12} r={4} fill={`var(--${s.color}-400)`} />
            <text x={8} y={16} fontSize={9} fill="var(--zinc-500)">{s.label}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
