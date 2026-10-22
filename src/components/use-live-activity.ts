"use client";

import { useEffect, useRef, useState } from "react";
import { clipActivity, formatElapsed, holdActivity, nextTurnStart, visibleActivity, type HeldActivity } from "@/lib/live-activity";

type TurnState = { startedAt: number | null; key: string | null };
const IDLE_TURN: TurnState = { startedAt: null, key: null };

/**
 * Steady state for the chat's "agent is working" row.
 *
 * - `active`: a prompt from the viewer is being handled, or the agent is typing.
 * - `key`: the id of the prompt being handled, when known; a different key
 *   restarts the timer.
 * - `activity`: the latest activity line from the runtime (may be null on a
 *   refresh that carried none).
 *
 * Returns the elapsed label (ticks every second while active) and the activity
 * line. A fresh line shows immediately; when a refresh arrives without one, the
 * last known line stays for up to LIVE_ACTIVITY_HOLD_MS so a late bridge beat
 * does not blank the row.
 *
 * All clock reads happen in the ticker callback, so render stays pure.
 */
export function useLiveActivity({ active, key, activity }: { active: boolean; key: string | null; activity: string | null }) {
    const [now, setNow] = useState(0);
    const [turn, setTurn] = useState<TurnState>(IDLE_TURN);
    const [held, setHeld] = useState<HeldActivity>(null);
    const latestRef = useRef({ key, activity });

    useEffect(() => {
        latestRef.current = { key, activity };
    }, [key, activity]);

    useEffect(() => {
        if (!active) return;
        const tick = () => {
            const t = Date.now();
            const latest = latestRef.current;
            setNow(t);
            setTurn((prev) => nextTurnStart(prev, { active: true, key: latest.key, now: t }));
            setHeld((prev) => holdActivity(prev, latest.activity, t));
        };
        const first = setTimeout(tick, 0);
        const timer = setInterval(tick, 1000);
        return () => {
            clearTimeout(first);
            clearInterval(timer);
            // The turn is over: the next one starts a fresh timer and line.
            setTurn(IDLE_TURN);
            setHeld(null);
        };
    }, [active]);

    if (!active) return { elapsedLabel: null, activity: null };
    const startedAt = turn.startedAt;
    return {
        // "0s" until the first tick has recorded the start of the turn.
        elapsedLabel: formatElapsed(startedAt !== null ? Math.max(now, startedAt) - startedAt : 0),
        activity: clipActivity(activity) ?? visibleActivity(held, now),
    };
}
