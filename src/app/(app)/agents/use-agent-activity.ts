"use client";

import { useEffect, useState } from "react";
import type { AgentNow } from "@/lib/agent-activity";

const POLL_INTERVAL_MS = 5000;

/**
 * Live "what is each agent doing right now" snapshot, keyed by agentId.
 * Polls the activity endpoint on mount and every 5s, skipping polls while the
 * tab is hidden and refetching immediately when it becomes visible again.
 * Transient failures keep the last good data.
 */
export function useAgentActivity(): Record<string, AgentNow> {
    const [activity, setActivity] = useState<Record<string, AgentNow>>({});

    useEffect(() => {
        let cancelled = false;

        const load = async () => {
            if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
            try {
                const response = await fetch("/api/agents/activity", { cache: "no-store" });
                if (!response.ok || cancelled) return;
                const data = (await response.json()) as { agents: AgentNow[] };
                if (cancelled) return;
                const next: Record<string, AgentNow> = {};
                for (const agent of data.agents) next[agent.agentId] = agent;
                setActivity(next);
            } catch {
                // Transient failure: keep the last good snapshot.
            }
        };

        void load();
        const timer = window.setInterval(load, POLL_INTERVAL_MS);

        const onVisible = () => {
            if (document.visibilityState === "visible") void load();
        };
        document.addEventListener("visibilitychange", onVisible);

        return () => {
            cancelled = true;
            window.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisible);
        };
    }, []);

    return activity;
}
