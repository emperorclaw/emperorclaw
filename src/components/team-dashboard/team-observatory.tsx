"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { IconBubbleText, IconLayoutList, IconMessageCircle, IconUsersGroup } from "@tabler/icons-react";
import { assignIdleRoutines, requiresHumanAction, type CompanyLeader, type DashboardTeam, type SceneActivity, type SceneAgent, type SceneCommunication, type SceneLiveEvent, type SceneThought } from "@/lib/team-scene";
import { visibleCommunications, sceneMessagePreview } from "@/lib/observatory";
import {
    bubbleCandidates, deskColumns, deskStateLabel, deskStatusLine, eventsToPlay, ghostKeys, leaderMemberKey, orderDesks, plural, rotateSpeakers, urgencyBucket, visibleDesks, MAX_DESKS,
} from "@/lib/live-office";
import { LivingDesk, Throne } from "./living-desk";
import { useLiveLink } from "./live-link";
import { cn } from "@/lib/utils";

const THOUGHTS_KEY = "emperor.scene.showThoughts";
const PLANE_MS = 1700;
const CONFETTI_MS = 1400;
const CELEBRATE_MS = 6000;
const PULSE_MS = 3600;
const MAX_PLANES = 3;

/* "Show thoughts" lives in localStorage; storage can be unavailable (private mode). */
const thoughtListeners = new Set<() => void>();
let memoryShowThoughts: boolean | null = null;
function readShowThoughts(): boolean {
    try { return window.localStorage.getItem(THOUGHTS_KEY) !== "off"; } catch { return true; }
}
function writeShowThoughts(on: boolean) {
    try { window.localStorage.setItem(THOUGHTS_KEY, on ? "on" : "off"); } catch { /* keep the in-memory choice */ }
    memoryShowThoughts = on;
    thoughtListeners.forEach((fn) => fn());
}
function subscribeThoughts(fn: () => void) {
    thoughtListeners.add(fn);
    return () => { thoughtListeners.delete(fn); };
}

type Plane = { id: string; path: string };
type Moment = { id: string; key: string; kind: "celebrate" | "confetti" | "pulse"; until: number };

/**
 * The living office: one room, the Emperor's throne at the head, every agent
 * at a desk ordered by who needs a person first. Desks act out real work,
 * show the real task and its age, and play recent moments once.
 */
export function TeamObservatory({ agents, teams, communications, thoughts, liveEvents, pendingActions, actionKeys, selectedKey, leader, leaderAgent, onSelect, onOpenInbox, onShowAll, now, reducedMotion, fresh }: {
    agents: SceneAgent[];
    teams: DashboardTeam[];
    communications: SceneCommunication[];
    thoughts: SceneThought[];
    liveEvents: SceneLiveEvent[];
    /** The company leader, resolved from the organization chart (or null). */
    leader: CompanyLeader | null;
    /** The leader's scene agent when the leader is an agent, for live state. */
    leaderAgent: SceneAgent | null;
    /** Same count as the Action inbox. */
    pendingActions: number;
    /** Member keys with at least one Action inbox item. */
    actionKeys: ReadonlySet<string>;
    selectedKey: string | null;
    onSelect: (key: string) => void;
    onOpenInbox: () => void;
    onShowAll: () => void;
    now: Date;
    reducedMotion: boolean;
    fresh: boolean;
}) {
    const link = useLiveLink();
    const [group, setGroup] = useState("all");
    const [frameWidth, setFrameWidth] = useState(0);
    const [awake, setAwake] = useState(true);
    const floorRef = useRef<HTMLOListElement>(null);
    const showThoughts = useSyncExternalStore(subscribeThoughts, () => memoryShowThoughts ?? readShowThoughts(), () => true);

    // Pause everything while the room is off-screen or the tab is hidden.
    useEffect(() => {
        const node = floorRef.current;
        if (!node) return;
        const sizeObserver = new ResizeObserver(([entry]) => setFrameWidth(Math.max(1, entry.contentRect.width)));
        sizeObserver.observe(node);
        let inView = true;
        const update = () => setAwake(inView && !document.hidden);
        const observer = new IntersectionObserver(([entry]) => { inView = entry.isIntersecting; update(); }, { threshold: 0.05 });
        observer.observe(node);
        document.addEventListener("visibilitychange", update);
        update();
        return () => { observer.disconnect(); sizeObserver.disconnect(); document.removeEventListener("visibilitychange", update); };
    }, []);

    const team = teams.find((t) => t.id === group) ?? null;
    const still = reducedMotion || !fresh;
    const ghosts = useMemo(() => ghostKeys(agents, team), [agents, team]);
    // The leader sits on the throne, not on the floor; ghost it when the
    // selected team chat does not include it.
    const leaderKey = leaderMemberKey(leader);
    const leaderGhost = Boolean(leaderKey && team && !team.memberKeys.includes(leaderKey));
    const ordered = useMemo(() => orderDesks(agents, actionKeys, leader), [agents, actionKeys, leader]);
    const { shown, hidden } = useMemo(() => visibleDesks(ordered, ghosts, MAX_DESKS), [ordered, ghosts]);
    const columns = frameWidth ? deskColumns(frameWidth) : 6;
    const floorKeys = useMemo(() => new Set(shown.map((a) => a.member.key)), [shown]);
    const idleRoutines = useMemo(() => assignIdleRoutines(shown.filter((a) => a.behavior.kind === "available").map((a) => a.member.key)), [shown]);
    const talking = useMemo(() => new Set(visibleCommunications(communications, floorKeys, now, fresh, team?.id ?? null).flatMap((m) => [m.actorKey, m.targetKey ?? ""])), [communications, floorKeys, now, fresh, team]);
    const message = useMemo(() => visibleCommunications(communications, new Set(agents.map((a) => a.member.key)), now, fresh, team?.id ?? null)[0] ?? null, [communications, agents, now, fresh, team]);

    // ── Desk elements, for FLIP reordering and event paths (own refs, no DOM queries).
    const deskEls = useRef(new Map<string, HTMLLIElement>());
    const lastPos = useRef(new Map<string, { x: number; y: number }>());
    const deskRef = useCallback((key: string) => (el: HTMLLIElement | null) => {
        if (el) deskEls.current.set(key, el); else deskEls.current.delete(key);
    }, []);
    const orderSignature = shown.map((a) => a.member.key).join("|") + `#${columns}`;
    useLayoutEffect(() => {
        const next = new Map<string, { x: number; y: number }>();
        deskEls.current.forEach((el, key) => next.set(key, { x: el.offsetLeft, y: el.offsetTop }));
        if (!still && awake) {
            next.forEach((pos, key) => {
                const prev = lastPos.current.get(key);
                const el = deskEls.current.get(key);
                if (!prev || !el || (prev.x === pos.x && prev.y === pos.y)) return;
                el.animate([{ transform: `translate(${prev.x - pos.x}px, ${prev.y - pos.y}px)` }, { transform: "translate(0, 0)" }], { duration: 420, easing: "cubic-bezier(0.16, 1, 0.3, 1)" });
            });
        }
        lastPos.current = next;
    }, [orderSignature, still, awake]);

    // ── Moments: each event plays once (by id), only if it is recent on arrival.
    const seen = useRef(new Set<string>());
    const timers = useRef(new Set<number>());
    const [planes, setPlanes] = useState<Plane[]>([]);
    const [moments, setMoments] = useState<Moment[]>([]);
    useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
    const later = useCallback((fn: () => void, ms: number) => {
        const t = window.setTimeout(() => { timers.current.delete(t); fn(); }, ms);
        timers.current.add(t);
    }, []);
    useEffect(() => {
        const nowMs = Date.now();
        const play = awake && fresh ? eventsToPlay(liveEvents, seen.current, floorKeys, nowMs) : [];
        liveEvents.forEach((e) => seen.current.add(e.id));
        if (!play.length) return;
        const nextPlanes: Plane[] = [];
        const nextMoments: Moment[] = [];
        for (const e of play) {
            if (e.type === "handoff" && !still && e.targetKey && nextPlanes.length < MAX_PLANES) {
                const a = deskEls.current.get(e.actorKey); const b = deskEls.current.get(e.targetKey);
                if (!a || !b) continue;
                const x1 = a.offsetLeft + a.offsetWidth / 2, y1 = a.offsetTop + 30;
                const x2 = b.offsetLeft + b.offsetWidth / 2, y2 = b.offsetTop + 30;
                const lift = 50 + Math.hypot(x2 - x1, y2 - y1) * 0.18;
                nextPlanes.push({ id: e.id, path: `M ${x1} ${y1} Q ${(x1 + x2) / 2} ${Math.min(y1, y2) - lift} ${x2} ${y2}` });
            } else if (e.type === "task_done") {
                nextMoments.push({ id: `${e.id}:c`, key: e.actorKey, kind: "celebrate", until: nowMs + CELEBRATE_MS });
                if (!still) nextMoments.push({ id: `${e.id}:f`, key: e.actorKey, kind: "confetti", until: nowMs + CONFETTI_MS });
            } else if (e.type === "needs_you" && !still) {
                nextMoments.push({ id: `${e.id}:p`, key: e.actorKey, kind: "pulse", until: nowMs + PULSE_MS });
            }
        }
        if (nextPlanes.length) {
            setPlanes((current) => [...current, ...nextPlanes]);
            later(() => setPlanes((current) => current.filter((p) => !nextPlanes.includes(p))), PLANE_MS + 100);
        }
        if (nextMoments.length) {
            setMoments((current) => [...current, ...nextMoments]);
            for (const m of nextMoments) later(() => setMoments((current) => current.filter((x) => x !== m)), m.until - nowMs);
        }
    }, [liveEvents, floorKeys, awake, fresh, still, later]);
    const momentKeys = (kind: Moment["kind"]) => new Set(moments.filter((m) => m.kind === kind).map((m) => m.key));
    const celebrating = momentKeys("celebrate");
    const confetti = momentKeys("confetti");
    const pulsing = momentKeys("pulse");

    // ── Thought bubbles: one or two at a time, rotating among working agents.
    const [tick, setTick] = useState(0);
    const speakingPool = useMemo(() => {
        if (!showThoughts || !fresh) return [];
        const working = new Set(shown.filter((a) => urgencyBucket(a, actionKeys) === "working" && !ghosts.has(a.member.key)).map((a) => a.member.key));
        return bubbleCandidates(thoughts, working, now.getTime());
    }, [showThoughts, fresh, shown, actionKeys, ghosts, thoughts, now]);
    useEffect(() => {
        if (speakingPool.length <= 2 || !awake) return;
        const timer = window.setInterval(() => setTick((n) => n + 1), still ? 15_000 : 9_000);
        return () => window.clearInterval(timer);
    }, [speakingPool.length, awake, still]);
    const speaking = new Map(rotateSpeakers(speakingPool, tick).map((t) => [t.memberKey, t.text]));

    const teamCount = team ? agents.length - ghosts.size : agents.length;
    const pointDesk = (key: string | null, hasActions: boolean) => {
        if (key === null) link.set(null, "desk");
        else if (hasActions) link.set(key, "desk");
    };

    return <div className={cn("observatory office-scene living-office", !awake && "office-paused", still && "living-still")}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
            <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"><IconUsersGroup className="h-4 w-4 shrink-0" aria-hidden="true" />Team chat
                <select aria-label="Scene team" value={team?.id ?? "all"} onChange={(e) => setGroup(e.target.value)} className="min-h-11 max-w-52 rounded-lg border border-border bg-card px-3 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"><option value="all">Whole company</option>{teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            </label>
            <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{team ? `${plural(teamCount, "agent")} in ${team.name} · others dimmed` : `${plural(agents.length, "agent")} · most urgent nearest the throne`}</span>
                <button type="button" aria-pressed={showThoughts} onClick={() => writeShowThoughts(!showThoughts)}
                    className={cn("inline-flex min-h-11 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-400",
                        showThoughts ? "border-cyan-500/40 bg-cyan-500/10 text-cyan-700 dark:text-cyan-200" : "border-border text-muted-foreground hover:text-foreground")}>
                    <IconBubbleText className="h-4 w-4" aria-hidden="true" />Show thoughts
                </button>
            </div>
        </div>
        <div className="observatory-stage relative isolate overflow-hidden rounded-2xl border border-cyan-400/20 px-2 pb-16 pt-2 sm:px-4 sm:pb-4">
            <div className="observatory-stars pointer-events-none absolute inset-0" aria-hidden="true" />
            <div className="living-floor-glow pointer-events-none absolute inset-x-0 bottom-0 top-24" aria-hidden="true" />
            <div className="relative flex justify-center"><Throne pending={pendingActions} onOpen={onOpenInbox} still={still} leader={leader} leaderAgent={leaderAgent} actionKeys={actionKeys} ghost={leaderGhost} selected={Boolean(leaderKey && selectedKey === leaderKey)} onSelectLeader={onSelect} /></div>
            <ol ref={floorRef} aria-label="Agents, most urgent first" className="mt-2 grid gap-x-2 gap-y-2" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                {shown.map((agent, index) => {
                    const m = agent.member;
                    const bucket = urgencyBucket(agent, actionKeys);
                    const actions = agent.notices?.filter(requiresHumanAction).length ?? 0;
                    const ghost = ghosts.has(m.key);
                    const routine = agent.behavior.kind === "available" ? idleRoutines.get(m.key) : undefined;
                    const activity: SceneActivity = talking.has(m.key) && (bucket === "working" || bucket === "idle") ? "talking" : routine ?? agent.behavior.kind;
                    const column = index % columns;
                    return <LivingDesk key={m.key} ref={deskRef(m.key)} agent={agent} bucket={bucket} label={deskStateLabel(agent, bucket)} status={deskStatusLine(agent, now)} activity={activity}
                        actions={actions} ghost={ghost} selected={selectedKey === m.key} linked={link.from === "inbox" && link.key === m.key}
                        celebrating={celebrating.has(m.key)} burst={confetti.has(m.key)} pulse={pulsing.has(m.key)} still={still}
                        thought={ghost ? null : speaking.get(m.key) ?? null} bubbleAlign={column === 0 ? "start" : column === columns - 1 ? "end" : "center"}
                        ariaLabel={`${m.name}: ${agent.behavior.caption}${actions ? `, ${plural(actions, "pending action")}` : ""}${ghost ? ", outside this team chat" : ""}`}
                        onSelect={onSelect} onPoint={(key) => pointDesk(key, actions > 0)} />;
                })}
                {hidden > 0 && <li className="flex min-h-[140px] items-center justify-center">
                    <button type="button" onClick={onShowAll} className="flex h-full w-full flex-col items-center justify-center gap-1 rounded-xl border border-dashed border-cyan-300/30 px-2 text-center text-slate-200 hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300">
                        <IconLayoutList className="h-5 w-5 text-cyan-300" aria-hidden="true" />
                        <span className="text-[13px] font-semibold">+{hidden} more</span>
                        <span className="text-xs text-slate-400">Open the list</span>
                    </button>
                </li>}
            </ol>
            {planes.length > 0 && <div className="pointer-events-none absolute inset-0" aria-hidden="true">
                <svg className="absolute inset-0 h-full w-full overflow-visible">{planes.map((p) => <path key={p.id} d={p.path} className="living-trail" fill="none" stroke="#a5f3fc" strokeWidth="1.5" strokeDasharray="4 7" />)}</svg>
                {planes.map((p) => <span key={p.id} className="living-plane" style={{ offsetPath: `path("${p.path}")` } as CSSProperties}>
                    <svg viewBox="-12 -9 24 18" className="h-5 w-6"><path d="M-11 -1 L11 -8 L4 8 L1 2 Z" fill="#ecfeff" /><path d="M1 2 L11 -8 L-3 3 Z" fill="#67e8f9" /></svg>
                </span>)}
            </div>}
            {shown.length === 0 && <p className="py-10 text-center text-sm text-slate-300">No agents match this view. Clear the filters to see your team.</p>}
        </div>
        {(message || team) && <div className="mt-3 flex items-start gap-2 rounded-xl border border-border bg-muted/20 px-3 py-3 text-xs text-muted-foreground"><IconMessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-cyan-600 dark:text-cyan-300" aria-hidden="true" /><div className="min-w-0 flex-1">{message ? <><span className="font-semibold text-foreground">{agents.find((a) => a.member.key === message.actorKey)?.member.name}</span>{message.teamId && <span> in {teams.find((t) => t.id === message.teamId)?.name ?? "team chat"}</span>}{message.targetKey && <span> → {agents.find((a) => a.member.key === message.targetKey)?.member.name}</span>}<p className="mt-1 line-clamp-2">{sceneMessagePreview(message.text)}</p><Link href={message.href} className="mt-1 inline-flex min-h-11 items-center font-medium text-cyan-700 dark:text-cyan-300">Open conversation →</Link></> : <><span className="font-medium text-foreground">Conversation channel</span><p className="mt-1">New team messages appear here. Agents who just spoke show a speech cue at their desk.</p></>}</div>{team && <Link href={`/messages?group=${team.id}`} className="inline-flex min-h-11 shrink-0 items-center text-cyan-700 dark:text-cyan-300">Team chat →</Link>}</div>}
    </div>;
}
