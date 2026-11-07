"use client";

import { useState } from "react";

// New chat messages slide in (globals.css `.ec-message-in`) only when they
// arrive after the thread has loaded: appended at the end, never history,
// never older pages loaded above, and never a virtualized row re-mounting as
// it scrolls back into view (the mark expires right after the animation).

/** How long a live arrival keeps its entrance class (the snappy spring is 400 ms). */
export const ARRIVAL_WINDOW_MS = 700;

const arrivedAt = new Map<string, number>();

/** Which ids are new at the end of `next` (after the last message of `prev`); none on a first load or a thread switch. */
export function appendedIds(prev: readonly { id: string }[], next: readonly { id: string }[]): string[] {
    if (prev.length === 0) return [];
    const anchor = next.findIndex((message) => message.id === prev[prev.length - 1].id);
    if (anchor < 0) return [];
    const known = new Set(prev.map((message) => message.id));
    return next.slice(anchor + 1).filter((message) => !known.has(message.id)).map((message) => message.id);
}

function isFreshArrival(id: string): boolean {
    const at = arrivedAt.get(id);
    return at !== undefined && Date.now() - at < ARRIVAL_WINDOW_MS;
}

/** Stamp the messages appended since `prev` (idempotent: a message is stamped once). */
function recordArrivals(prev: readonly { id: string }[], next: readonly { id: string }[]): void {
    const now = Date.now();
    if (arrivedAt.size > 200) {
        for (const [id, at] of arrivedAt) if (now - at > ARRIVAL_WINDOW_MS) arrivedAt.delete(id);
    }
    for (const id of appendedIds(prev, next)) {
        if (!arrivedAt.has(id)) arrivedAt.set(id, now);
    }
}

/**
 * Track live arrivals for a message list and return a lookup: true while a
 * message should play its entrance. Uses React's "previous value in state"
 * pattern so the mark is set in the same render that first shows the row.
 */
export function useLiveArrivals(messages: readonly { id: string }[]): (id: string) => boolean {
    const [previous, setPrevious] = useState(messages);
    if (previous !== messages) {
        recordArrivals(previous, messages);
        setPrevious(messages);
    }
    return isFreshArrival;
}
