// Pure logic behind the chat's "agent is working" row.
//
// The Hermes bridge refreshes typing + currentActivity every few seconds while
// a turn runs. A refresh can be late (flaky network, busy bridge thread, long
// tool call), and the server clears currentActivity whenever a refresh arrives
// without one. Without a hold, the live line would blink out on every missed
// beat and the user would think the agent is stuck.

/** How long the last known activity line stays visible after a missed refresh. */
export const LIVE_ACTIVITY_HOLD_MS = 20_000;

/** Upper bound for the activity text kept in memory (the row truncates visually). */
export const LIVE_ACTIVITY_MAX_CHARS = 200;

export type HeldActivity = { text: string; seenAt: number } | null;

/**
 * Normalize an activity line for display: collapse whitespace, keep the
 * original case, and clip overly long text with an ellipsis.
 */
export function clipActivity(text: string | null | undefined, max = LIVE_ACTIVITY_MAX_CHARS): string | null {
    if (typeof text !== "string") return null;
    const clean = text.replace(/\s+/g, " ").trim();
    if (!clean) return null;
    return clean.length > max ? `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…` : clean;
}

/**
 * Fold a fresh activity reading into the held value. A non-empty reading
 * replaces it; an empty one keeps the previous line so a missed refresh does
 * not blank the row (expiry is decided by `visibleActivity`).
 */
export function holdActivity(prev: HeldActivity, incoming: string | null | undefined, now: number): HeldActivity {
    const text = clipActivity(incoming);
    if (text) return { text, seenAt: now };
    return prev;
}

/** The activity line to show right now, or null once the hold has expired. */
export function visibleActivity(held: HeldActivity, now: number, holdMs = LIVE_ACTIVITY_HOLD_MS): string | null {
    if (!held) return null;
    return now - held.seenAt <= holdMs ? held.text : null;
}

/** Compact elapsed label: "4s", "1m 05s", "1h 02m". Negative input reads as 0s. */
export function formatElapsed(ms: number): string {
    const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
    if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    return `${seconds}s`;
}

/**
 * Decide when the elapsed timer restarts. It restarts when work begins after
 * an idle period, or when a different prompt becomes the active one. Moving
 * between "typing only" (no key yet) and a keyed prompt keeps the same start,
 * because both describe the same turn.
 */
export function nextTurnStart(
    prev: { startedAt: number | null; key: string | null },
    input: { active: boolean; key: string | null; now: number },
): { startedAt: number | null; key: string | null } {
    if (!input.active) return { startedAt: null, key: null };
    if (prev.startedAt === null) return { startedAt: input.now, key: input.key };
    if (input.key && prev.key && input.key !== prev.key) return { startedAt: input.now, key: input.key };
    return { startedAt: prev.startedAt, key: input.key ?? prev.key };
}
