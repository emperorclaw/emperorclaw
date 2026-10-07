import { avatarVariant, type AvatarVariant, type SceneStatus } from "@/lib/team-scene";
import { cn } from "@/lib/utils";

const SKIN = ["#f6d3b3", "#e8b48c", "#c98b5e", "#9a6440", "#6b4329"];
const HAIR = ["#2b1d16", "#5b3a24", "#c9853b", "#e7c16d", "#7a2f2f", "#334155"];

export const STATUS_COLOR: Record<SceneStatus, string> = {
    working: "#38bdf8",
    waiting: "#fbbf24",
    blocked: "#fbbf24",
    idle: "#34d399",
    offline: "#64748b",
};

const hsl = (h: number, s: number, l: number) => `hsl(${h} ${s}% ${l}%)`;

/**
 * A chibi character drawn in local coordinates: (0, 0) is the seat, the
 * figure rises to about y = -66. Robots and people share one silhouette so
 * the floor reads as one cast.
 */
export function CharacterFigure({ variant, status, idPrefix, seated = true }: { variant: AvatarVariant; status: SceneStatus; idPrefix: string; seated?: boolean }) {
    const { hue } = variant;
    const offline = status === "offline";
    const bodyLight = hsl(hue, offline ? 8 : 70, offline ? 46 : 58);
    const bodyDark = hsl(hue, offline ? 8 : 62, offline ? 30 : 38);
    const g = `${idPrefix}-g`;
    const legs = !seated && (
        <g>
            <rect x={-9} y={-8} width={7} height={10} rx={2} fill={hsl(hue, 25, 22)} />
            <rect x={2} y={-8} width={7} height={10} rx={2} fill={hsl(hue, 25, 22)} />
        </g>
    );

    return (
        <g className={cn(offline && "office-offline")}>
            <defs>
                <linearGradient id={g} x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor={bodyLight} />
                    <stop offset="1" stopColor={bodyDark} />
                </linearGradient>
            </defs>
            {/* soft contact shadow */}
            <ellipse cx={0} cy={seated ? 2 : 3} rx={17} ry={6} fill="#020617" opacity={0.45} />
            {legs}
            {variant.body === "robot" ? <Robot variant={variant} status={status} fill={`url(#${g})`} /> : <Person variant={variant} status={status} fill={`url(#${g})`} />}
        </g>
    );
}

function Robot({ variant, status, fill }: { variant: AvatarVariant; status: SceneStatus; fill: string }) {
    const { hue } = variant;
    const eye = status === "offline" ? "#475569" : status === "blocked" || status === "waiting" ? "#fde68a" : "#a5f3fc";
    return (
        <g className="office-body">
            {/* torso */}
            <rect x={-13} y={-31} width={26} height={27} rx={8} fill={fill} />
            <rect x={-13} y={-31} width={26} height={8} rx={4} fill="#ffffff" opacity={0.12} />
            <rect x={-6} y={-22} width={12} height={8} rx={2.5} fill="#0b1220" opacity={0.85} />
            <circle cx={0} cy={-18} r={2.2} fill={STATUS_COLOR[status]} className="office-chest" />
            {/* arms */}
            <rect x={-19} y={-27} width={7} height={16} rx={3.5} fill={hsl(hue, 45, 34)} />
            <rect x={12} y={-27} width={7} height={16} rx={3.5} fill={hsl(hue, 45, 34)} />
            {/* antenna */}
            <line x1={0} y1={-62} x2={0} y2={-70} stroke={hsl(hue, 30, 70)} strokeWidth={2} strokeLinecap="round" />
            <circle cx={0} cy={-72} r={3.2} fill={STATUS_COLOR[status]} className="office-antenna" />
            {/* head */}
            <rect x={-19} y={-63} width={6} height={12} rx={3} fill={hsl(hue, 40, 40)} />
            <rect x={13} y={-63} width={6} height={12} rx={3} fill={hsl(hue, 40, 40)} />
            <rect x={-15} y={-64} width={30} height={30} rx={10} fill={hsl(hue, 55, 66)} />
            <rect x={-15} y={-64} width={30} height={9} rx={6} fill="#ffffff" opacity={0.22} />
            <rect x={-11} y={-56} width={22} height={15} rx={6} fill="#0b1220" />
            <g className="office-eyes">
                <rect x={-7.5} y={-52} width={5} height={6} rx={2} fill={eye} />
                <rect x={2.5} y={-52} width={5} height={6} rx={2} fill={eye} />
            </g>
            {variant.accessory === "headset" && <path d="M -16 -50 Q -16 -68 0 -68 Q 16 -68 16 -50" fill="none" stroke="#0f172a" strokeWidth={3} />}
        </g>
    );
}

function Person({ variant, status, fill }: { variant: AvatarVariant; status: SceneStatus; fill: string }) {
    const skin = SKIN[variant.skin];
    const hair = HAIR[variant.hair];
    const offline = status === "offline";
    const longHair = variant.hair % 3 === 1;
    return (
        <g className="office-body">
            {/* torso */}
            <path d="M -14 -4 L -14 -22 Q -14 -32 -4 -32 L 4 -32 Q 14 -32 14 -22 L 14 -4 Z" fill={fill} />
            <path d="M -5 -32 L 0 -25 L 5 -32 Z" fill="#f8fafc" opacity={0.85} />
            <rect x={-19} y={-27} width={6} height={15} rx={3} fill={fill} />
            <rect x={13} y={-27} width={6} height={15} rx={3} fill={fill} />
            <circle cx={-16} cy={-11} r={3} fill={skin} />
            <circle cx={16} cy={-11} r={3} fill={skin} />
            {/* head */}
            {longHair && <rect x={-15} y={-60} width={30} height={30} rx={9} fill={hair} />}
            <rect x={-6} y={-36} width={12} height={6} fill={skin} />
            <rect x={-13} y={-62} width={26} height={28} rx={10} fill={skin} />
            <rect x={-13} y={-62} width={26} height={8} rx={6} fill="#ffffff" opacity={0.12} />
            {/* hair */}
            {variant.accessory === "cap" ? (
                <g>
                    <path d="M -14 -52 Q -14 -68 0 -68 Q 14 -68 14 -52 Z" fill={`hsl(${variant.hue} 70% 45%)`} />
                    <rect x={-2} y={-55} width={20} height={4} rx={2} fill={`hsl(${variant.hue} 70% 35%)`} />
                </g>
            ) : (
                <path d={variant.hair % 2 === 0 ? "M -14 -50 Q -15 -68 0 -67 Q 15 -68 14 -50 Q 10 -58 -2 -57 Q -10 -57 -14 -50 Z" : "M -14 -48 Q -16 -70 2 -67 Q 16 -66 14 -48 L 10 -56 Q 0 -54 -8 -58 Z"} fill={hair} />
            )}
            {/* face */}
            <g className="office-eyes">
                <rect x={-7} y={-48} width={3.4} height={4.4} rx={1.4} fill={offline ? "#64748b" : "#1e293b"} />
                <rect x={3.6} y={-48} width={3.4} height={4.4} rx={1.4} fill={offline ? "#64748b" : "#1e293b"} />
            </g>
            {variant.accessory === "glasses" && (
                <g fill="none" stroke="#0f172a" strokeWidth={1.4}>
                    <rect x={-9} y={-50} width={7.5} height={7} rx={2} />
                    <rect x={1.5} y={-50} width={7.5} height={7} rx={2} />
                    <line x1={-1.5} y1={-46.5} x2={1.5} y2={-46.5} />
                </g>
            )}
            <path d={status === "blocked" ? "M -3 -38 L 3 -38" : "M -3.5 -39.5 Q 0 -36.5 3.5 -39.5"} stroke="#9a3412" strokeWidth={1.4} fill="none" strokeLinecap="round" />
            <circle cx={-8.5} cy={-41} r={2} fill="#fb7185" opacity={0.35} />
            <circle cx={8.5} cy={-41} r={2} fill="#fb7185" opacity={0.35} />
            {variant.accessory === "headset" && (
                <g>
                    <path d="M -14 -46 Q -14 -66 0 -66 Q 14 -66 14 -46" fill="none" stroke="#0f172a" strokeWidth={3} />
                    <rect x={-17} y={-50} width={5} height={9} rx={2} fill="#0f172a" />
                </g>
            )}
        </g>
    );
}

/** Square avatar tile for cards and lists: the agent's own picture, or its office character. */
export function AgentAvatar({ id, kind, name, avatarUrl, status = "idle", size = 32, className }: {
    id: string;
    kind: "agent" | "human";
    name: string;
    avatarUrl?: string | null;
    status?: SceneStatus;
    size?: number;
    className?: string;
}) {
    if (avatarUrl) {
        return (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={avatarUrl} alt="" width={size} height={size} className={cn("shrink-0 rounded-[30%] bg-slate-900 object-cover ring-1 ring-white/10", className)} style={{ width: size, height: size }} />
        );
    }
    const variant = avatarVariant(id, kind);
    return (
        <svg viewBox="-27 -78 54 54" width={size} height={size} role="img" aria-label={name}
            className={cn("shrink-0 rounded-[30%] ring-1 ring-white/10", className)}
            style={{ background: `radial-gradient(circle at 50% 30%, hsl(${variant.hue} 60% 28%), #0b1220 75%)` }}>
            <g transform="translate(0 10)">
                <CharacterFigure variant={variant} status={status} idPrefix={`av-${id}`} />
            </g>
        </svg>
    );
}
