import type { ReactNode } from "react";
import { iso, type Point, type SceneStatus } from "@/lib/team-scene";

/* Isometric drawing primitives for the office floor. Every prop is plain SVG
   so the scene stays crisp at any size and can be rebuilt from live data. */

export const pts = (...points: Point[]) => points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

export interface BoxColors { top: string; left: string; right: string; edge?: string }

/** A box standing on the floor: gx/gy/w/d in tiles, z/h in screen units. */
export function Box({ gx, gy, z = 0, w, d, h, colors, opacity }: { gx: number; gy: number; z?: number; w: number; d: number; h: number; colors: BoxColors; opacity?: number }) {
    const t = z + h;
    return (
        <g opacity={opacity}>
            <polygon points={pts(iso(gx, gy + d, t), iso(gx + w, gy + d, t), iso(gx + w, gy + d, z), iso(gx, gy + d, z))} fill={colors.left} />
            <polygon points={pts(iso(gx + w, gy, t), iso(gx + w, gy + d, t), iso(gx + w, gy + d, z), iso(gx + w, gy, z))} fill={colors.right} />
            <polygon points={pts(iso(gx, gy, t), iso(gx + w, gy, t), iso(gx + w, gy + d, t), iso(gx, gy + d, t))} fill={colors.top} stroke={colors.edge} strokeWidth={colors.edge ? 1 : 0} />
        </g>
    );
}

/** Content laid flat on a vertical plane. "x" runs along gx (back wall), "y" along -gy (left wall). */
export function PlaneGroup({ at, axis, children }: { at: Point; axis: "x" | "y"; children: ReactNode }) {
    const skew = axis === "x" ? 0.5 : -0.5;
    return <g transform={`matrix(1 ${skew} 0 1 ${at.x.toFixed(1)} ${at.y.toFixed(1)})`}>{children}</g>;
}

/** An iso ellipse (a circle lying on the floor). */
export function FloorEllipse({ gx, gy, z = 0, r, fill, opacity, className, stroke, strokeWidth }: { gx: number; gy: number; z?: number; r: number; fill: string; opacity?: number; className?: string; stroke?: string; strokeWidth?: number }) {
    const c = iso(gx, gy, z);
    return <ellipse cx={c.x} cy={c.y} rx={r * 32 * 1.41} ry={r * 16 * 1.41} fill={fill} opacity={opacity} className={className} stroke={stroke} strokeWidth={strokeWidth} />;
}

const WOOD: BoxColors = { top: "#a8744a", left: "#7a5034", right: "#5e3c26", edge: "#c48c5c" };
const WOOD_BODY: BoxColors = { top: "#7a5034", left: "#6a4530", right: "#4c3020" };

export function Plant({ gx, gy, scale = 1, hue = 150 }: { gx: number; gy: number; scale?: number; hue?: number }) {
    const base = iso(gx, gy, 0);
    const s = scale;
    return (
        <g>
            <ellipse cx={base.x} cy={base.y + 2} rx={14 * s} ry={6 * s} fill="#020617" opacity={0.45} />
            <Box gx={gx - 0.22 * s} gy={gy - 0.22 * s} w={0.44 * s} d={0.44 * s} h={16 * s} colors={{ top: "#334155", left: "#1e293b", right: "#0f172a" }} />
            <g transform={`translate(${base.x} ${base.y - 16 * s}) scale(${s})`}>
                <path d="M 0 0 C -18 -10 -22 -30 -10 -40 C -6 -28 -2 -16 0 0" fill={`hsl(${hue} 55% 30%)`} />
                <path d="M 0 0 C 18 -12 24 -30 12 -42 C 6 -30 2 -16 0 0" fill={`hsl(${hue} 55% 34%)`} />
                <path d="M 0 0 C -4 -20 -2 -40 4 -52 C 8 -38 6 -18 0 0" fill={`hsl(${hue} 60% 40%)`} />
                <path d="M 0 -2 C -14 -4 -26 -14 -26 -22 C -16 -20 -6 -12 0 -2" fill={`hsl(${hue} 50% 26%)`} />
                <path d="M 0 -2 C 14 -6 24 -16 26 -26 C 14 -22 6 -12 0 -2" fill={`hsl(${hue} 50% 28%)`} />
                <path d="M 2 -48 C 4 -44 5 -36 4 -30" stroke={`hsl(${hue} 70% 60%)`} strokeWidth={1.2} fill="none" opacity={0.5} />
            </g>
        </g>
    );
}

export function Shelf({ gx, gy, seed = 0 }: { gx: number; gy: number; seed?: number }) {
    // A low bookcase seen from the front-left, books on its face.
    const books = ["#38bdf8", "#a78bfa", "#f472b6", "#fbbf24", "#34d399", "#f87171"];
    const at = iso(gx, gy + 0.6, 58);
    return (
        <g>
            <Box gx={gx} gy={gy} w={1.6} d={0.6} h={58} colors={{ top: "#4a3426", left: "#3b291e", right: "#2c1f17" }} />
            <PlaneGroup at={at} axis="x">
                {[0, 1, 2].map((shelf) => (
                    <g key={shelf} transform={`translate(4 ${6 + shelf * 17})`}>
                        <rect x={0} y={12} width={43} height={2} fill="#2c1f17" />
                        {Array.from({ length: 6 }, (_, i) => {
                            const h = 8 + ((seed + i * 7 + shelf * 3) % 5);
                            return <rect key={i} x={i * 7} y={12 - h} width={5.4} height={h} fill={books[(seed + i + shelf * 2) % books.length]} opacity={0.75} />;
                        })}
                    </g>
                ))}
            </PlaneGroup>
        </g>
    );
}

/** A monitor whose screen faces the viewer (plane along gx). */
export function Monitor({ gx, gy, z, width, status, lit }: { gx: number; gy: number; z: number; width: number; status: SceneStatus | null; lit: boolean }) {
    const w = width * 32;
    const h = 26;
    const top = iso(gx, gy, z + 8 + h);
    const screen = !lit ? "#0b1322" : status === "blocked" || status === "waiting" ? "url(#office-screen-amber)" : status === "offline" ? "#111827" : "url(#office-screen)";
    const stand = iso(gx + width / 2, gy, z);
    return (
        <g>
            <rect x={stand.x - 2} y={stand.y - 9} width={4} height={9} fill="#1e293b" />
            <ellipse cx={stand.x} cy={stand.y} rx={7} ry={3} fill="#1e293b" />
            <PlaneGroup at={top} axis="x">
                {lit && <rect x={-4} y={-4} width={w + 8} height={h + 8} rx={4} fill={status === "blocked" ? "#f59e0b" : "#22d3ee"} opacity={0.16} className="office-screen-glow" />}
                <rect x={0} y={0} width={w} height={h} rx={2.5} fill="#0f172a" stroke="#334155" strokeWidth={1} />
                <rect x={2} y={2} width={w - 4} height={h - 4} rx={1.5} fill={screen} className={lit ? "office-screen" : undefined} />
                {lit && status !== "offline" && (
                    <g opacity={0.8}>
                        <rect x={5} y={6} width={w * 0.45} height={2} rx={1} fill="#e0f2fe" opacity={0.85} />
                        <rect x={5} y={11} width={w * 0.62} height={2} rx={1} fill="#e0f2fe" opacity={0.5} />
                        <rect x={9} y={16} width={w * 0.35} height={2} rx={1} fill="#e0f2fe" opacity={0.5} />
                    </g>
                )}
            </PlaneGroup>
        </g>
    );
}

/** The desk itself plus the things on it, drawn in front of the seated character. */
export function DeskFront({ gx, gy, status, occupied, seed }: { gx: number; gy: number; status: SceneStatus | null; occupied: boolean; seed: number }) {
    const lit = occupied && status !== "offline";
    return (
        <g>
            <ellipse {...shadowAt(gx + 2, gy + 2.2)} />
            <Box gx={gx + 0.55} gy={gy + 1.55} w={2.9} d={1.2} h={24} colors={WOOD_BODY} />
            <Box gx={gx + 0.45} gy={gy + 1.48} z={24} w={3.1} d={1.34} h={4} colors={WOOD} />
            <Monitor gx={gx + 0.7} gy={gy + 1.7} z={28} width={0.95} status={status} lit={lit} />
            <Monitor gx={gx + 1.72} gy={gy + 1.7} z={28} width={0.62} status={status} lit={lit} />
            {/* laptop lid seen from behind, in front of the character */}
            <Box gx={gx + 2.2} gy={gy + 2.05} z={28} w={0.75} d={0.5} h={2} colors={{ top: "#cbd5e1", left: "#94a3b8", right: "#64748b" }} />
            {seed % 3 === 0 && <Mug gx={gx + 3.2} gy={gy + 2.5} hue={(seed * 47) % 360} />}
            {seed % 3 === 1 && <Box gx={gx + 0.85} gy={gy + 2.3} z={28} w={0.55} d={0.4} h={3} colors={{ top: "#f1f5f9", left: "#cbd5e1", right: "#94a3b8" }} />}
            {seed % 4 === 2 && <Plant gx={gx + 3.25} gy={gy + 1.75} scale={0.42} />}
        </g>
    );
}

function shadowAt(gx: number, gy: number) {
    const c = iso(gx, gy, 0);
    return { cx: c.x, cy: c.y + 4, rx: 86, ry: 30, fill: "#020617", opacity: 0.35 };
}

export function Mug({ gx, gy, z = 28, hue }: { gx: number; gy: number; z?: number; hue: number }) {
    const c = iso(gx, gy, z);
    return (
        <g>
            <rect x={c.x - 3.5} y={c.y - 8} width={7} height={8} rx={1.5} fill={`hsl(${hue} 60% 55%)`} />
            <ellipse cx={c.x} cy={c.y - 8} rx={3.5} ry={1.4} fill="#3b2416" />
        </g>
    );
}

export function Chair({ gx, gy, hue }: { gx: number; gy: number; hue: number }) {
    const seat = { top: `hsl(${hue} 30% 30%)`, left: `hsl(${hue} 30% 22%)`, right: `hsl(${hue} 30% 16%)` };
    return (
        <g>
            <Box gx={gx - 0.42} gy={gy - 0.62} z={10} w={0.84} d={0.2} h={40} colors={seat} />
            <Box gx={gx - 0.42} gy={gy - 0.42} z={10} w={0.84} d={0.8} h={6} colors={seat} />
        </g>
    );
}

/* ── Lounge ─────────────────────────────────────────────────────────── */

export function CoffeeCounter({ gx, gy }: { gx: number; gy: number }) {
    const machine = iso(gx + 1.1, gy + 0.9, 34);
    return (
        <g>
            <Box gx={gx} gy={gy} w={4.4} d={1.1} h={30} colors={{ top: "#334155", left: "#1e293b", right: "#172033" }} />
            <Box gx={gx - 0.05} gy={gy - 0.05} z={30} w={4.5} d={1.2} h={4} colors={{ top: "#a8744a", left: "#7a5034", right: "#5e3c26" }} />
            <Box gx={gx + 0.6} gy={gy + 0.2} z={34} w={0.9} d={0.7} h={30} colors={{ top: "#1f2937", left: "#111827", right: "#0b1020" }} />
            <circle cx={machine.x - 4} cy={machine.y - 20} r={2.2} fill="#f87171" className="office-antenna" />
            <rect x={machine.x - 8} y={machine.y - 12} width={8} height={3} fill="#38bdf8" opacity={0.7} />
            <g className="office-steam" opacity={0.6}>
                <path d={`M ${machine.x - 6} ${machine.y - 4} c -4 -6 4 -10 0 -16`} stroke="#e2e8f0" strokeWidth={1.6} fill="none" strokeLinecap="round" />
                <path d={`M ${machine.x - 1} ${machine.y - 4} c -4 -6 4 -10 0 -16`} stroke="#e2e8f0" strokeWidth={1.6} fill="none" strokeLinecap="round" />
            </g>
            <Mug gx={gx + 2.4} gy={gy + 0.8} z={34} hue={20} />
            <Mug gx={gx + 2.9} gy={gy + 0.7} z={34} hue={200} />
            <Box gx={gx + 3.4} gy={gy + 0.25} z={34} w={0.6} d={0.6} h={12} colors={{ top: "#e2e8f0", left: "#94a3b8", right: "#64748b" }} />
        </g>
    );
}

export function SofaBack({ gx, gy, d }: { gx: number; gy: number; d: number }) {
    const c = { top: "#4c5fd5", left: "#3443a8", right: "#27338a" };
    return (
        <g>
            <Box gx={gx - 0.5} gy={gy} w={0.45} d={d} h={36} colors={c} />
            <Box gx={gx} gy={gy} w={1.5} d={d} h={12} colors={{ top: "#5a6ee0", left: "#3a4bb6", right: "#2c3a94" }} />
            <Box gx={gx - 0.5} gy={gy - 0.35} w={2} d={0.35} h={22} colors={c} />
        </g>
    );
}

export function SofaArm({ gx, gy }: { gx: number; gy: number }) {
    return <Box gx={gx - 0.5} gy={gy} w={2} d={0.35} h={22} colors={{ top: "#4c5fd5", left: "#3443a8", right: "#27338a" }} />;
}

export function RoundTable({ gx, gy }: { gx: number; gy: number }) {
    const c = iso(gx, gy, 0);
    return (
        <g>
            <ellipse cx={c.x} cy={c.y + 2} rx={30} ry={13} fill="#020617" opacity={0.4} />
            <rect x={c.x - 3} y={c.y - 18} width={6} height={18} fill="#4b3424" />
            <ellipse cx={c.x} cy={c.y - 19} rx={30} ry={14} fill="#7a5034" />
            <ellipse cx={c.x} cy={c.y - 22} rx={30} ry={14} fill="#a8744a" />
            <ellipse cx={c.x - 8} cy={c.y - 25} rx={10} ry={4} fill="#ffffff" opacity={0.08} />
        </g>
    );
}

export function FloorLamp({ gx, gy }: { gx: number; gy: number }) {
    const c = iso(gx, gy, 0);
    return (
        <g>
            <ellipse cx={c.x} cy={c.y - 86} rx={46} ry={22} fill="#fbbf24" opacity={0.07} />
            <rect x={c.x - 1.5} y={c.y - 80} width={3} height={80} fill="#334155" />
            <path d={`M ${c.x - 12} ${c.y - 78} L ${c.x + 12} ${c.y - 78} L ${c.x + 8} ${c.y - 96} L ${c.x - 8} ${c.y - 96} Z`} fill="#fde68a" opacity={0.9} />
            <ellipse cx={c.x} cy={c.y - 2} rx={10} ry={4} fill="#1e293b" />
        </g>
    );
}
