"use client";

import { useState, useSyncExternalStore } from "react";

/** The editor subscribes to text; its parent subscribes only to empty/nonempty. */
export function createComposerStore(initial = "") {
    let text = initial;
    const listeners = new Set<() => void>();
    return {
        get: () => text,
        hasText: () => Boolean(text.trim()),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
        set: (next: string | ((previous: string) => string)) => {
            const value = typeof next === "function" ? next(text) : next;
            if (value === text) return;
            text = value;
            for (const listener of listeners) listener();
        },
    };
}
export type ComposerStore = ReturnType<typeof createComposerStore>;
export function useComposerStore() {
    const [store] = useState(createComposerStore);
    useSyncExternalStore(store.subscribe, store.hasText, () => false);
    return store;
}
