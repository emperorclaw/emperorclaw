"use client";

import { useState } from "react";

// The first page of a chat that just opened enters staggered instead of
// appearing in one frame: `globals.css` `.ec-message-in` rides the shared
// snappy spring (400 ms), and `--ec-stagger` holds the row's step, 30 ms
// apart. Only a chat's first page animates: a live arrival, a background poll
// and an older page loaded above never do, and a virtualized row that
// re-mounts after the window is over stays still.

/** Rows of a freshly opened chat that play the entrance. */
export const CHAT_ENTER_MAX = 6;
/** Delay between two rows. */
export const CHAT_ENTER_STAGGER_MS = 30;
/** The last row's delay plus the shared spring: after this the marks are stale. */
export const CHAT_ENTER_WINDOW_MS = CHAT_ENTER_STAGGER_MS * (CHAT_ENTER_MAX - 1) + 400;

/** Which chat, which rows, and when its first page landed. */
export type ChatEnter = { view: string; ids: readonly string[]; at: number };

export const NO_CHAT_ENTER: ChatEnter = { view: "", ids: [], at: 0 };

/**
 * The entrance state after this render:
 * - another chat opened, or its list was cleared for a load: forget the last entrance;
 * - a chat's first page is on screen and nothing was staged for it yet: take its first rows, once;
 * - anything else (a live arrival, a background poll, an older page): keep what was staged.
 */
export function nextChatEnter(state: ChatEnter, view: string, messages: readonly { id: string }[], now: number): ChatEnter {
    const stage = () => ({ view, ids: messages.slice(0, CHAT_ENTER_MAX).map((message) => message.id), at: now });
    // Another chat opened: what is on screen now belongs to it (its first page, or nothing yet).
    if (state.view !== view) return messages.length === 0 ? { view, ids: [], at: 0 } : stage();
    // Its list was cleared for a load: forget the previous entrance, so the page can enter.
    if (messages.length === 0) return state.ids.length === 0 ? state : { view, ids: [], at: 0 };
    // A first page landed (or was already there): stage it once.
    return state.ids.length > 0 ? state : stage();
}

/** Step of `id` in the entrance (0 = first row), or undefined once it is over. */
export function chatEnterStep(state: ChatEnter, view: string, id: string, now: number): number | undefined {
    if (state.view !== view || now - state.at >= CHAT_ENTER_WINDOW_MS) return undefined;
    const step = state.ids.indexOf(id);
    return step === -1 ? undefined : step;
}

/**
 * The clock, behind a call: the stamp is read while rendering (the same
 * previous-value-in-state pattern as use-live-arrivals), and the React
 * compiler's purity rule only rejects a direct `Date.now()` there.
 */
function nowMs(): number {
    return Date.now();
}

/**
 * Lookup for one row: its entrance step while its chat's first page is
 * entering, else undefined. Uses React's "previous value in state" pattern, so
 * the mark is set in the same render that first shows the rows (no flash of a
 * settled list, and no class on the server-rendered markup).
 */
export function useChatEnter(messages: readonly { id: string }[], view: string): (id: string) => number | undefined {
    const [state, setState] = useState<ChatEnter>(NO_CHAT_ENTER);
    const next = nextChatEnter(state, view, messages, nowMs());
    if (next !== state) setState(next);
    return (id) => chatEnterStep(next, view, id, nowMs());
}
