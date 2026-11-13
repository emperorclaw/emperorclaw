// Which direct chat the Messages page opens, and the per-chat bits the
// browser remembers (docs/design/multi-chat-per-agent.md §6 routing):
//
// - `?thread=<id>` is always exact: any of the person's chats (main, extra,
//   or archived when the link also names the agent).
// - `?agent=<id>` alone opens the chat last viewed with that agent, else its
//   main chat. A draft handed over from another page always lands in main.
// - Drafts are kept per chat (thread id), in sessionStorage.
//
// The resolver is pure (unit-tested); the storage helpers swallow blocked or
// unavailable storage, so the page always renders.

export type DirectSelection = { agentId: string; threadId: string | null };

/** localStorage key: the chat last viewed with one agent (a thread id). */
export function lastChatStorageKey(agentId: string): string {
    return `emperor-messages-last-chat:${agentId}`;
}

export function resolveDirectSelection(input: {
    thread: string | null;
    agent: string | null;
    /** Thread id → agent id for the person's listed chats (main and extra). */
    knownThreads: Readonly<Record<string, string>>;
    lastChatFor: (agentId: string) => string | null;
    agentKnown: (agentId: string) => boolean;
    /** A draft is waiting for the agent's main chat. */
    preferMain?: boolean;
}): DirectSelection | null {
    const { thread, agent, knownThreads } = input;
    if (thread) {
        const agentId = knownThreads[thread] ?? (agent && input.agentKnown(agent) ? agent : null);
        return agentId ? { agentId, threadId: thread } : null;
    }
    if (!agent || !input.agentKnown(agent)) return null;
    if (input.preferMain) return { agentId: agent, threadId: null };
    const last = input.lastChatFor(agent);
    return { agentId: agent, threadId: last && knownThreads[last] === agent ? last : null };
}

/**
 * What may be remembered as the chat to reopen for an open selection: only a listed chat
 * of that agent. An archived (unlisted) chat opened by link is shown, but the agent's row
 * and a bare /messages reopen its main chat instead.
 */
export function rememberableSelection(
    selection: DirectSelection,
    knownThreads: Readonly<Record<string, string>>,
): DirectSelection {
    const { agentId, threadId } = selection;
    return threadId && knownThreads[threadId] !== agentId ? { agentId, threadId: null } : selection;
}

export function readLastChat(agentId: string): string | null {
    try {
        return window.localStorage.getItem(lastChatStorageKey(agentId));
    } catch {
        return null;
    }
}

export function rememberLastChat(agentId: string, threadId: string | null) {
    try {
        if (threadId) window.localStorage.setItem(lastChatStorageKey(agentId), threadId);
        else window.localStorage.removeItem(lastChatStorageKey(agentId));
    } catch {
        // Storage blocked: the agent's main chat opens next time.
    }
}

/** sessionStorage key for an unsent draft in one chat (`new:<agentId>` for a New chat composer). */
export function threadDraftKey(key: string): string {
    return `emperor.threadDraft.${key}`;
}

export function readThreadDraft(key: string): string {
    try {
        return window.sessionStorage.getItem(threadDraftKey(key)) ?? "";
    } catch {
        return "";
    }
}

export function writeThreadDraft(key: string, text: string) {
    try {
        if (text) window.sessionStorage.setItem(threadDraftKey(key), text);
        else window.sessionStorage.removeItem(threadDraftKey(key));
    } catch {
        // Storage blocked: the draft lives as long as the composer.
    }
}

/** The client key of the agent's pending New chat (kept until its first message lands, so a retry reuses it). */
export function newChatKeyStorageKey(agentId: string): string {
    return `emperor.newChatKey.${agentId}`;
}

export function readPendingNewChatKey(agentId: string): string | null {
    try {
        return window.sessionStorage.getItem(newChatKeyStorageKey(agentId));
    } catch {
        return null;
    }
}

export function writePendingNewChatKey(agentId: string, clientKey: string | null) {
    try {
        if (clientKey) window.sessionStorage.setItem(newChatKeyStorageKey(agentId), clientKey);
        else window.sessionStorage.removeItem(newChatKeyStorageKey(agentId));
    } catch {
        // Storage blocked: the key lives as long as the composer.
    }
}
