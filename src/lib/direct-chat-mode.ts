/**
 * Direct chats with agents, per company (companies.direct_chat_mode).
 *
 * - "shared": one direct thread per agent, visible to the whole company.
 * - "private": one direct thread per (person, agent), with that person as the
 *   only human participant. System traffic with no person behind it (task
 *   wakes, stall reminders, routines, agent-initiated posts) goes to the
 *   agent's shared thread, shown as its "Operations" thread.
 *
 * Pure helpers only: safe to import from client components and unit tests.
 */
export const DIRECT_CHAT_MODES = ["shared", "private"] as const;
export type DirectChatMode = (typeof DIRECT_CHAT_MODES)[number];

/** Companies that predate the setting were backfilled to "shared"; unknown values read as shared too. */
export function normalizeDirectChatMode(value: unknown): DirectChatMode {
    return value === "private" ? "private" : "shared";
}

export function isDirectChatMode(value: unknown): value is DirectChatMode {
    return typeof value === "string" && (DIRECT_CHAT_MODES as readonly string[]).includes(value);
}

/** Title of an agent's shared direct thread in a private-mode company. */
export function operationsThreadTitle(agentName: string | null | undefined): string {
    const name = agentName?.trim();
    return `${name || "Agent"} · Operations`;
}

/** Title of a person's private direct thread with an agent. */
export const PRIVATE_DIRECT_THREAD_TITLE = "Direct Agent Thread";

/**
 * The one person behind a set of items (e.g. a batch of task wakes), or null
 * when there is none or more than one: a mixed batch belongs in the shared
 * Operations thread, not in one person's private chat.
 */
export function singleHumanOwner(ids: readonly (string | null | undefined)[]): string | null {
    let owner: string | null = null;
    for (const id of ids) {
        if (!id) return null;
        if (owner === null) owner = id;
        else if (owner !== id) return null;
    }
    return owner;
}

/** The fields that decide who may use a thread. */
export type ThreadPrivacy = {
    type: string;
    ownerUserId?: string | null;
    isPrivate?: boolean | null;
    directAgentId?: string | null;
};

/** A person's private direct thread (also once its owner is gone). */
export function isPrivateDirectThread(thread: ThreadPrivacy): boolean {
    return thread.type === "direct" && (Boolean(thread.isPrivate) || Boolean(thread.ownerUserId));
}

/**
 * Whether a signed-in person may use a thread as a direct chat: anything that
 * is not a private direct thread, or a private one they own. An orphaned
 * private thread (owner deleted) belongs to nobody.
 */
export function userMayUseThread(thread: ThreadPrivacy, userId: string | null | undefined): boolean {
    if (!isPrivateDirectThread(thread)) return true;
    return Boolean(userId) && thread.ownerUserId === userId;
}

/**
 * Whether an MCP token may use a thread: a private direct thread only by a
 * token bound to that thread's own agent. Unbound (company-wide) tokens never.
 */
export function agentTokenMayUseThread(thread: ThreadPrivacy, boundAgentId: string | null | undefined): boolean {
    if (!isPrivateDirectThread(thread)) return true;
    return Boolean(boundAgentId) && thread.directAgentId === boundAgentId;
}

/**
 * Realtime (mcp_events) audience. Events about a private thread carry the one
 * agent allowed to receive them; events without an audience go company-wide.
 * `ownerUserId` (present on the human fan-out shape) names the one person who
 * owns the private thread, so a signed-in person's socket can keep another
 * user's private thread away. Agent sockets ignore it.
 */
export type RealtimeAudience = { agentId: string | null; ownerUserId?: string | null };

export function socketMayReceive(audience: RealtimeAudience | null | undefined, socket: { agentId?: string | null }): boolean {
    if (!audience) return true;
    return Boolean(audience.agentId) && socket.agentId === audience.agentId;
}

/**
 * Every thread an mcp_events payload names (thread.id, threadId,
 * message.threadId, objective.threadId), deduplicated. The audience is
 * decided from all of them, so a payload whose fields disagree can never
 * fan a private message out under a public thread's id.
 */
export function eventThreadIds(payload: unknown): string[] {
    if (!payload || typeof payload !== "object") return [];
    const p = payload as Record<string, unknown>;
    const nested = (key: string) => {
        const value = p[key];
        return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
    };
    const candidates = [nested("thread")?.id, p.threadId, nested("message")?.threadId, nested("objective")?.threadId];
    return [...new Set(candidates.filter((c): c is string => typeof c === "string" && c.length > 0))];
}

/**
 * The most restrictive audience over the threads an event names: none when all
 * are shared; the private thread's agent when one is private; nobody (agentId
 * null) when private threads of different agents are mixed.
 */
export function mostRestrictiveAudience(threads: readonly ThreadPrivacy[]): RealtimeAudience | null {
    const privateAgents = new Set(threads.filter(isPrivateDirectThread).map((t) => t.directAgentId ?? null));
    if (privateAgents.size === 0) return null;
    if (privateAgents.size > 1) return { agentId: null };
    return { agentId: [...privateAgents][0] };
}

/**
 * The audience for BOTH fan-outs at once: the agent (MCP sockets) and the
 * human owner (browser sockets). Mirrors mostRestrictiveAudience for the agent
 * axis; the owner axis resolves the one person who owns every private thread
 * the event names. A private thread with no owner (deleted) or two owners
 * resolves to null = nobody on the human side (fail closed).
 */
export function mostRestrictiveHumanAudience(threads: readonly ThreadPrivacy[]): RealtimeAudience | null {
    const privates = threads.filter(isPrivateDirectThread);
    if (privates.length === 0) return null;
    const agents = new Set(privates.map((t) => t.directAgentId ?? null));
    const owners = new Set(privates.map((t) => t.ownerUserId ?? null));
    return {
        agentId: agents.size === 1 ? [...agents][0] : null,
        ownerUserId: owners.size === 1 ? [...owners][0] : null,
    };
}

/**
 * Where a direct thread opens in /messages. The agent link is kept for older
 * clients; `thread` picks the exact conversation (a private thread or the
 * Operations thread) when the viewer has it.
 */
export function directThreadLink(threadId: string, agentId: string | null): string {
    const params = new URLSearchParams();
    if (agentId) params.set("agent", agentId);
    params.set("thread", threadId);
    return `/messages?${params.toString()}`;
}
