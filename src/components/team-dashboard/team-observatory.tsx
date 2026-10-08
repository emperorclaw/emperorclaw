"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { IconArrowsMaximize, IconMessageCircle, IconUsersGroup, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { agentMotion, requiresHumanAction, type DashboardTeam, type SceneAgent, type SceneCommunication, type CollaborationEvent } from "@/lib/team-scene";
import { observatoryBays, visibleCommunications, sceneMessagePreview } from "@/lib/observatory";
import { resolveAppearance, resolveAvatarPhoto } from "@/lib/character/model";
import { CharacterFigureView, moodForStatus } from "@/components/character/character-avatar";
import { ActivityCue } from "./character-activity";
import { cn } from "@/lib/utils";

function subscribeCompact(update: () => void) {
    const q = window.matchMedia("(max-width: 767px)");
    q.addEventListener("change", update);
    return () => q.removeEventListener("change", update);
}

/** A living company, rather than a single global task or a workflow diagram. */
export function TeamObservatory({ companyName, agents, teams, communications, events, selectedKey, onSelect, now, reducedMotion, fresh }: {
    companyName: string;
    agents: SceneAgent[];
    teams: DashboardTeam[];
    communications: SceneCommunication[];
    events: CollaborationEvent[];
    selectedKey: string | null;
    onSelect: (key: string) => void;
    now: Date;
    reducedMotion: boolean;
    fresh: boolean;
}) {
    const uid = useId().replace(/:/g, "");
    const compact = useSyncExternalStore(subscribeCompact, () => window.matchMedia("(max-width: 767px)").matches, () => false);
    const [group, setGroup] = useState("all");
    const [page, setPage] = useState(0);
    const [zoom, setZoom] = useState(1);
    const [frameWidth, setFrameWidth] = useState(980);
    const [awake, setAwake] = useState(true);
    const stageRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const sizeObserver = new ResizeObserver(([entry]) => setFrameWidth(Math.max(1, entry.contentRect.width)));
        if (stageRef.current) sizeObserver.observe(stageRef.current);
        let inView = true;
        const update = () => setAwake(inView && !document.hidden);
        const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); }, { threshold: 0.05 });
        if (stageRef.current) observer.observe(stageRef.current);
        document.addEventListener("visibilitychange", update);
        update();
        return () => { observer.disconnect(); sizeObserver.disconnect(); document.removeEventListener("visibilitychange", update); };
    }, []);
    const team = teams.find((t) => t.id === group);
    const bays = observatoryBays(agents, teams, team?.id ?? null);
    const baysPerPage = compact ? 1 : 2;
    const pages = Math.max(1, Math.ceil(bays.length / baysPerPage));
    const current = Math.min(page, pages - 1);
    const visibleBays = bays.slice(current * baysPerPage, (current + 1) * baysPerPage);
    const displayedBays = Math.max(1, visibleBays.length);
    const crew = visibleBays.flatMap((b) => b.agents);
    const total = bays.reduce((n, b) => n + b.agents.length, 0);
    const start = bays.slice(0, current * baysPerPage).reduce((n, b) => n + b.agents.length, 0);
    const width = compact ? 720 : 1280;
    const rows = Math.max(2, ...visibleBays.map((b) => Math.ceil(b.agents.length / 2)));
    const rowGap = Math.max(290, Math.ceil(150 * width / frameWidth));
    const height = 440 + (rows - 1) * rowGap;
    const slots = visibleBays.flatMap((bay, bayIndex) => bay.agents.map((a, i) => ({ key: a.member.key, x: (bayIndex + (i % 2 + 0.5) / 2) * width / displayedBays, y: 280 + Math.floor(i / 2) * rowGap })));
    const positions = new Map(slots.map((s) => [s.key, s]));
    const position = (i: number) => slots[i];
    const recent = visibleCommunications(communications, new Set(positions.keys()), now, fresh, team?.id ?? null);
    const message = recent[0];
    const handoffs = fresh ? events.filter((e) => { const age = now.getTime() - Date.parse(e.at); return age >= 0 && age < 30_000 && positions.has(e.fromKey) && positions.has(e.toKey) && e.fromKey !== e.toKey; }).slice(0, 3) : [];
    const connections = [
        ...recent.filter((m) => m.targetKey && positions.has(m.targetKey)).map((m) => ({ id: m.id, from: m.actorKey, to: m.targetKey!, kind: "message" })),
        ...handoffs.map((e) => ({ id: e.id, from: e.fromKey, to: e.toKey, kind: e.kind })),
    ];
    const animate = awake && !reducedMotion && fresh;
    const focusIndex = crew.findIndex((a) => a.member.key === selectedKey);
    const origin = focusIndex < 0 ? { x: width / 2, y: height / 2 } : position(focusIndex);

    return <div className={cn("observatory", !animate && "observatory-paused")}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><IconUsersGroup className="h-4 w-4 shrink-0" />Team chat
                <select aria-label="Scene team" value={team?.id ?? "all"} onChange={(e) => { setGroup(e.target.value); setPage(0); setZoom(1); }} className="min-h-11 max-w-52 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus-visible:ring-2 focus-visible:ring-cyan-400"><option value="all">Whole company</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </label>
            <span className="text-xs text-muted-foreground">{total} agents{team ? ` · ${team.name}` : " · independent work, shared space"}</span>
        </div>
        <div ref={stageRef} data-frame-width={frameWidth} className="observatory-stage relative isolate overflow-hidden rounded-2xl border border-cyan-400/20" style={{ aspectRatio: `${width} / ${height}` }}>
            <div className="observatory-stars pointer-events-none absolute inset-0" aria-hidden="true" />
            <div className="absolute inset-0" style={{ transform: `scale(${zoom})`, transformOrigin: `${origin.x / width * 100}% ${origin.y / height * 100}%`, transition: reducedMotion ? "none" : "transform 240ms ease-out" }}>
                <svg viewBox={`0 0 ${width} ${height}`} className="absolute inset-0 h-full w-full" aria-hidden="true">
                    <defs>
                        <linearGradient id={`${uid}-floor`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#162c43" stopOpacity="0.85" /><stop offset="1" stopColor="#060d19" /></linearGradient>
                        <linearGradient id={`${uid}-glass`} x1="0" y1="0" x2="1" y2="1"><stop stopColor="#67e8f9" stopOpacity="0.2" /><stop offset="1" stopColor="#22d3ee" stopOpacity="0.025" /></linearGradient>
                        <linearGradient id={`${uid}-rim`}><stop stopColor="#22d3ee" stopOpacity="0.05" /><stop offset="0.5" stopColor="#a5f3fc" stopOpacity="0.65" /><stop offset="1" stopColor="#22d3ee" stopOpacity="0.05" /></linearGradient>
                    </defs>
                    {/* A terraced observatory: no global task, throne or controller in the middle. */}
                    <path d={`M30 125 Q${width / 2} 15 ${width - 30} 125 L${width - 12} ${height - 80} Q${width / 2} ${height + 30} 12 ${height - 80} Z`} fill={`url(#${uid}-floor)`} stroke="#38bdf8" strokeOpacity="0.22" />
                    <path d={`M30 125 Q${width / 2} 15 ${width - 30} 125`} fill="none" stroke={`url(#${uid}-rim)`} strokeWidth="4" />
                    <path d={`M35 ${height - 68} Q${width / 2} ${height + 10} ${width - 35} ${height - 68}`} fill="none" stroke={`url(#${uid}-rim)`} strokeWidth="3" />
                    {Array.from({ length: 12 }, (_, i) => <path key={`rail-${i}`} d={`M${width / 2} 80 L${(i - 1) * width / 9} ${height}`} stroke="#67e8f9" strokeOpacity="0.045" fill="none" />)}
                    {Array.from({ length: rows + 2 }, (_, i) => <path key={`cross-${i}`} d={`M20 ${140 + i * 155} Q${width / 2} ${100 + i * 155} ${width - 20} ${140 + i * 155}`} stroke="#67e8f9" strokeOpacity="0.055" fill="none" />)}
                    <text x={width / 2} y="62" textAnchor="middle" fill="#a5f3fc" fontSize="18" letterSpacing={companyName.length > 28 ? "1" : "3"} opacity="0.85"><title>{companyName}</title>{Array.from(companyName).length > 48 ? `${Array.from(companyName).slice(0, 47).join("")}…` : companyName}</text>
                    {visibleBays.map((bay, i) => <g key={bay.id}>
                        <rect x={i * width / displayedBays + 28} y="115" width={width / displayedBays - 56} height={height - 205} rx="35" fill={i % 2 ? "#a78bfa" : "#22d3ee"} fillOpacity="0.025" stroke={i % 2 ? "#a78bfa" : "#22d3ee"} strokeOpacity="0.12" />
                        <text x={(i + 0.5) * width / displayedBays} y="145" textAnchor="middle" fill="#94c9da" fontSize="15" letterSpacing="2">{bay.name.length > 28 ? `${bay.name.slice(0, 27)}…` : bay.name}</text>
                    </g>)}
                    {connections.map((c) => {
                        const a = positions.get(c.from)!; const b = positions.get(c.to)!;
                        const route = `M${a.x + 40} ${a.y - 85} Q${(a.x + b.x) / 2 + 130} ${(a.y + b.y) / 2 - 155} ${b.x + 40} ${b.y - 85}`;
                        return <g key={c.id}><path d={route} fill="none" stroke={c.kind === "review" ? "#fbbf24" : "#67e8f9"} strokeWidth="1.5" opacity="0.2" /><path className="observatory-transfer" d={route} fill="none" stroke={c.kind === "review" ? "#fbbf24" : "#67e8f9"} strokeWidth="3" /><circle cx={b.x + 40} cy={b.y - 85} r="4" fill={c.kind === "review" ? "#fbbf24" : "#67e8f9"} /></g>;
                    })}
                    {crew.map((agent, i) => {
                        const p = position(i); const m = agent.member;
                        const appearance = resolveAppearance({ id: m.id, avatarUrl: m.avatarUrl, avatarAppearance: m.avatarAppearance });
                        const hue = appearance.hue;
                        const selected = selectedKey === m.key;
                        const motion = agentMotion(m.id);
                        const talking = recent.some((e) => e.actorKey === m.key || e.targetKey === m.key);
                        const live = Boolean(m.activity) && fresh;
                        const vars = { "--agent-hue": hue, "--blink-t": `${motion.blink.duration}ms`, "--blink-d": `${motion.blink.delay}ms`, "--cue-t": `${motion.cue.duration}ms`, "--cue-d": `${motion.cue.delay}ms`, "--typing-t": `${motion.typing.duration}ms`, "--typing-d": `${motion.typing.delay}ms`, "--screen-t": `${motion.screen.duration}ms`, "--screen-d": `${motion.screen.delay}ms` } as CSSProperties;
                        const color = `hsl(${hue} 75% 65%)`;
                        return <g key={m.key} transform={`translate(${p.x} ${p.y})`} style={vars}>
                            {/* Floating work platforms and a compact side console; keep the avatar unobstructed. */}
                            <ellipse cy="20" rx="109" ry="33" fill="#020617" opacity="0.5" />
                            <path d="M-104 -4 L-62 -30 L62 -30 L104 -4 L104 9 L62 38 L-62 38 L-104 9 Z" fill="#0a1728" stroke={selected ? color : "#23445e"} strokeWidth={selected ? 2 : 1} />
                            <path d="M-104 -4 L-62 -30 L62 -30 L104 -4 L62 25 L-62 25 Z" fill={`url(#${uid}-glass)`} stroke={color} strokeOpacity="0.4" />
                            <path className={live ? "observatory-power" : undefined} d="M-95 13 L-60 34 L60 34 L95 13" fill="none" stroke={color} strokeWidth="2" opacity={selected ? 0.8 : live ? 0.6 : 0.25} />
                            <ellipse cy="-4" rx="41" ry="13" fill={color} opacity="0.06" />
                            <ellipse cy="-4" rx="41" ry="13" fill="none" stroke={color} opacity="0.3" strokeDasharray="18 8" />
                            <g transform="translate(0 -9) scale(1.38)">
                                <g className={cn("observatory-character", live && "observatory-working", talking && "observatory-talking")}>
                                    <CharacterFigureView appearance={appearance} mood={moodForStatus(agent.status)} seated={false} expression={live ? "focused" : "neutral"} salt={`${uid}-${m.id}`} />
                                    {resolveAvatarPhoto({ avatarUrl: m.avatarUrl }) && <image href={resolveAvatarPhoto({ avatarUrl: m.avatarUrl })!} x="-17" y="-76" width="34" height="34" preserveAspectRatio="xMidYMid slice" />}
                                    <ActivityCue activity={talking ? "talking" : agent.behavior.kind} hue={hue} reducedMotion={!animate} lite={crew.length > 8} variant={agent.behavior.variant} />
                                </g>
                            </g>
                            <g transform="translate(54 -67) skewY(-12)">
                                <path d="M0 0 L44 0 L44 33 L0 33 Z" fill="#061522" fillOpacity="0.7" stroke={color} strokeOpacity="0.5" />
                                <path d="M5 8 H33 M5 15 H25 M5 22 H36" stroke={color} strokeWidth="2" opacity={live ? 0.85 : 0.25} className={live ? "observatory-terminal" : undefined} />
                                <path d="M0 35 L-8 55 L37 55 L44 35" fill={`url(#${uid}-glass)`} stroke={color} strokeOpacity="0.25" />
                            </g>
                            {selected && <ellipse cy="-5" rx="115" ry="43" fill="none" stroke={color} strokeOpacity="0.4" strokeDasharray="3 9" />}
                        </g>;
                    })}
                </svg>
                {crew.map((agent, i) => {
                    const p = position(i); const m = agent.member;
                    const actions = agent.notices?.filter(requiresHumanAction).length ?? 0;
                    return <button key={m.key} type="button" onClick={() => onSelect(m.key)} aria-haspopup="dialog" aria-pressed={selectedKey === m.key} aria-label={`${m.name}: ${agent.behavior.caption}${actions ? `, ${actions} pending actions` : ""}`} title={`${m.name} · ${agent.behavior.caption}`}
                        style={{ left: `${p.x / width * 100}%`, top: `${(p.y - 75) / height * 100}%`, width: `${280 / width * 100}%`, height: `${180 / height * 100}%` }}
                        className="absolute flex -translate-x-1/2 flex-col justify-end rounded-xl px-1 pb-1 text-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                        <span className="flex items-center justify-center gap-1.5 text-xs font-semibold text-slate-100 sm:text-sm">{m.name}{actions > 0 && <span className="rounded bg-amber-400/20 px-1 text-[10px] text-amber-200">{actions}</span>}</span>
                        <span className="mt-0.5 truncate text-[10px] text-slate-400 sm:text-xs">{agent.behavior.caption}</span>
                    </button>;
                })}
                {message && (() => { const p = positions.get(message.actorKey)!; return <Link key={message.id} href={message.href} aria-label={`Open conversation from ${crew.find((a) => a.member.key === message.actorKey)?.member.name}`}
                    style={{ left: `${Math.max(compact ? 35 : 18, Math.min(compact ? 65 : 82, p.x / width * 100))}%`, top: `${Math.max(2, (p.y - 185) / height * 100)}%` }}
                    className="observatory-bubble absolute z-20 flex min-h-11 w-44 -translate-x-1/2 items-start gap-2 rounded-xl border border-cyan-300/35 bg-[#11263b]/95 px-3 py-2 text-xs text-cyan-50 shadow-lg shadow-black/30 sm:w-52"><IconMessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-300" /><span className="line-clamp-2">{sceneMessagePreview(message.text)}</span></Link>; })()}
            </div>
            {crew.length === 0 && <div className="absolute inset-0 grid place-items-center p-6 text-center text-sm text-slate-300">No agents match this view. Clear the filters to see your team.</div>}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{crew.length ? `${start + 1}–${start + crew.length} of ${total} agents` : "0 agents"} · select an agent to inspect</span>
            <div role="group" aria-label="Scene camera" className="flex gap-1">
                {[["Zoom in", IconZoomIn, () => setZoom((z) => Math.min(2, z + 0.25))], ["Zoom out", IconZoomOut, () => setZoom((z) => Math.max(1, z - 0.25))], ["Fit team", IconArrowsMaximize, () => setZoom(1)]] .map(([label, Icon, action]) => { const Glyph = Icon as typeof IconZoomIn; return <button key={String(label)} type="button" aria-label={String(label)} onClick={action as () => void} className="grid h-11 w-11 place-items-center rounded-lg border border-white/10 bg-[#081220]/90 text-slate-300 hover:text-white focus-visible:ring-2 focus-visible:ring-cyan-300"><Glyph className="h-4 w-4" /></button>; })}
            </div>
            {pages > 1 && <div className="flex gap-2"><button type="button" aria-label="Previous agents" disabled={current === 0} onClick={() => { setPage(current - 1); setZoom(1); }} className="min-h-11 rounded-lg border border-border px-3 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cyan-400">Previous</button><button type="button" aria-label="Next agents" disabled={current === pages - 1} onClick={() => { setPage(current + 1); setZoom(1); }} className="min-h-11 rounded-lg border border-border px-3 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-cyan-400">Next</button></div>}
        </div>
        {(message || team) && <div className="mt-3 flex items-start gap-2 rounded-xl border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground"><IconMessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-600 dark:text-cyan-300" /><div className="min-w-0 flex-1">{message ? <><span className="font-semibold text-foreground">{crew.find((a) => a.member.key === message.actorKey)?.member.name}</span>{message.teamId && <span> in {teams.find((t) => t.id === message.teamId)?.name ?? "team chat"}</span>}{message.targetKey && <span> → {agents.find((a) => a.member.key === message.targetKey)?.member.name}</span>}<p className="mt-1 line-clamp-2">{sceneMessagePreview(message.text)}</p><Link href={message.href} className="mt-1 inline-flex min-h-11 items-center font-medium text-cyan-700 dark:text-cyan-300">Open conversation →</Link></> : <><span className="font-medium text-foreground">Conversation channel</span><p className="mt-1">New team messages appear here and above the speaking agent. Paths show recorded handoffs and direct conversations.</p></>}</div>{team && <Link href={`/messages?group=${team.id}`} className="inline-flex min-h-11 shrink-0 items-center text-cyan-700 dark:text-cyan-300">Team chat →</Link>}</div>}
    </div>;
}
