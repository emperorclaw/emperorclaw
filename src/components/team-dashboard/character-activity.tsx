import type { CSSProperties } from "react";
import type { SceneActivity } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

/**
 * A small prop that makes a character's activity readable at a glance. Drawn in
 * the character's local space (origin at the seat, head around y = -60) and
 * animated purely with CSS transform/opacity. Per-agent desync comes from the
 * CSS custom properties (--typing-t, --screen-t, --cue-t, …) set on the parent
 * figure group — never from JS per frame. `variant` is a deterministic
 * personality pick so the same activity reads differently across agents.
 */
export function ActivityCue({ activity, hue, lite = false, reducedMotion = false, variant = 0 }: {
    activity: SceneActivity;
    hue: number;
    lite?: boolean;
    reducedMotion?: boolean;
    variant?: number;
}) {
    const accent = `hsl(${hue} 70% 62%)`;
    const cue = reducedMotion ? undefined : "office-key";
    const stagger = (i: number, step = 0.12): CSSProperties | undefined =>
        reducedMotion ? undefined : { animationDelay: `calc(var(--typing-d, 0s) + ${(i * step).toFixed(2)}s)` };

    switch (activity) {
        case "typing":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    {/* keyboard: leaning in (v0) sits lower/forward, relaxed (v1) higher */}
                    <g transform={variant === 0 ? "translate(0 2)" : "translate(0 -2)"}>
                        <rect x={-9} y={-13} width={18} height={5} rx={1.6} fill="#1e293b" stroke="#334155" strokeWidth={0.8} />
                        {[-6.5, -2.5, 1.5, 5.5].map((x, i) => (
                            <rect key={x} x={x} y={-11.6} width={2.6} height={2.2} rx={0.6} fill={i % 2 ? accent : "#64748b"} className={cue} style={stagger(i, 0.15)} />
                        ))}
                    </g>
                    <g transform="translate(20 -62)">
                        <rect x={0} y={0} width={26} height={20} rx={3} fill="#0b1220" stroke="#1e3a5f" strokeWidth={1} />
                        {[0, 1, 2, 3].map((i) => (
                            <rect key={i} x={3} y={3.5 + i * 4} width={i % 2 ? 15 : 20} height={1.8} rx={0.9} fill={i === 0 ? accent : "#38bdf8"} opacity={0.85}
                                className={reducedMotion ? undefined : "office-code"} />
                        ))}
                    </g>
                </g>
            );
        case "writing":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(20 -62)">
                        <rect x={0} y={0} width={22} height={24} rx={2.5} fill="#f8fafc" stroke="#cbd5e1" />
                        {[0, 1, 2, 3].map((i) => (
                            <rect key={i} x={3} y={4 + i * 4.6} width={variant === 1 ? 14 - (i % 2) * 5 : 16 - (i % 2) * 4} height={1.8} rx={0.9} fill={i === 0 ? accent : "#94a3b8"}
                                className={reducedMotion ? undefined : "office-line"} style={{ transformOrigin: "3px 0" }} />
                        ))}
                    </g>
                </g>
            );
        case "reviewing":
            return variant === 1 ? (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(18 -62)">
                        <rect x={0} y={0} width={20} height={24} rx={3} fill="#0b1220" stroke="#334155" strokeWidth={1} />
                        {[0, 1, 2].map((i) => (
                            <rect key={i} x={3} y={4 + i * 5} width={13} height={1.8} rx={0.9} fill="#94a3b8" className={reducedMotion ? undefined : "office-code"} />
                        ))}
                    </g>
                    {[0, 1].map((i) => (
                        <g key={i} transform={`translate(${30 + i * 4} ${-70 - i * 5})`} className={reducedMotion ? undefined : "office-check"}>
                            <circle r={3.4} fill="#34d399" />
                            <path d="M -1.7 0 L -0.4 1.5 L 1.9 -1.3" stroke="#052e1a" strokeWidth={1.2} fill="none" strokeLinecap="round" />
                        </g>
                    ))}
                </g>
            ) : (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(20 -60)">
                        <rect x={0} y={0} width={20} height={22} rx={2.5} fill="#f1f5f9" stroke="#cbd5e1" />
                        {[0, 1, 2].map((i) => <rect key={i} x={3} y={4 + i * 5} width={13} height={1.8} rx={0.9} fill="#94a3b8" />)}
                        <g className={reducedMotion ? undefined : "office-code"} style={{ transformOrigin: "center" }}>
                            <circle cx={15} cy={15} r={6} fill="none" stroke={accent} strokeWidth={1.8} />
                            <line x1={19} y1={19} x2={24} y2={24} stroke={accent} strokeWidth={2} strokeLinecap="round" />
                        </g>
                    </g>
                    {[0, 1].map((i) => (
                        <g key={i} transform={`translate(${30 + i * 4} ${-70 - i * 5})`} className={reducedMotion ? undefined : "office-check"}>
                            <circle r={3.4} fill="#34d399" />
                            <path d="M -1.7 0 L -0.4 1.5 L 1.9 -1.3" stroke="#052e1a" strokeWidth={1.2} fill="none" strokeLinecap="round" />
                        </g>
                    ))}
                </g>
            );
        case "presenting":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(26 -74)">
                        <rect x={0} y={0} width={34} height={26} rx={2.5} fill="#f8fafc" stroke="#e2e8f0" />
                        {[0, 1, 2].map((i) => (
                            <rect key={i} x={5 + i * 10} y={18 - (6 + i * 4)} width={6} height={6 + i * 4} rx={1} fill={i === 2 ? accent : "#60a5fa"}
                                className={reducedMotion ? undefined : "office-bar"} style={{ transformOrigin: "bottom" }} />
                        ))}
                        <line x1={0} y1={26} x2={34} y2={26} stroke="#cbd5e1" strokeWidth={1.4} />
                    </g>
                </g>
            );
        case "talking":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(10 -84)">
                        <rect x={0} y={0} width={26} height={13} rx={6} fill="#0b1220" stroke={accent} strokeWidth={1.2} />
                        <path d="M 6 13 L 8 17 L 11 13 Z" fill="#0b1220" stroke={accent} strokeWidth={1.2} />
                        {[0, 1, 2].map((i) => <circle key={i} cx={7 + i * 6} cy={6.5} r={1.8} fill={accent} className={reducedMotion ? undefined : "office-dots"} style={{ animationDelay: `calc(var(--cue-d, 0s) + ${i * 0.25}s)` }} />)}
                    </g>
                </g>
            );
        case "thinking":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform={variant === 1 ? "translate(18 -86)" : "translate(18 -70)"}>
                        <circle cx={-2} cy={0} r={4} fill="#0b1220" stroke={accent} strokeWidth={1.1} />
                        <circle cx={3} cy={-6} r={5.5} fill="#0b1220" stroke={accent} strokeWidth={1.1} />
                        {[0, 1, 2].map((i) => <circle key={i} cx={1 + i * 3.4} cy={-6} r={1.4} fill={accent} className={reducedMotion ? undefined : "office-dots"} style={{ animationDelay: `calc(var(--cue-d, 0s) + ${i * 0.45}s)` }} />)}
                    </g>
                </g>
            );
        case "waiting":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(13 -86)">
                        <circle r={7} fill="#fbbf24" />
                        <rect x={-1.3} y={-4.4} width={2.6} height={5.4} rx={1.3} fill="#451a03" />
                        <circle cx={0} cy={3} r={1.5} fill="#451a03" />
                    </g>
                    <g transform="translate(-22 -52)">
                        <rect x={0} y={-4} width={7} height={5} rx={2.5} fill={accent} />
                        <rect x={0} y={-6} width={2} height={9} rx={1} fill={accent} opacity={0.8} />
                    </g>
                </g>
            );
        case "blocked":
            return (
                <g className={cn("office-cue office-blocked", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(15 -88)">
                        <circle r={6.4} fill="#fbbf24" />
                        <rect x={-1.2} y={-4} width={2.4} height={5} rx={1.2} fill="#7c2d12" />
                        <circle cx={0} cy={2.6} r={1.4} fill="#7c2d12" />
                    </g>
                    <path d="M -3 -74 q 4 3 0 7" stroke="#7dd3fc" strokeWidth={1.4} fill="none" strokeLinecap="round" className={reducedMotion ? undefined : "office-sweat"} />
                </g>
            );
        case "celebrate": {
            const bits: Array<{ x: number; y: number; color: string }> = [
                { x: 6, y: -14, color: accent },
                { x: -7, y: -16, color: "#fbbf24" },
                { x: 0, y: -20, color: "#34d399" },
            ];
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    {bits.map((b, i) => (
                        <g key={i} transform={`translate(${b.x} ${b.y})`} className={reducedMotion ? undefined : "office-confetti"}
                            style={{ "--cx": `${(i - 1) * 5}px`, "--cy": `${-12 - i * 3}px`, "--cr": `${(i - 1) * 50}deg` } as CSSProperties}>
                            <rect x={-2} y={-2} width={4} height={4} rx={1} fill={b.color} />
                        </g>
                    ))}
                </g>
            );
        }
        case "coffee":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <g transform="translate(13 -18)">
                        <rect x={0} y={0} width={9} height={9} rx={2} fill={accent} />
                        <ellipse cx={9} cy={4.5} rx={2.6} ry={3} fill="none" stroke={accent} strokeWidth={1.4} />
                        <g className={reducedMotion ? undefined : "office-steam"}>
                            <path d="M 2 -1 q -2 -4 0 -7 M 5.5 -1 q -2 -4 0 -7" stroke="#e2e8f0" strokeWidth={1.1} fill="none" strokeLinecap="round" />
                        </g>
                    </g>
                </g>
            );
        case "nap":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <text x={12} y={-74} fill="#94a3b8" fontSize={11} style={{ fontFamily: "var(--font-silkscreen), monospace" }} className={reducedMotion ? undefined : "office-zzz"}>z</text>
                </g>
            );
        case "stretch":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <path d="M 12 -82 l 2 -5 M 8 -82 l 2 -5" stroke={accent} strokeWidth={1.4} strokeLinecap="round" opacity={0.8} />
                </g>
            );
        case "offline":
            return (
                <g className={cn("office-cue", lite && "office-cue-lite")} aria-hidden>
                    <text x={16} y={-72} fill="#94a3b8" fontSize={11} style={{ fontFamily: "var(--font-silkscreen), monospace" }} className={reducedMotion ? undefined : "office-zzz"}>z z</text>
                </g>
            );
        default:
            return null;
    }
}
