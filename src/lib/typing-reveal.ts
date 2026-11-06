// Typing reveal (0.31): a new agent reply that arrives live in a chat is shown
// word by word for a moment, like streaming, then rendered exactly as before.
// Pure timing rules here (unit-tested in tests/unit/typing-reveal.test.ts);
// the registry below remembers which messages arrived live and when, so a
// reply animates once: never history, never again on re-render, remount
// (virtualized rows) or after switching threads and back.

export const REVEAL_MIN_MS = 300;
export const REVEAL_MAX_MS = 1500;
export const REVEAL_MS_PER_WORD = 45;
/** Only a reply this recent animates (a tab coming back from the background shows older ones at once). */
export const REVEAL_FRESH_MS = 60_000;

/** The end index of each word (with the whitespace after it), so a reveal never cuts a word in half. */
export function wordEnds(text: string): number[] {
    const ends: number[] = [];
    const re = /\S+\s*/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) ends.push(match.index + match[0].length);
    return ends;
}

/** Total reveal time: per word, at least REVEAL_MIN_MS and never more than REVEAL_MAX_MS however long the text. */
export function revealDurationMs(text: string): number {
    return Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, wordEnds(text).length * REVEAL_MS_PER_WORD));
}

/** The part of the text shown `elapsedMs` into the reveal (whole words; the full text once it is over). */
export function revealedText(text: string, elapsedMs: number, durationMs = revealDurationMs(text)): string {
    if (elapsedMs >= durationMs) return text;
    const ends = wordEnds(text);
    if (ends.length === 0 || elapsedMs <= 0) return "";
    const words = Math.min(ends.length, Math.ceil((elapsedMs / durationMs) * ends.length));
    return text.slice(0, ends[words - 1]).trimEnd();
}

/** Did this message arrive just now (not an old one fetched late)? */
export function isFreshMessage(createdAt: string | Date | null | undefined, nowMs: number): boolean {
    const at = createdAt ? new Date(createdAt).getTime() : NaN;
    return Number.isFinite(at) && nowMs - at <= REVEAL_FRESH_MS;
}

// ─── Which messages arrived live (client only) ─────────────────────────────

const started = new Map<string, number>();

function prefersReducedMotion(): boolean {
    try {
        return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
        return false;
    }
}

/**
 * Mark agent messages that just arrived live (a poll or realtime fetch after
 * the first load). Idempotent: a message's reveal starts once. Nothing is
 * marked when the person prefers reduced motion.
 */
export function markLiveReveal(messages: readonly { id: string; senderType?: string | null; text?: string | null; createdAt?: string | Date | null }[]): void {
    if (typeof window === "undefined" || prefersReducedMotion()) return;
    const now = Date.now();
    // Entries are kept (one number per live reply this session), so a reply never animates twice.
    for (const message of messages) {
        if (message.senderType !== "agent" || !message.text?.trim() || started.has(message.id)) continue;
        if (isFreshMessage(message.createdAt, now)) started.set(message.id, now);
    }
}

/** When this message's reveal started, or null (not a live arrival). */
export function revealStartOf(messageId: string): number | null {
    return started.get(messageId) ?? null;
}
