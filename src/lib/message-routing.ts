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
    | "not_addressed"   // shared thread, no mention of this agent
    | "loop_guard";     // too many agent messages in a row without a human

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

/** Consecutive agent messages in a shared thread before agents are paused. */
export const DEFAULT_AGENT_LOOP_MAX_TURNS = 6;

export function agentLoopMaxTurns(env: Record<string, string | undefined> = process.env): number {
    const value = Number(env.EMPEROR_AGENT_LOOP_MAX_TURNS);
    return Number.isInteger(value) && value >= 2 && value <= 100 ? value : DEFAULT_AGENT_LOOP_MAX_TURNS;
}

/** Hard backstop for runtimes that ignore the verdict: agent posts are refused past this. */
export function agentLoopHardCap(env: Record<string, string | undefined> = process.env): number {
    return agentLoopMaxTurns(env) * 3;
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
 */
export function decideDelivery(input: {
    agentId: string;
    message: RoutableMessage;
    threadType: string | null;
    roster: RosterAgent[];
    agentStreak: number;
    maxAgentTurns?: number;
}): RouteDecision {
    const { agentId, message } = input;
    const senderType = (message.senderType || "").toLowerCase();
    const threadType = (input.threadType || "").toLowerCase();

    if (senderType === "agent" && message.senderId === agentId) return { addressedToYou: false, routeReason: "self" };
    if (message.targetAgentId) {
        return message.targetAgentId === agentId
            ? { addressedToYou: true, routeReason: "targeted" }
            : { addressedToYou: false, routeReason: "targeted_other" };
    }
    // Sync only returns direct threads this agent participates in: a human
    // writing there is talking to it.
    if (threadType === "direct" && senderType === "human") return { addressedToYou: true, routeReason: "direct" };

    // Every thread but a direct one is shared (team, groups, and any type a
    // future version adds), so the loop guard applies there.
    if (threadType !== "direct" && senderType === "agent" && input.agentStreak > (input.maxAgentTurns ?? agentLoopMaxTurns())) {
        return { addressedToYou: false, routeReason: "loop_guard" };
    }
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
 */
export function agentStreaks(messages: { id: string; senderType: string }[]): Map<string, number> {
    const streaks = new Map<string, number>();
    let streak = 0;
    for (const m of messages) {
        const type = (m.senderType || "").toLowerCase();
        if (type === "human") streak = 0;
        else if (type === "agent") streak += 1;
        streaks.set(m.id, type === "agent" ? streak : 0);
    }
    return streaks;
}
