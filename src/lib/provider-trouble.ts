/**
 * "Online · model unreachable": an agent's runtime can be connected (Online)
 * while every turn fails on the model provider (an outage, a revoked key, a
 * model that went away). The heartbeat alone says Online, so the Agents page
 * reads the agent's latest finished runs too. Pure, unit-tested.
 */
import { classifyFailure, failureHeadline, failureHeadlineCopy, type FailureCause } from "@/lib/failure-cause";
import { copy, type CodedCopy } from "@/lib/coded-copy";

/** Causes that live at the model provider, not in Emperor or the runtime. */
export const PROVIDER_CAUSES: ReadonlySet<FailureCause> = new Set([
    "provider_unreachable", "provider_auth", "provider_credits", "model_unavailable", "rate_limited",
]);

/** How many of the latest finished runs are read (to count the failures in a row). */
export const PROVIDER_TROUBLE_RUNS = 5;
/** Only recent runs count: an old failure says nothing about the provider now. */
export const PROVIDER_TROUBLE_WINDOW_MS = 60 * 60 * 1000;

export type ProviderTrouble = { cause: FailureCause; headline: string; failedRuns: number; since: string };

export type RunOutcome = { status: string; error: string | null; exitReason: string | null; startedAt: Date | string; endedAt: Date | string | null };

const FAILED_STATUSES = new Set(["failed", "timeout", "lost"]);

const toMs = (value: Date | string | null) => (value == null ? NaN : value instanceof Date ? value.getTime() : Date.parse(value));

/**
 * The provider problem behind the agent's latest finished run, or null: the
 * newest run that ended inside the window failed with a provider cause (a
 * success since then clears it). `failedRuns` counts those failures in a row.
 */
export function providerTroubleFromRuns(runs: readonly RunOutcome[], now: Date = new Date()): ProviderTrouble | null {
    const recent = runs
        .filter((run) => run.status !== "running" && Number.isFinite(toMs(run.endedAt ?? run.startedAt)) && now.getTime() - toMs(run.endedAt ?? run.startedAt) <= PROVIDER_TROUBLE_WINDOW_MS)
        .sort((a, b) => toMs(b.endedAt ?? b.startedAt) - toMs(a.endedAt ?? a.startedAt))
        .slice(0, PROVIDER_TROUBLE_RUNS);
    const causes = recent.map((run) => FAILED_STATUSES.has(run.status)
        ? classifyFailure({ texts: [run.error, run.exitReason], runStatus: run.status })
        : null);
    const streak = causes.findIndex((cause) => !cause || !PROVIDER_CAUSES.has(cause));
    const failedRuns = streak === -1 ? causes.length : streak;
    if (failedRuns === 0) return null;
    const cause = causes[0]!;
    const oldest = recent[failedRuns - 1];
    return { cause, headline: failureHeadline(cause), failedRuns, since: new Date(toMs(oldest.endedAt ?? oldest.startedAt)).toISOString() };
}

/** The short suffix after "Online · ". */
export function providerTroubleLabel(cause: FailureCause): string {
    switch (cause) {
        case "provider_unreachable": return "model unreachable";
        case "provider_auth": return "model key rejected";
        case "provider_credits": return "provider out of credits";
        case "model_unavailable": return "model unavailable";
        case "rate_limited": return "rate limited";
        default: return "model failing";
    }
}

/** providerTroubleLabel as coded copy (failures.trouble.*), for the viewer's language. */
export function providerTroubleLabelCopy(cause: FailureCause): CodedCopy {
    return copy(`failures.trouble.${PROVIDER_CAUSES.has(cause) ? cause : "other"}`);
}

/** The trouble's headline as coded copy (failures.headlines.*). */
export function providerTroubleHeadlineCopy(cause: FailureCause): CodedCopy {
    return failureHeadlineCopy(cause);
}
