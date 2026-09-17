/**
 * Caps for persisted agent reasoning history.
 *
 * Kept free of database and request imports on purpose: the bridge applies its
 * own client-side cap, the write route re-applies this one, and the pure helper
 * stays unit-testable without a database or an authenticated request.
 */

// A single turn's raw reasoning. Generous enough that a normal multi-step turn
// survives intact, bounded so a runaway turn (a tool loop that thinks for
// thousands of steps) cannot write an unbounded row into a shared table.
// The bridge caps before sending; this cap exists because the server must never
// trust a client's idea of how long its own payload is.
export const REASONING_HISTORY_MAX_CHARS = 16_000;

const TRUNCATION_NOTICE = "\n\n[reasoning truncated]";

/**
 * Normalize and cap reasoning text for storage.
 *
 * Returns null when there is nothing worth storing, so callers can skip the
 * write entirely instead of persisting an empty row. When the text is over the
 * cap the tail is dropped and a visible marker is appended — silently storing a
 * shortened transcript would read as if the model simply stopped thinking.
 */
export function truncateReasoningForStorage(input: unknown): string | null {
    if (typeof input !== "string") return null;
    const text = input.trim();
    if (!text) return null;
    if (text.length <= REASONING_HISTORY_MAX_CHARS) return text;
    const head = text.slice(0, REASONING_HISTORY_MAX_CHARS - TRUNCATION_NOTICE.length);
    return head.trimEnd() + TRUNCATION_NOTICE;
}
