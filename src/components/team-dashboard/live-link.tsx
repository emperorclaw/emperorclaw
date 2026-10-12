"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

/**
 * Shared hover/focus link between the Action inbox and the living office:
 * pointing at an inbox item lights the agent's desk, pointing at a desk that
 * needs you lights its inbox items. Plain React state, no DOM queries.
 */
export interface LiveLink {
    /** Member key being pointed at, and which side it came from. */
    key: string | null;
    from: "inbox" | "desk" | null;
    set: (key: string | null, from: "inbox" | "desk") => void;
}

const NONE: LiveLink = { key: null, from: null, set: () => {} };
const LiveLinkContext = createContext<LiveLink>(NONE);

export function LiveLinkProvider({ children }: { children: ReactNode }) {
    const [state, setState] = useState<{ key: string | null; from: "inbox" | "desk" | null }>({ key: null, from: null });
    const value = useMemo<LiveLink>(() => ({
        ...state,
        set: (key, from) => setState((current) => (key === null && current.from !== from ? current : { key, from: key ? from : null })),
    }), [state]);
    return <LiveLinkContext.Provider value={value}>{children}</LiveLinkContext.Provider>;
}

export function useLiveLink(): LiveLink {
    return useContext(LiveLinkContext);
}
