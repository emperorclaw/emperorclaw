"use client";

import { cn } from "@/lib/utils";
import type { Worker } from "../agent-office-scene";

/* ── Isometric office scene ── */
// Uses SVG transforms: scale(1, 0.5) rotate(45) gives isometric view
// Sizes are for flat coordinates; the transform handles the projection

interface AgentPos {
  worker: Worker;
  gx: number;  // grid column (flat coords)
  gy: number;  // grid row (flat coords)
  deskType: "dev" | "research" | "content" | "review" | "test" | "coffee";
  label: string;
  emoji: string;
}

const DESK_COLORS: Record<string, string> = {
  dev: "var(--cyan-800)",
  research: "var(--violet-800)",
  content: "var(--teal-800)",
  review: "var(--amber-800)",
  test: "var(--emerald-800)",
  coffee: "var(--zinc-700)",
};

const DESK_LABELS: Record<string, string> = {
  dev: "Development",
  research: "Research",
  content: "Content",
  review: "Review",
  test: "Testing",
  coffee: "Break area",
};

/* Agent activity status */
function agentStatus(worker: Worker): { label: string; color: string } {
  if (worker.status === "down") return { label: "Offline", color: "var(--rose-400)" };
  if (worker.waiting.length > 0) return { label: "Waiting for " + (worker.activity?.toLowerCase() || "response"), color: "var(--amber-400)" };
  if (worker.working.length > 0) return { label: worker.activity || "Working", color: "var(--emerald-400)" };
  return { label: "Available", color: "var(--zinc-400)" };
}

function agentEmoji(worker: Worker): string {
  if (worker.status === "down") return "💤";
  if (worker.waiting.length > 0) return "✋";
  if (worker.working.length > 0) {
    const a = worker.activity?.toLowerCase() || "";
    if (a.includes("code") || a.includes("build") || a.includes("api")) return "⌨️";
    if (a.includes("writ") || a.includes("articl") || a.includes("draft")) return "✍️";
    if (a.includes("review") || a.includes("check") || a.includes("audit")) return "🔍";
    if (a.includes("test")) return "🧪";
    if (a.includes("research") || a.includes("lead") || a.includes("search")) return "🔎";
    return "⚙️";
  }
  return "☕";
}

/* ── Isometric transform ── */
const ISO = "scale(1, 0.5) rotate(45)";
const GRID = 56;  // spacing between grid points (flat coords)

/* Build floor plan positions */
function buildPositions(workers: Worker[]): [AgentPos[], AgentPos | null] {
  const deskTypes = ["dev", "research", "content", "review", "test", "coffee"] as const;
  const pos: AgentPos[] = [];
  let coffeeArea: AgentPos | null = null;

  // Sort workers: agents with work get desks, idle goes to coffee zone
  const busy = workers.filter((w) => w.working.length > 0 || w.waiting.length > 0);
  const idle = workers.filter((w) => w.working.length === 0 && w.waiting.length === 0);

  // Assign stations in order
  const cx = 4, cy = 4; // center of office
  const stations = [
    { gx: cx, gy: cy - 2, deskType: "dev" as const },         // top-center: dev
    { gx: cx - 2, gy: cy - 3, deskType: "research" as const },  // top-left: research
    { gx: cx + 2, gy: cy - 3, deskType: "content" as const },   // top-right: content
    { gx: cx - 2, gy: cy + 1, deskType: "review" as const },    // left: review
    { gx: cx + 2, gy: cy + 1, deskType: "test" as const },      // right: test
    { gx: cx, gy: cy + 3, deskType: "coffee" as const },         // bottom: coffee
  ];

  for (let i = 0; i < Math.min(busy.length, stations.length - 1); i++) {
    const s = stations[i];
    const st = agentStatus(busy[i]);
    pos.push({
      worker: busy[i],
      gx: s.gx, gy: s.gy,
      deskType: s.deskType,
      label: st.label,
      emoji: agentEmoji(busy[i]),
    });
  }

  // Remaining busy workers go to secondary positions
  for (let i = stations.length - 1; i < busy.length; i++) {
    const offset = i - (stations.length - 1);
    pos.push({
      worker: busy[i],
      gx: 2 + offset * 2,
      gy: 1,
      deskType: "dev",
      label: busy[i].activity || "Working",
      emoji: agentEmoji(busy[i]),
    });
  }

  // Idle agents go to coffee area
  if (idle.length > 0) {
    const coffeeStation = stations[stations.length - 1];
    pos.push({
      worker: idle[0],
      gx: coffeeStation.gx,
      gy: coffeeStation.gy,
      deskType: "coffee",
      label: "Available",
      emoji: "☕",
    });
    coffeeArea = pos[pos.length - 1];
    // Additional idle agents
    for (let i = 1; i < idle.length; i++) {
      pos.push({
        worker: idle[i],
        gx: coffeeStation.gx + i * 2,
        gy: coffeeStation.gy + 1,
        deskType: "coffee",
        label: "Available",
        emoji: "☕",
      });
    }
  }

  return [pos, coffeeArea];
}

/* ── Grid helper: flat coords → isometric SVG point ── */
function isoPoint(gx: number, gy: number, w: number = 0, h: number = 0): { x: number; y: number } {
  // Center of SVG in screen space
  const centerX = 600, centerY = 350;
  // Isometric: x = (gx - gy) * GRID, y = (gx + gy) * GRID / 2
  const ix = (gx - gy) * GRID * 0.8;
  const iy = (gx + gy) * GRID * 0.4;
  return { x: centerX + ix + w / 2, y: centerY + iy + h / 2 };
}

/* ── Desk SVG (isometric) ── */
function Desk({ gx, gy, type }: { gx: number; gy: number; type: string }) {
  const p = isoPoint(gx, gy);
  const color = DESK_COLORS[type] || "var(--zinc-700)";
  return (
    <g transform={`translate(${p.x}, ${p.y})`}>
      {/* Desk surface (isometric top) */}
      <polygon
        points="0,0 40,-20 80,0 40,20"
        fill={color}
        stroke="var(--zinc-600)"
        strokeWidth={1}
        opacity={0.8}
      />
      {/* Left leg */}
      <polygon points="5,5 5,25 15,30 15,10" fill="var(--zinc-800)" stroke="var(--zinc-700)" strokeWidth={0.5} />
      {/* Right leg */}
      <polygon points="65,-15 65,5 75,10 75,-10" fill="var(--zinc-800)" stroke="var(--zinc-700)" strokeWidth={0.5} />
      {/* Monitor */}
      {type !== "coffee" && type !== "research" && (
        <g>
          <rect x={25} y={-35} width={30} height={24} rx={2} fill="var(--zinc-950)" stroke="var(--zinc-600)" strokeWidth={0.5} />
          <rect x={27} y={-33} width={26} height={18} rx={1} fill="var(--cyan-950)" />
          {type === "dev" && <text x={40} y={-21} textAnchor="middle" fontSize={6} fill="var(--cyan-400)">{">_"}</text>}
          {type === "content" && <text x={40} y={-21} textAnchor="middle" fontSize={6} fill="var(--teal-300)">W</text>}
          {type === "test" && <text x={40} y={-21} textAnchor="middle" fontSize={6} fill="var(--emerald-300)">✓</text>}
          <rect x={35} y={-11} width={10} height={3} rx={1} fill="var(--zinc-700)" />
        </g>
      )}
      {/* Plant on research desk */}
      {type === "research" && (
        <g transform="translate(30, -30)">
          <rect x={-4} y={0} width={8} height={10} rx={2} fill="var(--emerald-900)" />
          <ellipse cx={0} cy={-6} rx={8} ry={10} fill="var(--emerald-600)" opacity={0.7} />
        </g>
      )}
      {/* Coffee machine */}
      {type === "coffee" && (
        <g transform="translate(25, -35)">
          <rect x={0} y={0} width={20} height={26} rx={3} fill="var(--zinc-800)" stroke="var(--zinc-600)" strokeWidth={0.5} />
          <circle cx={10} cy={8} r={4} fill="var(--amber-900)" />
          <text x={10} y={18} textAnchor="middle" fontSize={8}>☕</text>
        </g>
      )}
      {/* Zone label */}
      <text x={40} y={38} textAnchor="middle" fontSize={7} fill="var(--zinc-500)">{DESK_LABELS[type]}</text>
    </g>
  );
}

/* ── Agent sprite on isometric floor ── */
function AgentOnFloor({ pos, selected, onClick }: { pos: AgentPos; selected: boolean; onClick: () => void }) {
  const p = isoPoint(pos.gx, pos.gy, 0, -60);
  const st = agentStatus(pos.worker);
  const color = DESK_COLORS[pos.deskType] || "zinc";

  const statusRing = selected ? "var(--cyan-300)" : st.color;

  return (
    <g
      transform={`translate(${p.x}, ${p.y - 80})`}
      className="cursor-pointer transition-all duration-300"
      onClick={onClick}
      role="button"
      tabIndex={0}
    >
      {/* Shadow */}
      <ellipse cx={0} cy={35} rx={24} ry={12} fill="var(--zinc-950)" opacity={0.3} />

      {/* Body */}
      <rect x={-14} y={-6} width={28} height={34} rx={4} fill={`var(--${color.replace("var(--", "").replace("-800)", "")}-800)` || "var(--zinc-800)"} stroke={statusRing} strokeWidth={selected ? 2.5 : 1.5} />

      {/* Head */}
      <circle cx={0} cy={-14} r={12} fill="var(--zinc-700)" stroke={statusRing} strokeWidth={selected ? 2 : 1} />

      {/* Eyes */}
      {pos.deskType !== "coffee" ? (
        <>
          <circle cx={-4} cy={-14} r={2} fill="var(--zinc-950)" />
          <circle cx={4} cy={-14} r={2} fill="var(--zinc-950)" />
          <circle cx={-3} cy={-15} r={0.8} fill="var(--cyan-300)" />
          <circle cx={5} cy={-15} r={0.8} fill="var(--cyan-300)" />
        </>
      ) : (
        /* Sleepy eyes for coffee zone */
        <path d="M-6,-13 Q-4,-15 -2,-13 M2,-13 Q4,-15 6,-13" fill="none" stroke="var(--zinc-950)" strokeWidth={1.2} />
      )}

      {/* Status indicator */}
      {pos.worker.waiting.length > 0 && (
        <text x={0} y={-28} textAnchor="middle" fontSize={14} className="animate-bounce">✋</text>
      )}

      {/* Name tag */}
      <rect x={-28} y={34} width={56} height={16} rx={4} fill="var(--zinc-900)" stroke="var(--zinc-700)" strokeWidth={0.5} />
      <text x={0} y={45} textAnchor="middle" fontSize={8} fontWeight={600} fill="var(--zinc-200)">
        {pos.worker.name.length > 12 ? pos.worker.name.slice(0, 11) + "…" : pos.worker.name}
      </text>

      {/* Activity label */}
      {selected && (
        <g transform={`translate(40, -10)`}>
          <rect x={0} y={0} width={120} height={50} rx={6} fill="var(--zinc-900)" stroke="var(--zinc-700)" strokeWidth={0.5} opacity={0.95} />
          <text x={8} y={14} fontSize={7} fontWeight={600} fill={`var(--${pos.worker.status === "healthy" ? "emerald" : pos.worker.status === "attention" ? "amber" : pos.worker.status === "down" ? "rose" : "zinc"}-300)`}>{st.label}</text>
          <text x={8} y={26} fontSize={7} fill="var(--zinc-400)">Tasks: {pos.worker.working.length} working, {pos.worker.waiting.length} waiting</text>
          <text x={8} y={38} fontSize={7} fill="var(--zinc-500)">Done today: {pos.worker.doneToday}</text>
          <rect x={62} y={42} width={50} height={5} rx={3} fill="var(--zinc-700)" />
          <rect x={62} y={42} width={Math.min(pos.worker.doneToday * 10, 50)} height={5} rx={3} fill="var(--emerald-500)" />
        </g>
      )}
    </g>
  );
}

/* ── Connection line between desks ── */
function ConnectionCurve({ from, to, delay }: { from: AgentPos; to: AgentPos; delay: number }) {
  const f = isoPoint(from.gx, from.gy, 0, -60);
  const t = isoPoint(to.gx, to.gy, 0, -60);
  const mx = (f.x + t.x) / 2;
  const my = Math.min(f.y, t.y) - 40;

  return (
    <g>
      <path
        d={`M${f.x},${f.y-60} Q${mx},${my} ${t.x},${t.y-60}`}
        fill="none"
        stroke="var(--zinc-600)"
        strokeWidth={1.5}
        strokeDasharray="6 4"
        className="connection-curve"
      />
      {/* Flying document */}
      <circle r={3} fill="var(--cyan-400)" className="connection-doc">
        <animateMotion
          dur={`${2 + delay}s`}
          repeatCount="indefinite"
          path={`M${f.x},${f.y-60} Q${mx},${my} ${t.x},${t.y-60}`}
        />
      </circle>
    </g>
  );
}

/* ── Main isometric office component ── */
export function IsometricOffice({
  workers,
  selectedKey,
  onAgentSelect,
}: {
  workers: Worker[];
  selectedKey: string | null;
  onAgentSelect: (key: string | null) => void;
}) {
  const [positions] = buildPositions(workers);

  // Build connections between agents on same project
  const connections: Array<{ from: AgentPos; to: AgentPos; delay: number }> = [];
  for (let i = 0; i < positions.length - 1; i++) {
    const a = positions[i];
    const aProj = a.worker.working[0]?.projectId || a.worker.waiting[0]?.projectId;
    for (let j = i + 1; j < positions.length; j++) {
      const b = positions[j];
      const bProj = b.worker.working[0]?.projectId || b.worker.waiting[0]?.projectId;
      if (aProj && aProj === bProj) {
        connections.push({ from: a, to: b, delay: i * 0.3 });
      }
    }
  }

  return (
    <svg viewBox="0 0 1200 700" className="w-full h-auto" role="img" aria-label="Isometric agent office">
      <defs>
        <pattern id="isoFloor" width={GRID * 2} height={GRID} patternUnits="userSpaceOnUse">
          <rect width={GRID * 2} height={GRID} fill="none" />
          <line x1={0} y1={0} x2={GRID} y2={GRID / 2} stroke="var(--zinc-800)" strokeWidth={0.5} />
          <line x1={GRID * 2} y1={0} x2={GRID} y2={GRID / 2} stroke="var(--zinc-800)" strokeWidth={0.5} />
        </pattern>
        <style>{`
          .connection-curve { transition: opacity 0.4s; }
          .connection-doc { filter: drop-shadow(0 0 3px var(--cyan-400)); }
          @media (prefers-reduced-motion) { .connection-doc { display: none; } }
        `}</style>
      </defs>

      {/* Background */}
      <rect width={1200} height={700} fill="var(--zinc-950)" />

      {/* Isometric floor */}
      <g transform={`translate(600, 300) ${ISO}`}>
        <rect x={-300} y={-200} width={600} height={400} fill="var(--zinc-900)" />
        <rect x={-300} y={-200} width={600} height={400} fill="url(#isoFloor)" opacity={0.5} />
      </g>

      {/* Decorative walls */}
      <g opacity={0.15}>
        {/* Back wall */}
        <polygon points="200,100 400,50 800,50 1000,100" fill="var(--zinc-700)" />
        {/* Left wall */}
        <polygon points="200,100 400,50 400,300 200,350" fill="var(--zinc-800)" />
        {/* Right wall */}
        <polygon points="1000,100 800,50 800,300 1000,350" fill="var(--zinc-800)" />
      </g>

      {/* Connection curves (behind agents) */}
      {connections.map((c, i) => (
        <ConnectionCurve key={`conn-${i}`} from={c.from} to={c.to} delay={c.delay} />
      ))}

      {/* Desks */}
      {positions.map((p, i) => (
        <Desk key={`desk-${i}`} gx={p.gx} gy={p.gy} type={p.deskType} />
      ))}

      {/* Agents */}
      {positions.map((p, i) => (
        <AgentOnFloor
          key={p.worker.key}
          pos={p}
          selected={selectedKey === p.worker.key}
          onClick={() => onAgentSelect(selectedKey === p.worker.key ? null : p.worker.key)}
        />
      ))}

      {/* Legend */}
      <g transform="translate(20, 660)">
        <rect x={0} y={0} width={400} height={28} rx={6} fill="var(--zinc-900)" opacity={0.8} />
        {[
          ["var(--emerald-400)", "Working"],
          ["var(--amber-400)", "Waiting"],
          ["var(--rose-400)", "Offline"],
          ["var(--zinc-400)", "Available"],
        ].map(([c, l], i) => (
          <g key={i} transform={`translate(${10 + i * 100}, 0)`}>
            <circle cx={8} cy={14} r={4} fill={c} />
            <text x={16} y={17} fontSize={9} fill="var(--zinc-400)">{l}</text>
          </g>
        ))}
      </g>
    </svg>
  );
}
