import type { DashboardTeam, SceneAgent, SceneLiveEvent, SceneThought } from "@/lib/team-scene";

/**
 * Pure helpers for the dashboard's living office (the Scene view): urgency
 * ordering, the per-desk status line, team-chat ghosting, desk overflow,
 * thought rotation and one-shot event playback. Client-safe: no DB, no Node.
 */

/** One room, no paging, up to this many desks. More opens the List view. */
export const MAX_DESKS = 24;
/** Thoughts older than this never show (mirrors the server window). */
export const THOUGHT_FRESH_MS = 10 * 60 * 1000;
/** Events older than this on arrival are not played. */
export const EVENT_PLAY_WINDOW_MS = 2 * 60 * 1000;
/** At most this many thought bubbles at once. */
export const MAX_BUBBLES = 2;
export const BUBBLE_CHARS = 80;
const TITLE_MAX = 64;

export type UrgencyBucket = "needs_you" | "blocked" | "stale" | "review" | "working" | "idle" | "offline";

/** Most urgent first: who needs a person sits nearest the throne. */
export const URGENCY_ORDER: readonly UrgencyBucket[] = ["needs_you", "blocked", "stale", "review", "working", "idle", "offline"];

export const BUCKET_LABEL: Record<UrgencyBucket, string> = {
    needs_you: "Needs you",
    blocked: "Blocked",
    stale: "Connection stale",
    review: "In review",
    working: "Working",
    idle: "Idle",
    offline: "Offline",
};

/** Which bucket a desk belongs to. `needsYou` holds member keys with a pending Action inbox item. */
export function urgencyBucket(agent: SceneAgent, needsYou: ReadonlySet<string>): UrgencyBucket {
    if (needsYou.has(agent.member.key)) return "needs_you";
    switch (agent.status) {
        case "blocked": return "blocked";
        case "offline": return "stale";
        case "waiting": return "review";
        case "working": return "working";
        default: return agent.member.runtimeOnline === false ? "offline" : "idle";
    }
}

/**
 * Urgency order with a stable order inside each bucket (name, then key), so
 * desks only move when an agent's situation actually changes.
 */
export function orderByUrgency(agents: SceneAgent[], needsYou: ReadonlySet<string>): SceneAgent[] {
    const rank = new Map(URGENCY_ORDER.map((b, i) => [b, i]));
    return agents
        .map((agent) => ({ agent, rank: rank.get(urgencyBucket(agent, needsYou)) ?? URGENCY_ORDER.length }))
        .sort((a, b) => a.rank - b.rank || a.agent.member.name.localeCompare(b.agent.member.name) || a.agent.member.key.localeCompare(b.agent.member.key))
        .map((entry) => entry.agent);
}

/** Desks outside the selected team chat stay in place as ghosts. No team → no ghosts. */
export function ghostKeys(agents: SceneAgent[], team: Pick<DashboardTeam, "memberKeys"> | null | undefined): Set<string> {
    if (!team) return new Set();
    const members = new Set(team.memberKeys);
    return new Set(agents.filter((a) => !members.has(a.member.key)).map((a) => a.member.key));
}

/**
 * The desks the room shows, in urgency order, capped at `cap`. When the room
 * overflows, the selected team's agents win seats over ghosts; the rest are
 * counted for the "+N more" tile.
 */
export function visibleDesks(ordered: SceneAgent[], ghosts: ReadonlySet<string>, cap = MAX_DESKS): { shown: SceneAgent[]; hidden: number } {
    if (ordered.length <= cap) return { shown: ordered, hidden: 0 };
    const keep = new Set([...ordered.filter((a) => !ghosts.has(a.member.key)), ...ordered.filter((a) => ghosts.has(a.member.key))].slice(0, cap).map((a) => a.member.key));
    return { shown: ordered.filter((a) => keep.has(a.member.key)), hidden: ordered.length - keep.size };
}

/** "<1m", "12m", "3h 5m", "2d". */
export function formatElapsed(ms: number): string {
    if (!Number.isFinite(ms) || ms < 60_000) return "<1m";
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
}

function clip(text: string, max: number): string {
    const chars = Array.from(text.replace(/\s+/g, " ").trim());
    return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export interface DeskStatus {
    /** The full line, e.g. "Answering 47 emails · 12m". */
    text: string;
    /** The real task title when there is one. */
    task: string | null;
    elapsed: string | null;
}

/**
 * One status line per desk: the real current task and how long it has run.
 * Working agents show their in-progress task (elapsed since it started),
 * agents in review their review task (elapsed since it went to review).
 * Without a task, the human-readable status.
 */
export function deskStatusLine(agent: SceneAgent, now: Date): DeskStatus {
    const m = agent.member;
    const task = agent.status === "waiting" ? m.waiting[0] ?? m.working[0] : m.working[0] ?? (agent.status === "blocked" ? m.waiting[0] : undefined);
    if (task) {
        // A review task has waited since it moved to review; work runs from its start.
        const since = m.waiting.includes(task) ? task.updatedAt : task.startedAt ?? null;
        const start = since ? Date.parse(since) : NaN;
        const elapsed = Number.isFinite(start) ? formatElapsed(now.getTime() - start) : null;
        const title = clip(task.title, TITLE_MAX);
        return { text: elapsed ? `${title} · ${elapsed}` : title, task: title, elapsed };
    }
    return { text: clip(agent.activity || agent.behavior.caption, TITLE_MAX), task: null, elapsed: null };
}

/** The small text label that carries the state (never color alone). */
export function deskStateLabel(agent: SceneAgent, bucket: UrgencyBucket): string {
    if (bucket === "working") return agent.behavior.kind === "celebrate" ? "Just finished" : agent.behavior.caption === "Task in progress" ? "Working" : agent.behavior.caption;
    if (bucket === "idle" && agent.behavior.kind === "celebrate") return "Just finished";
    return BUCKET_LABEL[bucket];
}

/** "1 pending action", "3 pending actions". */
export function plural(count: number, one: string, many = `${one}s`): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** Thoughts that may show: fresh, from agents currently working on a visible, non-ghost desk. */
export function bubbleCandidates(thoughts: SceneThought[], workingKeys: ReadonlySet<string>, nowMs: number): SceneThought[] {
    return thoughts
        .filter((t) => workingKeys.has(t.memberKey) && nowMs - Date.parse(t.at) <= THOUGHT_FRESH_MS && nowMs - Date.parse(t.at) >= -60_000)
        .sort((a, b) => b.at.localeCompare(a.at) || a.memberKey.localeCompare(b.memberKey));
}

/** Which candidates speak in rotation slot `tick`: at most `max`, cycling through all. */
export function rotateSpeakers<T>(candidates: T[], tick: number, max = MAX_BUBBLES): T[] {
    if (candidates.length <= max) return candidates;
    const start = ((tick * max) % candidates.length + candidates.length) % candidates.length;
    return Array.from({ length: max }, (_, i) => candidates[(start + i) % candidates.length]);
}

/** A bubble-sized snippet: ≤`max` characters, cut at a word when possible. */
export function bubbleText(text: string, max = BUBBLE_CHARS): string {
    const chars = Array.from(text.replace(/\s+/g, " ").trim());
    if (chars.length <= max) return chars.join("");
    const cut = chars.slice(0, max - 1).join("");
    const space = cut.lastIndexOf(" ");
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}…`;
}

/**
 * New events to play once: not seen before, about agents on the floor, and
 * recent (≤2 minutes) — so a first load does not replay the last 10 minutes.
 */
export function eventsToPlay(events: SceneLiveEvent[], seen: ReadonlySet<string>, onFloor: ReadonlySet<string>, nowMs: number, windowMs = EVENT_PLAY_WINDOW_MS): SceneLiveEvent[] {
    return events.filter((e) => {
        if (seen.has(e.id) || !onFloor.has(e.actorKey)) return false;
        if (e.type === "handoff" && (!e.targetKey || !onFloor.has(e.targetKey) || e.targetKey === e.actorKey)) return false;
        const age = nowMs - Date.parse(e.at);
        return Number.isFinite(age) && age <= windowMs && age >= -60_000;
    }).sort((a, b) => a.at.localeCompare(b.at));
}

/** "Updated 12s ago", "Updated 3m ago". */
export function updatedAgo(generatedAt: string, nowMs: number): string {
    const sec = Math.max(0, Math.floor((nowMs - Date.parse(generatedAt)) / 1000));
    if (!Number.isFinite(sec)) return "Updated recently";
    if (sec < 60) return `Updated ${sec}s ago`;
    if (sec < 3600) return `Updated ${Math.floor(sec / 60)}m ago`;
    return `Updated ${Math.floor(sec / 3600)}h ago`;
}

/**
 * Desk columns for a room width: desks at least 96 px (the 86 px figure plus
 * breathing room), 2 minimum, 8 maximum. With the Action inbox beside the
 * room, 1280 px leaves ~534 px → 5 per row; 1910 px → 8 per row.
 */
export function deskColumns(width: number, minDesk = 96, gap = 8, max = 8): number {
    return Math.max(2, Math.min(max, Math.floor((width + gap) / (minDesk + gap))));
}
