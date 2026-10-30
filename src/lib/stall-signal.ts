// "Last useful action" and the stall signal (product-decisions.md §4 rule 4,
// slice 10.6). A running run is making progress when it does something that
// moves work forward: a tool finishes, it posts a message, it asks for an
// approval, or it changes the task. Reasoning tokens, usage beats, typing
// refreshes and lease heartbeats are not progress: an agent can think in
// circles for an hour while every heartbeat says "alive".
//
// Pure and client-safe. The database query is in stall-signal-reads.ts.

import { copy, type CodedCopy } from "@/lib/coded-copy";

/** No useful action for this long while running = stalled. One knob for the task page, the live block and the inbox. */
export const STALL_THRESHOLD_MS = 10 * 60 * 1000;

/** Run event kinds that count as useful (an action finished), as opposed to heartbeats and thinking. */
export const USEFUL_RUN_EVENT_KINDS = [
    "tool.end",
    "subagent.end",
    "approval.auto",
    "clarify.auto",
] as const;

export function isUsefulRunEventKind(kind: string): boolean {
    return (USEFUL_RUN_EVENT_KINDS as readonly string[]).includes(kind);
}

type Instant = string | Date | number | null | undefined;

function toMs(value: Instant): number | null {
    if (value == null) return null;
    const ms = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
}

/**
 * The newest useful moment of a run: its start, or a later useful run event,
 * task mutation, message or approval request. Signals from before the run
 * started are ignored (they belong to an earlier run).
 */
export function lastUsefulAt(input: {
    startedAt: Instant;
    runEvents?: readonly { kind: string; ts: Instant }[];
    taskEventsAt?: readonly Instant[];
    messagesAt?: readonly Instant[];
    approvalsAt?: readonly Instant[];
}): Date {
    const start = toMs(input.startedAt) ?? 0;
    let best = start;
    const consider = (value: Instant) => {
        const ms = toMs(value);
        if (ms != null && ms >= start && ms > best) best = ms;
    };
    for (const event of input.runEvents ?? []) if (isUsefulRunEventKind(event.kind)) consider(event.ts);
    for (const at of input.taskEventsAt ?? []) consider(at);
    for (const at of input.messagesAt ?? []) consider(at);
    for (const at of input.approvalsAt ?? []) consider(at);
    return new Date(best);
}

export interface StallSignal {
    /** True once `idleMs` reaches the threshold. */
    stalled: boolean;
    /** Time since the last useful action (never negative). */
    idleMs: number;
    lastUsefulAt: string;
    thresholdMs: number;
}

/** The stall reading for a run, or null when the run is not running (finished work cannot stall). */
export function stallSignal(input: { status: string; lastUsefulAt: Instant; now: Instant; thresholdMs?: number }): StallSignal | null {
    if (input.status !== "running") return null;
    const last = toMs(input.lastUsefulAt);
    const now = toMs(input.now);
    if (last == null || now == null) return null;
    const thresholdMs = input.thresholdMs ?? STALL_THRESHOLD_MS;
    const idleMs = Math.max(0, now - last);
    return { stalled: idleMs >= thresholdMs, idleMs, lastUsefulAt: new Date(last).toISOString(), thresholdMs };
}

/** "40s", "14 min", "2 h 05 min". Minutes once past a minute: a stall is read at a glance, not to the second. */
export function formatIdle(ms: number): string {
    const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return `${hours} h ${String(minutes % 60).padStart(2, "0")} min`;
}

/** "No progress for 14 min" when stalled, else "Last useful action 40s ago". */
export function stallLabel(signal: Pick<StallSignal, "stalled" | "idleMs">): string {
    return signal.stalled ? `No progress for ${formatIdle(signal.idleMs)}` : `Last useful action ${formatIdle(signal.idleMs)} ago`;
}

/** formatIdle as coded copy (tasks.live.idle*). */
export function idleCopy(ms: number): CodedCopy {
    const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    if (total < 60) return copy("tasks.live.idleSeconds", { count: total });
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return copy("tasks.live.idleMinutes", { count: minutes });
    return copy("tasks.live.idleHours", { hours: Math.floor(minutes / 60), minutes: String(minutes % 60).padStart(2, "0") });
}

/** stallLabel as coded copy, for the viewer's language. */
export function stallLabelCopy(signal: Pick<StallSignal, "stalled" | "idleMs">): CodedCopy {
    return copy(signal.stalled ? "tasks.live.noProgressFor" : "tasks.live.lastUsefulAction", { idle: idleCopy(signal.idleMs) });
}
