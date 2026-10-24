"use client";

import { useState } from "react";
import type { AgentNow } from "@/lib/agent-activity";
import { useLivePoll } from "@/lib/use-realtime";

const POLL_INTERVAL_MS = 5000;

/**
 * Live "what is each agent doing right now" snapshot, keyed by agentId.
 * Refetches on an `agents` invalidation; the timer is a slow fallback while the
 * socket is up (the 5s interval when it is down). Skipped while the tab is
 * hidden; refetched at once when it becomes visible again. Transient failures
 * keep the last good data.
 */
export function useAgentActivity(): Record<string, AgentNow> {
    const [activity, setActivity] = useState<Record<string, AgentNow>>({});

    useLivePoll(async (poll) => {
        if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
        try {
            const response = await fetch("/api/agents/activity", { cache: "no-store" });
            if (!response.ok || !poll.active) return;
            const data = (await response.json()) as { agents: AgentNow[] };
            if (!poll.active) return;
            const next: Record<string, AgentNow> = {};
            for (const agent of data.agents) next[agent.agentId] = agent;
            setActivity(next);
        } catch {
            // Transient failure: keep the last good snapshot.
        }
    }, { fastMs: POLL_INTERVAL_MS, topics: ["agents"] });

    return activity;
}
