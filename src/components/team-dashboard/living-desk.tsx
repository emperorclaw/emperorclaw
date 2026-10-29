"use client";

import { forwardRef, useEffect, useRef, useState, type CSSProperties } from "react";
import { useTranslations } from "next-intl";
import { IconActivity, IconAlertTriangle, IconBellRinging, IconCoffee, IconConfetti, IconEye, IconMoon, IconPlugConnectedX } from "@tabler/icons-react";
import { agentMotion, expressionForActivity, type CompanyLeader, type SceneActivity, type SceneAgent } from "@/lib/team-scene";
import { resolveAppearance, resolveAvatarPhoto } from "@/lib/character/model";
import { bubbleText, deskStateLabel, leaderMemberKey, urgencyBucket, type DeskStatus, type UrgencyBucket } from "@/lib/live-office";
import { CharacterFigureView, moodForStatus } from "@/components/character/character-avatar";
import { ActivityCue } from "./character-activity";
import { useSceneCopy } from "./use-scene-copy";
import { cn } from "@/lib/utils";

const BUCKET_ICON: Record<UrgencyBucket, typeof IconActivity> = {
    needs_you: IconBellRinging,
    blocked: IconAlertTriangle,
    stale: IconPlugConnectedX,
    review: IconEye,
    working: IconActivity,
    idle: IconCoffee,
    offline: IconMoon,
};

/** Label tone per bucket; the text and icon carry the meaning, color only reinforces it. */
const BUCKET_TONE: Record<UrgencyBucket, string> = {
    needs_you: "text-amber-200",
    blocked: "text-rose-300",
    stale: "text-orange-200",
    review: "text-sky-200",
    working: "text-cyan-200",
    idle: "text-slate-300",
    offline: "text-slate-400",
};

const CONFETTI = Array.from({ length: 12 }, (_, i) => {
    const angle = (i / 12) * Math.PI * 2 + 0.3;
    const reach = 26 + (i % 3) * 9;
    return {
        dx: `${Math.round(Math.cos(angle) * reach)}px`,
        dy: `${Math.round(Math.sin(angle) * reach - 18)}px`,
        r: `${(i % 2 ? 1 : -1) * (120 + i * 25)}deg`,
        color: ["#fbbf24", "#67e8f9", "#f472b6", "#a3e635"][i % 4],
    };
});

export interface DeskProps {
    agent: SceneAgent;
    bucket: UrgencyBucket;
    label: string;
    status: DeskStatus;
    activity: SceneActivity;
    actions: number;
    ghost: boolean;
    selected: boolean;
    /** Lit from the Action inbox. */
    linked: boolean;
    /** Raised arms for a task_done moment. */
    celebrating: boolean;
    /** The confetti burst that opens a task_done moment. */
    burst: boolean;
    /** One-shot gold pulse for a needs_you moment. */
    pulse: boolean;
    still: boolean;
    thought: string | null;
    /** Bubble heading for a live step ("Running terminal"); null reads "Thinking". */
    thoughtLabel?: string | null;
    bubbleAlign: "start" | "center" | "end";
    ariaLabel: string;
    onSelect: (key: string) => void;
    onPoint: (key: string | null) => void;
}

/** One desk: the agent acting out its work, its name, a state label and the real task line. */
export const LivingDesk = forwardRef<HTMLLIElement, DeskProps>(function LivingDesk(props, ref) {
    const { agent, bucket, label, status, activity, actions, ghost, selected, linked, celebrating, burst, pulse, still, thought, thoughtLabel = null, bubbleAlign, ariaLabel, onSelect, onPoint } = props;
    const t = useTranslations("home.desk");
    const scene = useSceneCopy();
    const m = agent.member;
    const appearance = resolveAppearance({ id: m.id, avatarUrl: m.avatarUrl, avatarAppearance: m.avatarAppearance });
    const photo = resolveAvatarPhoto({ avatarUrl: m.avatarUrl });
    const motion = agentMotion(m.id);
    const hue = appearance.hue;
    const needsYou = bucket === "needs_you";
    const offline = bucket === "offline" || bucket === "stale";
    const armsUp = celebrating || activity === "celebrate";
    const working = (bucket === "working" || agent.status === "working") && !armsUp;
    const Icon = armsUp ? IconConfetti : BUCKET_ICON[bucket];
    const vars = {
        "--agent-hue": hue,
        "--blink-t": `${motion.blink.duration}ms`, "--blink-d": `${motion.blink.delay}ms`,
        "--bob-t": `${motion.bob.duration}ms`, "--bob-d": `${motion.bob.delay}ms`,
        "--cue-t": `${motion.cue.duration}ms`, "--cue-d": `${motion.cue.delay}ms`,
        "--typing-t": `${motion.typing.duration}ms`, "--typing-d": `${motion.typing.delay}ms`,
        "--screen-t": `${motion.screen.duration}ms`, "--screen-d": `${motion.screen.delay}ms`,
        "--celebrate-t": "2.4s", "--celebrate-d": "0s",
    } as CSSProperties;
    const statusId = `desk-status-${m.id}`;

    return <li ref={ref} className={cn("living-desk relative min-w-0", ghost && "living-ghost")} data-bucket={bucket} style={vars}>
        {(thought || thoughtLabel) && <ThoughtBubble key={`${thoughtLabel ?? ""}|${thought ?? ""}`} label={thoughtLabel ?? t("thinking")} text={thought ?? ""} still={still} align={bubbleAlign} />}
        <button type="button" onClick={() => onSelect(m.key)}
            onMouseEnter={() => onPoint(m.key)} onMouseLeave={() => onPoint(null)} onFocus={() => onPoint(m.key)} onBlur={() => onPoint(null)}
            aria-haspopup="dialog" aria-pressed={selected} aria-label={ariaLabel} aria-describedby={statusId}
            className={cn("group flex w-full min-w-0 flex-col items-center rounded-xl px-1.5 pb-2 pt-1 text-center transition-colors duration-200 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300",
                selected && "bg-cyan-400/[0.07] ring-1 ring-inset ring-cyan-300/40",
                linked && "bg-amber-300/[0.08] ring-2 ring-inset ring-amber-300/80")}>
            {/* 102 units in 84px: the seated figure (≈83 units above the desk) renders about 68px tall. */}
            <svg viewBox="-52 -96 104 102" className="h-[84px] w-[86px] shrink-0 overflow-visible" aria-hidden="true">
                {/* Floor ring: gold when this agent needs you. */}
                <ellipse cy="4" rx="46" ry="10" fill={needsYou ? "#fbbf24" : `hsl(${hue} 70% 55%)`} opacity={needsYou ? 0.2 : 0.07} />
                {needsYou && <ellipse cy="4" rx="50" ry="12" fill="none" stroke="#fcd34d" strokeWidth={linked ? 3 : 2} opacity={linked ? 1 : 0.75} className="living-gold" />}
                {pulse && !still && <ellipse cy="4" rx="50" ry="12" fill="none" stroke="#fde68a" strokeWidth="2.5" className="living-pulse" />}
                <g className={cn(!still && (working ? "observatory-working" : offline ? undefined : "living-breathe"))}>
                    <CharacterFigureView appearance={appearance} mood={moodForStatus(agent.status)} seated expression={armsUp ? "happy" : expressionForActivity(activity)} armsUp={armsUp} salt={`desk-${m.id}`} />
                    {photo && <image href={photo} x="-17" y="-76" width="34" height="34" preserveAspectRatio="xMidYMid slice" />}
                </g>
                {/* The desk sits in front of the agent. */}
                <path d="M-48 -14 L48 -14 L53 -5 L-53 -5 Z" fill="#17304a" />
                <rect x="-53" y="-5" width="106" height="10" rx="2.5" fill="#0b1a2c" stroke={`hsl(${hue} 60% 55%)`} strokeOpacity={offline ? 0.12 : 0.3} />
                {working && <rect x="-40" y="-14" width="80" height="1.6" rx="0.8" fill={`hsl(${hue} 80% 70%)`} opacity="0.55" className="observatory-terminal" />}
                <ActivityCue activity={activity} hue={hue} reducedMotion={still} variant={agent.behavior.variant} />
            </svg>
            {burst && !still && <span className="living-confetti pointer-events-none absolute left-1/2 top-9" aria-hidden="true">
                {CONFETTI.map((c, i) => <i key={i} style={{ "--dx": c.dx, "--dy": c.dy, "--r": c.r, background: c.color } as CSSProperties} />)}
            </span>}
            <span className="mt-0.5 flex w-full min-w-0 items-center justify-center gap-1.5">
                <span className="truncate text-[13px] font-semibold leading-5 text-slate-50">{m.name}</span>
                {actions > 0 && <span className="grid h-[18px] min-w-[18px] shrink-0 place-items-center rounded-md bg-amber-300 px-1 text-[11px] font-bold tabular-nums leading-none text-amber-950">{actions}</span>}
            </span>
            <span className={cn("flex max-w-full items-center gap-1 text-[11px] font-medium leading-4", armsUp ? "text-lime-200" : BUCKET_TONE[bucket])}>
                <Icon className="h-3 w-3 shrink-0" stroke={2} aria-hidden="true" /><span className="truncate">{scene.caption(label)}</span>
            </span>
            {/* The elapsed time never truncates; the title gives way. */}
            <span id={statusId} className="mt-0.5 flex w-full min-w-0 justify-center text-xs leading-4 text-slate-300" title={status.task ? status.text : scene.caption(status.text)}>
                <span className="truncate">{status.task ?? scene.caption(status.text)}</span>
                {status.task && status.elapsed && <span className="shrink-0 whitespace-pre tabular-nums text-slate-400">{` · ${status.elapsed}`}</span>}
            </span>
        </button>
    </li>;
});

/**
 * A speech bubble that types out a short, redacted thought (or a live step:
 * the heading names the step, the body its detail, if any). It lives inside
 * its own desk cell, over the agent's own figure: it never reaches another
 * desk's name or status line, overhangs only into the gutter (never past the
 * room edge), and fades out while it sits in the bottom band of the viewport
 * where the floating chat button is.
 */
function ThoughtBubble({ label, text, still, align }: { label: string; text: string; still: boolean; align: "start" | "center" | "end" }) {
    const snippet = text ? bubbleText(text) : "";
    const total = Array.from(snippet).length;
    const [shown, setShown] = useState(still ? total : 0);
    const [clear, setClear] = useState(true);
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (still) return;
        const timer = window.setInterval(() => setShown((n) => {
            if (n >= total) { window.clearInterval(timer); return n; }
            return n + 1;
        }), 32);
        return () => window.clearInterval(timer);
    }, [still, total]);
    useEffect(() => {
        const node = ref.current;
        if (!node || typeof IntersectionObserver === "undefined") return;
        // Visible only while fully above the bottom 96px (floating chat button zone).
        const observer = new IntersectionObserver(([entry]) => setClear(entry.intersectionRatio >= 0.99), { rootMargin: "0px 0px -96px 0px", threshold: [0, 0.99, 1] });
        observer.observe(node);
        return () => observer.disconnect();
    }, []);
    const visible = still ? snippet : Array.from(snippet).slice(0, shown).join("");
    return <div ref={ref} aria-hidden="true" className={cn("living-bubble pointer-events-none absolute top-0 z-20 max-h-[5.25rem] overflow-hidden rounded-xl border border-cyan-200/30 bg-[#0f2236] px-2 py-1 text-left text-[11px] leading-[1.3] text-cyan-50 shadow-[0_6px_18px_rgb(2_6_23/0.55)] transition-opacity duration-200",
        align === "start" ? "left-0 -right-1" : align === "end" ? "-left-1 right-0" : "-left-1 -right-1", !clear && "opacity-0")}>
        <span className="block truncate text-[10px] font-semibold leading-4 text-cyan-300/90">{label}</span>
        {snippet && <span className="line-clamp-3 break-words">{visible}<span className="invisible">{Array.from(snippet).slice(visible.length).join("")}</span></span>}
    </div>;
}

export interface ThroneProps {
    pending: number;
    onOpen: () => void;
    still: boolean;
    /** The company leader; null keeps the current empty throne. */
    leader?: CompanyLeader | null;
    /** The leader's scene agent when the leader is an agent (carries live state). */
    leaderAgent?: SceneAgent | null;
    /** Member keys with a pending decision, for the leader's urgency bucket. */
    actionKeys?: ReadonlySet<string>;
    /** Outside the selected team chat: dim like a desk. */
    ghost?: boolean;
    selected?: boolean;
    /** Opens the selected-agent side panel, like a desk does. */
    onSelectLeader?: (key: string) => void;
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * The Emperor's throne at the head of the room, gold while decisions wait. When
 * a company leader is set it sits on the throne: an agent acts out its real
 * state (and opens its briefing), a human sits as a silent silhouette. Only the
 * "decisions waiting" badge opens the Action inbox.
 */
export function Throne({ pending, onOpen, still, leader = null, leaderAgent = null, actionKeys = NO_KEYS, ghost = false, selected = false, onSelectLeader }: ThroneProps) {
    const t = useTranslations("home.desk");
    const scene = useSceneCopy();
    const waiting = pending > 0;
    const inboxLabel = waiting ? t("inboxWaiting", { count: pending }) : t("inboxClear");

    if (!leader) return <button type="button" onClick={onOpen} aria-label={inboxLabel}
        className="group relative mx-auto flex flex-col items-center rounded-2xl px-4 pb-1 pt-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
        <svg viewBox="-90 -78 180 92" className="h-[70px] w-[137px] overflow-visible" aria-hidden="true">
            <defs>
                <radialGradient id="throne-aura" cx="0.5" cy="0.55" r="0.5"><stop stopColor="#fbbf24" stopOpacity="0.55" /><stop offset="0.6" stopColor="#f59e0b" stopOpacity="0.16" /><stop offset="1" stopColor="#f59e0b" stopOpacity="0" /></radialGradient>
                <linearGradient id="throne-back" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#1d4363" /><stop offset="1" stopColor="#0b1c2f" /></linearGradient>
            </defs>
            {waiting && <ellipse cx="0" cy="-26" rx="86" ry="52" fill="url(#throne-aura)" className={still ? undefined : "living-aura"} />}
            {/* Dais */}
            <path d="M-78 6 L78 6 L70 -2 L-70 -2 Z" fill="#132a42" stroke="#67e8f9" strokeOpacity="0.25" />
            <path d="M-60 -2 L60 -2 L54 -9 L-54 -9 Z" fill="#183450" stroke="#67e8f9" strokeOpacity="0.3" />
            {/* Chair back and seat */}
            <path d="M-26 -12 L-26 -52 Q-26 -70 0 -74 Q26 -70 26 -52 L26 -12 Z" fill="url(#throne-back)" stroke={waiting ? "#fcd34d" : "#67e8f9"} strokeOpacity={waiting ? 0.9 : 0.5} strokeWidth="1.5" />
            <path d="M-17 -18 L-17 -50 Q-17 -62 0 -65 Q17 -62 17 -50 L17 -18" fill="none" stroke={waiting ? "#fde68a" : "#a5f3fc"} strokeOpacity="0.35" />
            <rect x="-34" y="-17" width="68" height="9" rx="3" fill="#1f4a6e" stroke="#67e8f9" strokeOpacity="0.35" />
            <rect x="-38" y="-30" width="9" height="20" rx="3" fill="#163552" />
            <rect x="29" y="-30" width="9" height="20" rx="3" fill="#163552" />
            <image href="/crown.png" x="-19" y="-62" width="38" height="29" preserveAspectRatio="xMidYMid meet" />
        </svg>
        {waiting
            ? <span className="mt-0.5 inline-flex items-center gap-1.5 rounded-full bg-amber-300 px-2.5 py-0.5 text-xs font-semibold text-amber-950"><IconBellRinging className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />{t("decisionsWaiting", { count: pending })}</span>
            : <span className="mt-0.5 inline-flex items-center rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-semibold text-slate-300">{t("allClear")}</span>}
    </button>;

    const leaderKey = leaderMemberKey(leader);
    const bucket: UrgencyBucket = leaderAgent ? urgencyBucket(leaderAgent, actionKeys) : "idle";
    const label = leaderAgent ? scene.caption(deskStateLabel(leaderAgent, bucket)) : leader.kind === "human" ? t("companyLeader") : t("offline");
    const aria = leaderAgent ? t("leaderAria", { name: leader.name, label }) : t("leaderAriaShort", { name: leader.name });
    const m = leaderAgent?.member ?? null;
    const appearance = leader.kind === "human"
        ? resolveAppearance({ id: leader.id, kind: "human" })
        : m ? resolveAppearance({ id: m.id, avatarUrl: m.avatarUrl, avatarAppearance: m.avatarAppearance }) : null;
    const photo = m ? resolveAvatarPhoto({ avatarUrl: m.avatarUrl }) : null;
    const motion = leaderAgent ? agentMotion(leaderAgent.member.id) : null;
    const offline = bucket === "offline" || bucket === "stale";
    const armsUp = leaderAgent?.behavior.kind === "celebrate";
    const working = Boolean(leaderAgent) && bucket === "working" && !armsUp;
    const activity: SceneActivity = leaderAgent?.behavior.kind ?? "available";
    const Icon = armsUp ? IconConfetti : BUCKET_ICON[bucket];
    const vars = motion ? {
        "--agent-hue": appearance?.hue ?? 200,
        "--blink-t": `${motion.blink.duration}ms`, "--blink-d": `${motion.blink.delay}ms`,
        "--bob-t": `${motion.bob.duration}ms`, "--bob-d": `${motion.bob.delay}ms`,
        "--cue-t": `${motion.cue.duration}ms`, "--cue-d": `${motion.cue.delay}ms`,
        "--typing-t": `${motion.typing.duration}ms`, "--typing-d": `${motion.typing.delay}ms`,
        "--screen-t": `${motion.screen.duration}ms`, "--screen-d": `${motion.screen.delay}ms`,
        "--celebrate-t": "2.4s", "--celebrate-d": "0s",
    } as CSSProperties : undefined;

    return <div className="group relative mx-auto flex flex-col items-center rounded-2xl px-4 pb-1 pt-1">
        <div className="relative" style={vars}>
            {/* Taller canvas so the seated occupant and its crown fit above the chair. */}
            <svg viewBox="-90 -150 180 164" className="h-[125px] w-[137px] overflow-visible" aria-hidden={leaderAgent ? true : undefined} role={leaderAgent ? undefined : "img"} aria-label={leaderAgent ? undefined : aria}>
                <defs>
                    <radialGradient id="throne-aura" cx="0.5" cy="0.55" r="0.5"><stop stopColor="#fbbf24" stopOpacity="0.55" /><stop offset="0.6" stopColor="#f59e0b" stopOpacity="0.16" /><stop offset="1" stopColor="#f59e0b" stopOpacity="0" /></radialGradient>
                    <linearGradient id="throne-back" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#1d4363" /><stop offset="1" stopColor="#0b1c2f" /></linearGradient>
                </defs>
                {waiting && <ellipse cx="0" cy="-26" rx="86" ry="52" fill="url(#throne-aura)" className={still ? undefined : "living-aura"} />}
                {/* Dais */}
                <path d="M-78 6 L78 6 L70 -2 L-70 -2 Z" fill="#132a42" stroke="#67e8f9" strokeOpacity="0.25" />
                <path d="M-60 -2 L60 -2 L54 -9 L-54 -9 Z" fill="#183450" stroke="#67e8f9" strokeOpacity="0.3" />
                {/* Chair back */}
                <path d="M-26 -12 L-26 -52 Q-26 -70 0 -74 Q26 -70 26 -52 L26 -12 Z" fill="url(#throne-back)" stroke={waiting ? "#fcd34d" : "#67e8f9"} strokeOpacity={waiting ? 0.9 : 0.5} strokeWidth="1.5" />
                <path d="M-17 -18 L-17 -50 Q-17 -62 0 -65 Q17 -62 17 -50 L17 -18" fill="none" stroke={waiting ? "#fde68a" : "#a5f3fc"} strokeOpacity="0.35" />
                {/* Occupant: seated, slightly larger than a desk, in front of the back and behind the cushion. */}
                {appearance && <g transform="translate(0 -15) scale(1.15)" className={cn(ghost && "living-ghost")}>
                    <g className={cn(!still && leaderAgent && (working ? "observatory-working" : offline ? undefined : "living-breathe"))}>
                        <CharacterFigureView appearance={appearance} mood={leaderAgent ? moodForStatus(leaderAgent.status) : "online"} seated
                            expression={armsUp ? "happy" : leaderAgent ? expressionForActivity(activity) : "neutral"} armsUp={armsUp} salt={`throne-${leader.id}`} />
                        {photo && <image href={photo} x="-17" y="-76" width="34" height="34" preserveAspectRatio="xMidYMid slice" />}
                    </g>
                </g>}
                {/* A small crown above the leader's head: it leads the company. */}
                {leaderAgent && <image href="/crown.png" x="-13" y="-118" width="26" height="19" preserveAspectRatio="xMidYMid meet" />}
                {/* Seat cushion overlays the lower body. */}
                <rect x="-34" y="-17" width="68" height="9" rx="3" fill="#1f4a6e" stroke="#67e8f9" strokeOpacity="0.35" />
                <rect x="-38" y="-30" width="9" height="20" rx="3" fill="#163552" />
                <rect x="29" y="-30" width="9" height="20" rx="3" fill="#163552" />
            </svg>
            {leaderAgent && leaderKey && <button type="button" onClick={() => onSelectLeader?.(leaderKey)}
                aria-haspopup="dialog" aria-pressed={selected} aria-label={aria}
                className="absolute left-1/2 top-[6px] h-[104px] w-[92px] -translate-x-1/2 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300" />}
        </div>
        <div className={cn("mt-0.5 flex max-w-[11rem] flex-col items-center text-center", ghost && "living-ghost")}>
            <span className="w-full truncate text-[13px] font-semibold leading-5 text-slate-50">{leader.name}</span>
            <span className={cn("flex max-w-full items-center gap-1 text-[11px] font-medium leading-4", !leaderAgent ? "text-slate-400" : armsUp ? "text-lime-200" : BUCKET_TONE[bucket])}>
                {leaderAgent && <Icon className="h-3 w-3 shrink-0" stroke={2} aria-hidden="true" />}<span className="truncate">{label}</span>
            </span>
        </div>
        <button type="button" onClick={onOpen} aria-label={inboxLabel}
            className="mt-1 rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
            {waiting
                ? <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-300 px-2.5 py-0.5 text-xs font-semibold text-amber-950"><IconBellRinging className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />{t("decisionsWaiting", { count: pending })}</span>
                : <span className="inline-flex items-center rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs font-semibold text-slate-300">{t("allClear")}</span>}
        </button>
    </div>;
}
