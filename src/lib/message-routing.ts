/**
 * Who answers a message — decided ONCE, by the server, for every runtime.
 *
 * Runtimes used to each reimplement these rules (the Hermes bridge in Python,
 * the Codex bridge in JavaScript, every third-party runtime again), and they
 * drifted: the loop guard never engaged and Codex would have answered every
 * group message. `/messages/sync` now hands each runtime a verdict per
 * message — `addressedToYou` plus a `routeReason` — and runtimes that know the
 * field follow it. Older runtimes ignore it and keep their own (compatible)
 * logic.
 *
 * Pure: no DB access, so the rules are unit-tested directly.
 */

export type RouteReason =
    | "self"            // the agent's own message
    | "targeted"        // targetAgentId is this agent
    | "targeted_other"  // targetAgentId is another agent
    | "direct"          // a human wrote in this agent's direct thread
    | "mention"         // @Name addresses this agent
    | "all"             // a human's @all in a group
    | "agent_pair"      // the other agent in a two-agent pair thread
    | "task_assigned"   // a system notice: a task was assigned to this agent
    | "not_addressed"   // shared thread, no mention of this agent
    | "loop_paused";    // too many agent messages in a row without progress

export interface RouteDecision {
    addressedToYou: boolean;
    routeReason: RouteReason;
}

export interface RosterAgent {
    id: string;
    name: string;
}

export interface RoutableMessage {
    senderType: string;
    senderId: string | null;
    targetAgentId: string | null;
    text: string;
}

/** Consecutive agent messages in a shared room (team/group) before agents are paused. */
export const DEFAULT_AGENT_LOOP_MAX_TURNS = 12;
/** A two-agent pair thread gets more runway: it is a focused handoff, not a room. */
export const DEFAULT_AGENT_PAIR_LOOP_MAX_TURNS = 30;

/**
 * Message-metadata keys that only server code may set. A caller-supplied value
 * for any of these is stripped before a message is persisted (see the MCP
 * message-post route) so a runtime cannot forge a task wake, a stall nudge, or
 * otherwise bypass the loop guard.
 */
export const RESERVED_MESSAGE_METADATA_KEYS = ["taskAssigned", "stallNudge", "stallEscalation", "agentWake", "loopGuardResume"] as const;

/**
 * A "Resume" marker resets the loop streak. It is a system message with this
 * metadata flag, posted by the Messages UI when a human clicks Resume on a
 * pause notice. Unlike ordinary system notices (which neither count nor reset),
 * it resets the streak so the paused agents may answer again.
 */
export function isLoopGuardResume(metadata: unknown): boolean {
    if (!metadata || typeof metadata !== "object") return false;
    return (metadata as Record<string, unknown>).loopGuardResume === true;
}

/** Drop reserved internal keys from caller-supplied metadata, preserving the rest. */
export function stripReservedMetadata(metadata: unknown): Record<string, unknown> {
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
    const reserved = new Set<string>(RESERVED_MESSAGE_METADATA_KEYS);
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata as Record<string, unknown>)) {
        if (reserved.has(key)) continue;
        out[key] = value;
    }
    return out;
}

export function agentLoopMaxTurns(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.EMPEROR_AGENT_LOOP_MAX_TURNS);
    return Number.isInteger(value) && value >= 2 && value <= 100 ? value : DEFAULT_AGENT_LOOP_MAX_TURNS;
}

/** The higher runway a two-agent pair thread gets before it is paused. */
export function agentPairLoopMaxTurns(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.EMPEROR_AGENT_PAIR_LOOP_MAX_TURNS);
    return Number.isInteger(value) && value >= 2 && value <= 500 ? value : DEFAULT_AGENT_PAIR_LOOP_MAX_TURNS;
}

/** The loop threshold for a thread: rooms use the team cap, pair threads the pair cap. */
export function agentLoopMaxTurnsFor(isAgentPair: boolean, env: Record<string, string | undefined> = process.env): number {
    return isAgentPair ? agentPairLoopMaxTurns(env) : agentLoopMaxTurns(env);
}

/** Hard backstop for runtimes that ignore the verdict: agent posts are refused past this. */
export function agentLoopHardCap(env: Record<string, string | undefined> = process.env): number {
    return agentLoopMaxTurns(env) * 3;
}

/** The hard cap for a pair thread (3x its own threshold). */
export function agentPairLoopHardCap(env: Record<string, string | undefined> = process.env): number {
    return agentPairLoopMaxTurns(env) * 3;
}

/** Same normalization as the Hermes bridge: ASCII-fold, lowercase, alphanumerics only. */
export function normalizeMention(value: string): string {
    return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

/** Full-name style aliases (mirrors the bridge's agent_name_aliases, minus the first word). */
function fullAliases(name: string): string[] {
    const clean = name.replace(/\([^)]*\)/g, "").trim().split(/\s+-\s+|\s+—\s+|\s+\|\s+/)[0].trim();
    const parts = clean.split(/\s+/).filter(Boolean);
    return [name, clean, parts.join("-"), parts.join("_")].map(normalizeMention).filter(Boolean);
}

/**
 * Agent ids addressed by @mentions in `text`. Full names win over first
 * names, and a first name only counts when exactly one agent has it — so
 * "@Max Builder" never also wakes an agent called "Max".
 */
export function mentionedAgentIds(text: string, roster: RosterAgent[]): Set<string> {
    const full = new Map<string, Set<string>>();
    const first = new Map<string, Set<string>>();
    for (const agent of roster) {
        for (const alias of fullAliases(agent.name)) {
            if (!full.has(alias)) full.set(alias, new Set());
            full.get(alias)!.add(agent.id);
        }
        const firstWord = normalizeMention(agent.name.replace(/\([^)]*\)/g, "").trim().split(/\s+/)[0] || "");
        if (firstWord) {
            if (!first.has(firstWord)) first.set(firstWord, new Set());
            first.get(firstWord)!.add(agent.id);
        }
    }

    const found = new Set<string>();
    // An @ that isn't part of a word or an email address, then up to three words.
    const re = /(?<![\w@])@([^\s,.;:!?@()<>]+(?:[ \t]+[^\s,.;:!?@()<>]+){0,2})/g;
    for (const match of text.matchAll(re)) {
        const words = match[1].split(/[ \t]+/);
        let matched = false;
        for (let n = words.length; n >= 1 && !matched; n--) {
            const ids = full.get(normalizeMention(words.slice(0, n).join(" ")));
            if (ids && ids.size > 0) {
                ids.forEach((id) => found.add(id));
                matched = true;
            }
        }
        if (!matched) {
            const ids = first.get(normalizeMention(words[0]));
            if (ids && ids.size === 1) ids.forEach((id) => found.add(id));
        }
    }
    return found;
}

const EVERYONE_RE = /(?<![\w@])@(all|everyone)(?![\w-])/i;

export function mentionsEveryone(text: string): boolean {
    return EVERYONE_RE.test(text);
}

/**
 * The verdict for one agent and one message.
 *
 * `agentStreak` is the number of consecutive agent-authored messages in the
 * thread ending at this message (0 for a human message).
 *
 * `isAgentPair` marks a thread that is a dedicated two-agent pair (a `group`
 * thread with exactly the two agents as participants). In such a thread the
 * counterpart addresses this agent without @mention or targetAgentId.
 *
 * `taskAssignedWake` marks a system notice whose `targetAgentId` is this agent
 * because a task was assigned to it (Step 3 wake-on-assignment).
 */
export function decideDelivery(input: {
    agentId: string;
    message: RoutableMessage;
    threadType: string | null;
    roster: RosterAgent[];
    agentStreak: number;
    maxAgentTurns?: number;
    isAgentPair?: boolean;
    taskAssignedWake?: boolean;
}): RouteDecision {
    const { agentId, message } = input;
    const senderType = (message.senderType || "").toLowerCase();
    const threadType = (input.threadType || "").toLowerCase();

    if (senderType === "agent" && message.senderId === agentId) return { addressedToYou: false, routeReason: "self" };

    // A task assigned to this agent is addressed to it, with its own reason.
    // Only a genuine system notice carries this flag — a caller that stamps
    // `taskAssigned` metadata onto an agent/human message must not wake anyone.
    if (senderType === "system" && input.taskAssignedWake && message.targetAgentId === agentId) {
        return { addressedToYou: true, routeReason: "task_assigned" };
    }

    // Agent-originated messages in shared threads (team, groups, pair threads,
    // and an agent targeting another agent) are loop-guarded. A human or system
    // message resets/skips the guard (their streak is 0), so people and runtime
    // notices always get through — only agent chains with no progress are paused.
    if (threadType !== "direct" && senderType === "agent" && input.agentStreak > (input.maxAgentTurns ?? agentLoopMaxTurnsFor(Boolean(input.isAgentPair)))) {
        return { addressedToYou: false, routeReason: "loop_paused" };
    }

    // In a two-agent pair thread the counterpart is addressed without mention.
    // This wins over `targeted`: pair messages keep targetAgentId set only so
    // old runtimes still route them, but the verdict is the pair handoff.
    if (
        input.isAgentPair && senderType === "agent" && message.senderId && message.senderId !== agentId &&
        (!message.targetAgentId || message.targetAgentId === agentId)
    ) {
        return { addressedToYou: true, routeReason: "agent_pair" };
    }

    if (message.targetAgentId) {
        return message.targetAgentId === agentId
            ? { addressedToYou: true, routeReason: "targeted" }
            : { addressedToYou: false, routeReason: "targeted_other" };
    }

    // Sync only returns direct threads this agent participates in: a human
    // writing there is talking to it.
    if (threadType === "direct" && senderType === "human") return { addressedToYou: true, routeReason: "direct" };

    if (mentionedAgentIds(message.text || "", input.roster).has(agentId)) return { addressedToYou: true, routeReason: "mention" };
    if (threadType === "group" && senderType === "human" && mentionsEveryone(message.text || "")) {
        return { addressedToYou: true, routeReason: "all" };
    }
    return { addressedToYou: false, routeReason: "not_addressed" };
}

/**
 * Streak of consecutive agent messages ending at each message, given a
 * thread's messages oldest-first. A human message resets it; system notices
 * (e.g. a runtime control or a loop-guard notice) neither count nor reset.
 *
 * `progress` is a list of timestamps of real progress — a task state change,
 * an assignment, a task note, or a delivered artifact by a thread participant.
 * Each one resets the streak, so a long cooperative exchange that keeps making
 * progress never trips the guard. A message whose `resumes` flag is set (the
 * "Resume" marker) also resets the streak.
 */
export const AGENT_LOOP_COOLDOWN_MS = 5 * 60 * 1000;

export interface StreakMessage {
    id: string;
    senderType: string;
    createdAt?: Date | string;
    /** A system "Resume" marker resets the streak (unlike ordinary system notices). */
    resumes?: boolean;
}

export function agentStreaks(
    messages: StreakMessage[],
    progress: (Date | string | number)[] = [],
): Map<string, number> {
    // A message with an invalid createdAt is treated as "now" rather than being
    // dropped from the timeline, so one malformed message cannot hide a streak.
    const nowMs = Date.now();
    const normalized = messages.map((m) => {
        if (m.createdAt === undefined) return m;
        const t = new Date(m.createdAt).getTime();
        return Number.isNaN(t) ? { ...m, createdAt: new Date(nowMs) } : m;
    });

    const toAt = (value: Date | string | number | undefined) => {
        if (value === undefined) return NaN;
        const t = new Date(value).getTime();
        return Number.isNaN(t) ? NaN : t;
    };

    if (progress.length === 0) {
        // Fast path: identical to the pre-progress behavior (in-order messages,
        // optional timestamps for the cooldown window).
        const streaks = new Map<string, number>();
        let streak = 0;
        let lastActivity: number | undefined;
        for (const m of normalized) {
            const timestamp = m.createdAt !== undefined ? new Date(m.createdAt).getTime() : undefined;
            if (timestamp !== undefined && lastActivity !== undefined && timestamp - lastActivity >= AGENT_LOOP_COOLDOWN_MS) streak = 0;
            const type = (m.senderType || "").toLowerCase();
            if (type === "human" || m.resumes === true) streak = 0;
            else if (type === "agent") streak += 1;
            if (type !== "system" && timestamp !== undefined) lastActivity = timestamp;
            if (m.resumes === true) lastActivity = timestamp;
            streaks.set(m.id, type === "agent" ? streak : 0);
        }
        return streaks;
    }

    // With progress events, merge the two timelines by time: a progress event
    // resets the streak (it is "activity" but not a message).
    const streaks = new Map<string, number>();
    type Event = { kind: "message"; message: StreakMessage; at: number } | { kind: "progress"; at: number };
    const events: Event[] = [
        ...normalized.map((m) => ({ kind: "message" as const, message: m, at: toAt(m.createdAt) })),
        ...progress.map((p) => ({ kind: "progress" as const, at: toAt(p) })),
    ]
        .filter((e) => !Number.isNaN(e.at))
        .sort((a, b) => a.at - b.at);

    let streak = 0;
    let lastActivity: number | undefined;
    for (const event of events) {
        if (event.kind === "progress") {
            streak = 0;
            lastActivity = event.at;
            continue;
        }
        const m = event.message;
        const timestamp = event.at;
        if (lastActivity !== undefined && timestamp - lastActivity >= AGENT_LOOP_COOLDOWN_MS) streak = 0;
        const type = (m.senderType || "").toLowerCase();
        if (type === "human" || m.resumes === true) streak = 0;
        else if (type === "agent") streak += 1;
        if (type !== "system") lastActivity = timestamp;
        if (m.resumes === true) lastActivity = timestamp;
        streaks.set(m.id, type === "agent" ? streak : 0);
    }
    return streaks;
}

export interface AgentStreakState {
    /** The streak of the last message (0 for a human/system message). */
    streak: number;
    /** Epoch ms of the most recent streak reset (0 when it never reset). */
    resetAt: number;
}

/**
 * The current streak and the moment it last reset, for a thread's messages
 * (oldest-first) plus progress timestamps. Mirrors {@link agentStreaks}, but
 * also tracks the reset time — the point from which the current streak counts.
 * The reset happens on a human message, a resume marker, a progress event, or a
 * cooldown gap, so callers can tell whether a loop-pause notice was already
 * posted for THIS pause (i.e. after the latest reset).
 */
export function agentStreakState(
    messages: StreakMessage[],
    progress: (Date | string | number)[] = [],
): AgentStreakState {
    const nowMs = Date.now();
    const normalized = messages.map((m) => {
        if (m.createdAt === undefined) return m;
        const t = new Date(m.createdAt).getTime();
        return Number.isNaN(t) ? { ...m, createdAt: new Date(nowMs) } : m;
    });
    const toAt = (value: Date | string | number | undefined) => {
        if (value === undefined) return NaN;
        const t = new Date(value).getTime();
        return Number.isNaN(t) ? NaN : t;
    };

    let streak = 0;
    let lastActivity: number | undefined;
    let resetAt = 0;
    let lastMessageStreak = 0;
    let resetAtLastMessage = 0;

    const processMessage = (m: StreakMessage, timestamp: number | undefined) => {
        if (timestamp !== undefined && lastActivity !== undefined && timestamp - lastActivity >= AGENT_LOOP_COOLDOWN_MS) {
            streak = 0;
            resetAt = timestamp;
        }
        const type = (m.senderType || "").toLowerCase();
        if (type === "human" || m.resumes === true) {
            streak = 0;
            resetAt = timestamp ?? nowMs;
        } else if (type === "agent") {
            streak += 1;
        }
        if (type !== "system" && timestamp !== undefined) lastActivity = timestamp;
        if (m.resumes === true && timestamp !== undefined) lastActivity = timestamp;
        lastMessageStreak = type === "agent" ? streak : 0;
        resetAtLastMessage = resetAt;
    };

    if (progress.length === 0) {
        for (const m of normalized) {
            const timestamp = m.createdAt !== undefined ? new Date(m.createdAt).getTime() : undefined;
            processMessage(m, timestamp);
        }
        return { streak: lastMessageStreak, resetAt: resetAtLastMessage };
    }

    type Event = { kind: "message"; message: StreakMessage; at: number } | { kind: "progress"; at: number };
    const events: Event[] = [
        ...normalized.map((m) => ({ kind: "message" as const, message: m, at: toAt(m.createdAt) })),
        ...progress.map((p) => ({ kind: "progress" as const, at: toAt(p) })),
    ]
        .filter((e) => !Number.isNaN(e.at))
        .sort((a, b) => a.at - b.at);

    for (const event of events) {
        if (event.kind === "progress") {
            streak = 0;
            lastActivity = event.at;
            resetAt = event.at;
            continue;
        }
        processMessage(event.message, event.at);
    }
    return { streak: lastMessageStreak, resetAt: resetAtLastMessage };
}

/** A task note may reset the streak at most once every N agent messages. */
export const NOTE_RESET_INTERVAL_MESSAGES = 5;

/**
 * Task notes are progress, but they must not be farmable: a note resets the
 * streak at most once every {@link NOTE_RESET_INTERVAL_MESSAGES} agent messages.
 * The first note always counts (it is genuine work), and every later note only
 * counts once five agent messages have passed since the last counted note.
 * Returns the note timestamps (epoch ms) that may actually reset the streak.
 */
export function noteProgressResets(messages: StreakMessage[], noteTimes: (Date | string | number)[]): number[] {
    const notes = noteTimes.map((n) => new Date(n).getTime()).filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    if (notes.length === 0) return [];

    const events: { at: number; kind: "message" | "note" }[] = [
        ...messages
            .filter((m) => (m.senderType || "").toLowerCase() === "agent" && m.createdAt !== undefined)
            .map((m) => ({ at: new Date(m.createdAt as Date | string).getTime(), kind: "message" as const }))
            .filter((e) => Number.isFinite(e.at)),
        ...notes.map((at) => ({ at, kind: "note" as const })),
    ].sort((a, b) => a.at - b.at);

    const kept: number[] = [];
    let messagesSinceNote = 0;
    for (const event of events) {
        if (event.kind === "message") {
            messagesSinceNote += 1;
        } else if (kept.length === 0 || messagesSinceNote >= NOTE_RESET_INTERVAL_MESSAGES) {
            kept.push(event.at);
            messagesSinceNote = 0;
        }
    }
    return kept;
}
