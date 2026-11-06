/**
 * Agent cost brake: rules (docs/design/agent-cost-brake.md).
 *
 * The loop guard counts messages; the waste is in tokens. The cost brake
 * measures agent-to-agent (a2a) spend — runs woken by a message from another
 * agent — since the last renewal, per agent pair and per task, plus the number
 * of consecutive a2a turns that moved nothing ("stall turns").
 *
 * 0.30 ships SHADOW ONLY: the rules run when a run finishes and a would-brake
 * decision is recorded for review. Nothing is suppressed, refused or posted.
 *
 * Pure: no DB access, so the rules are unit-tested directly
 * (cost-brake-store.ts loads the data and records decisions).
 */

export type CostBrakeMode = "off" | "shadow";

export interface CostBrakeLimits {
    /** Hard limit on a2a tokens per pair episode. */
    pairTokens: number;
    /** Hard limit on a2a tokens per task since the last human touch. */
    taskTokens: number;
    /** Consecutive no-progress a2a turns in a pair episode before a hard brake. */
    stallTurns: number;
    /** Percentage of a limit that is the soft level. */
    softPct: number;
}

export const DEFAULT_COST_BRAKE_LIMITS: CostBrakeLimits = {
    pairTokens: 8_000_000,
    taskTokens: 25_000_000,
    stallTurns: 4,
    softPct: 70,
};

/** How far back runs, renewals and the chatter report look. */
export const COST_BRAKE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * `EMPEROR_COST_BRAKE_MODE`: `off` disables the evaluation; anything else
 * (default) is `shadow`. There is no enforce path yet, so `enforce` is
 * treated as shadow rather than silently doing nothing.
 */
export function costBrakeMode(env: Record<string, string | undefined> = process.env): CostBrakeMode {
    return (env.EMPEROR_COST_BRAKE_MODE || "").trim().toLowerCase() === "off" ? "off" : "shadow";
}

function intFromEnv(raw: string | undefined, min: number, max: number, fallback: number): number {
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : fallback;
}

/** Limits from env, each validated (an invalid value falls back to its default). */
export function costBrakeLimits(env: Record<string, string | undefined> = process.env): CostBrakeLimits {
    const d = DEFAULT_COST_BRAKE_LIMITS;
    return {
        pairTokens: intFromEnv(env.EMPEROR_COST_BRAKE_PAIR_TOKENS, 10_000, 10_000_000_000, d.pairTokens),
        taskTokens: intFromEnv(env.EMPEROR_COST_BRAKE_TASK_TOKENS, 10_000, 10_000_000_000, d.taskTokens),
        stallTurns: intFromEnv(env.EMPEROR_COST_BRAKE_STALL_TURNS, 2, 100, d.stallTurns),
        softPct: intFromEnv(env.EMPEROR_COST_BRAKE_SOFT_PCT, 1, 99, d.softPct),
    };
}

/** One a2a run: an agent run whose trigger message came from a different agent. */
export interface A2aRun {
    id: string;
    /** The agent that ran. */
    agentId: string;
    /** The agent whose message woke it. */
    wakerId: string;
    threadId: string | null;
    taskId: string | null;
    /** input + output tokens (input includes cache reads). */
    tokens: number;
    startedAt: number;
    endedAt: number | null;
    /** The run produced core progress (a non-note task event or an artifact) by its agent. */
    progressed: boolean;
}

/** The two agents of a pair, in a stable order. */
export function pairOf(agentA: string, agentB: string): [string, string] {
    return agentA < agentB ? [agentA, agentB] : [agentB, agentA];
}

/**
 * The pair budget key. It is NOT keyed by thread: moving the conversation to a
 * private pair thread or another room must not open a fresh budget. When the
 * run is about a task, the key is the pair on that task; otherwise the pair's
 * task-less chat across every thread.
 */
export function pairEpisodeKey(agentA: string, agentB: string, taskId: string | null): string {
    const [lo, hi] = pairOf(agentA, agentB);
    return `${lo}:${hi}:${taskId ?? "chat"}`;
}

/** Whether a run belongs to a pair episode key (same pair, same task or both task-less). */
export function runInPairKey(run: Pick<A2aRun, "agentId" | "wakerId" | "taskId">, agentA: string, agentB: string, taskId: string | null): boolean {
    return pairEpisodeKey(run.agentId, run.wakerId, run.taskId) === pairEpisodeKey(agentA, agentB, taskId);
}

/** The two states a review ping-pong flips between. A flip between them never renews. */
const FLIP_STATES = new Set(["in_progress", "review"]);

export interface RenewalInput {
    /**
     * Instants that always start a fresh episode: a human message in a thread
     * of the episode, a human task event on the episode's task, or a Resume
     * marker posted by the system. Time and notes are never resets.
     */
    resets: number[];
    /** Task state changes (task-keyed episodes only). */
    stateChanges?: { at: number; state: string }[];
    /** The task's state before the window, when known. */
    initialState?: string | null;
}

/**
 * Where the current episode starts (epoch ms; `windowStart` when nothing
 * renewed it inside the window).
 *
 * A reset (human / Resume) always renews. A task state change renews only
 * when it is genuine progress:
 * - the task moves to a state it has NOT had since the last reset (so a
 *   cycle such as in_progress → blocked → in_progress renews at most once per
 *   distinct state, never forever), and
 * - it is not an in_progress ↔ review flip (the re-verification ping-pong).
 * The set of states seen is cleared only by a reset, never by a renewal.
 */
export function episodeStart(input: RenewalInput, windowStart: number): number {
    type Event = { at: number; kind: "reset" } | { at: number; kind: "state"; state: string };
    const events: Event[] = [
        ...input.resets.filter(Number.isFinite).map((at) => ({ at, kind: "reset" as const })),
        ...(input.stateChanges ?? []).filter((s) => Number.isFinite(s.at) && s.state).map((s) => ({ at: s.at, kind: "state" as const, state: s.state })),
    ]
        .filter((e) => e.at >= windowStart)
        // Same instant: the reset first, so a human touch then a move reads in order.
        .sort((a, b) => a.at - b.at || (a.kind === b.kind ? 0 : a.kind === "reset" ? -1 : 1));

    let start = windowStart;
    let current: string | null = input.initialState ?? null;
    let seen = new Set<string>(current ? [current] : []);
    for (const event of events) {
        if (event.kind === "reset") {
            start = event.at;
            seen = new Set(current ? [current] : []);
            continue;
        }
        const next = event.state;
        if (next === current) continue;
        const flip = current !== null && FLIP_STATES.has(current) && FLIP_STATES.has(next);
        if (!seen.has(next) && !flip) start = event.at;
        seen.add(next);
        current = next;
    }
    return start;
}

/** Consecutive no-progress runs at the end of an episode (oldest-first or not). */
export function stallTurns(runs: Pick<A2aRun, "startedAt" | "progressed">[]): number {
    const ordered = [...runs].sort((a, b) => a.startedAt - b.startedAt);
    let count = 0;
    for (let i = ordered.length - 1; i >= 0; i--) {
        if (ordered[i].progressed) break;
        count += 1;
    }
    return count;
}

export type BrakeLevel = "ok" | "soft" | "hard";
export type BrakeReason = "tokens" | "stall";

/** The level for a spend against a limit, plus an optional stall count. */
export function brakeLevel(input: {
    usedTokens: number;
    limitTokens: number;
    softPct: number;
    stall?: number;
    stallLimit?: number;
}): { level: BrakeLevel; reasons: BrakeReason[] } {
    const hard: BrakeReason[] = [];
    if (input.limitTokens > 0 && input.usedTokens >= input.limitTokens) hard.push("tokens");
    if (input.stallLimit && input.stall !== undefined && input.stall >= input.stallLimit) hard.push("stall");
    if (hard.length > 0) return { level: "hard", reasons: hard };

    const soft: BrakeReason[] = [];
    if (input.limitTokens > 0 && input.usedTokens >= (input.limitTokens * input.softPct) / 100) soft.push("tokens");
    if (input.stallLimit && input.stallLimit > 1 && input.stall !== undefined && input.stall >= input.stallLimit - 1) soft.push("stall");
    return soft.length > 0 ? { level: "soft", reasons: soft } : { level: "ok", reasons: [] };
}

export interface ScopeEvaluation {
    scope: "pair" | "task";
    /** pairEpisodeKey for a pair, the task id for a task. */
    key: string;
    agentA: string;
    agentB: string;
    taskId: string | null;
    episodeStart: number;
    runs: number;
    usedTokens: number;
    limitTokens: number;
    stallTurns: number;
    /** null for the task scope (it has no stall rule). */
    stallLimit: number | null;
    level: BrakeLevel;
    reasons: BrakeReason[];
}

/**
 * An episode that nothing renewed inside the window has no event to start
 * from, and the window start moves with the clock. Anchor it on its first run
 * instead, so the same episode keeps the same identity across evaluations
 * (one would-brake record per episode).
 */
function anchorEpisodeStart(start: number, windowStart: number, runs: Pick<A2aRun, "startedAt">[]): number {
    if (start !== windowStart || runs.length === 0) return start;
    return Math.min(...runs.map((r) => r.startedAt));
}

/**
 * The pair episode for (agentA, agentB, taskId): runs of that key since the
 * episode start, their tokens, and the trailing stall turns. `runs` may hold
 * runs of other keys; they are ignored.
 */
export function evaluatePairEpisode(input: {
    agentA: string;
    agentB: string;
    taskId: string | null;
    runs: A2aRun[];
    renewal: RenewalInput;
    limits: CostBrakeLimits;
    windowStart: number;
}): ScopeEvaluation {
    const [agentA, agentB] = pairOf(input.agentA, input.agentB);
    // Progress renews only a task-keyed episode: a chat has no task to move.
    const renewal = input.taskId ? input.renewal : { resets: input.renewal.resets };
    const start = episodeStart(renewal, input.windowStart);
    const runs = input.runs.filter((r) => runInPairKey(r, agentA, agentB, input.taskId) && r.startedAt >= start);
    const anchor = anchorEpisodeStart(start, input.windowStart, runs);
    const usedTokens = runs.reduce((sum, r) => sum + Math.max(0, r.tokens || 0), 0);
    const stall = stallTurns(runs);
    const { level, reasons } = brakeLevel({
        usedTokens, limitTokens: input.limits.pairTokens, softPct: input.limits.softPct,
        stall, stallLimit: input.limits.stallTurns,
    });
    return {
        scope: "pair", key: pairEpisodeKey(agentA, agentB, input.taskId), agentA, agentB, taskId: input.taskId,
        episodeStart: anchor, runs: runs.length, usedTokens, limitTokens: input.limits.pairTokens,
        stallTurns: stall, stallLimit: input.limits.stallTurns, level, reasons,
    };
}

/**
 * The task scope: every a2a run on the task (any pair, any thread) since the
 * last human touch or Resume. Progress never renews it — only a person does.
 */
export function evaluateTaskScope(input: {
    taskId: string;
    agentA: string;
    agentB: string;
    runs: A2aRun[];
    resets: number[];
    limits: CostBrakeLimits;
    windowStart: number;
}): ScopeEvaluation {
    const [agentA, agentB] = pairOf(input.agentA, input.agentB);
    const start = episodeStart({ resets: input.resets }, input.windowStart);
    const runs = input.runs.filter((r) => r.taskId === input.taskId && r.startedAt >= start);
    const anchor = anchorEpisodeStart(start, input.windowStart, runs);
    const usedTokens = runs.reduce((sum, r) => sum + Math.max(0, r.tokens || 0), 0);
    const { level, reasons } = brakeLevel({ usedTokens, limitTokens: input.limits.taskTokens, softPct: input.limits.softPct });
    return {
        scope: "task", key: input.taskId, agentA, agentB, taskId: input.taskId,
        episodeStart: anchor, runs: runs.length, usedTokens, limitTokens: input.limits.taskTokens,
        stallTurns: stallTurns(runs), stallLimit: null, level, reasons,
    };
}

/** The once-per-episode identity of a would-brake decision. */
export function wouldBrakeDedupeKey(evaluation: Pick<ScopeEvaluation, "scope" | "key" | "episodeStart">): string {
    return `${evaluation.scope}:${evaluation.key}:${evaluation.episodeStart}`;
}

/** The structured console line for a shadow would-brake decision. */
export function shadowLogLine(evaluation: ScopeEvaluation, context: { companyId: string; runId: string; threadId: string | null }): string {
    return `[cost-brake] shadow would-brake ${JSON.stringify({
        companyId: context.companyId,
        scope: evaluation.scope,
        key: evaluation.key,
        agentA: evaluation.agentA,
        agentB: evaluation.agentB,
        taskId: evaluation.taskId,
        threadId: context.threadId,
        runId: context.runId,
        reasons: evaluation.reasons,
        usedTokens: evaluation.usedTokens,
        limitTokens: evaluation.limitTokens,
        stallTurns: evaluation.stallTurns,
        stallLimit: evaluation.stallLimit,
        runs: evaluation.runs,
        episodeStart: new Date(evaluation.episodeStart).toISOString(),
    })}`;
}
