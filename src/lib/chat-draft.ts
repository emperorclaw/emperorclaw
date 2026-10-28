// A message draft handed to the direct chat with an agent (e.g. "Ask about
// this panel" on a view). Kept in sessionStorage, not the URL, so what the
// draft quotes never lands in history or server logs. The chat reads it once
// when it opens and removes it; nothing is ever sent for the person.

export function chatDraftKey(agentId: string): string {
    return `emperor.chatDraft.${agentId}`;
}

/** Read and forget the draft for this agent (null when there is none or storage is blocked). */
export function takeChatDraft(agentId: string): string | null {
    try {
        const key = chatDraftKey(agentId);
        const draft = window.sessionStorage.getItem(key);
        if (draft !== null) window.sessionStorage.removeItem(key);
        return draft;
    } catch {
        return null;
    }
}
