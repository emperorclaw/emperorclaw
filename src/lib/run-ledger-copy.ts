/**
 * Presentation copy for the run ledger — the delivery inspector and the Agent →
 * Runs tab (PR 4).
 *
 * Pure and dependency-free so it is unit-tested directly and shared by every
 * surface that renders a verdict or a run. Nothing here touches the database:
 * the server stores raw values (`route_reason`, `status`) and this module is the
 * single place the user-facing wording lives. Every `RouteReason` in
 * `src/lib/message-routing.ts` is mapped; an unknown value falls back to the raw
 * value so a newly introduced reason is still visible, never blank.
 */

import { copy, type CodedCopy } from "@/lib/coded-copy";

/** A stored delivery verdict, as `GET /api/messages/[id]/delivery` returns it. */
export interface DeliveryVerdictCopyInput {
    addressed: boolean;
    routeReason: string;
    agentStreak: number;
    maxTurns: number;
}

export interface DeliveryVerdictCopy {
    /** The one-word outcome, so a surface can colour/icon it independently of the detail. */
    outcome: "delivered" | "not_delivered";
    /** The full plain-language sentence shown to the user. */
    label: string;
}

/**
 * routeReason → plain language. The loop-guard reason names the streak and cap
 * that tripped it (`13 of 12 agent messages without a human`), because that is
 * the only way "paused" reads as a decision rather than a failure.
 */
export function deliveryVerdictCopy(verdict: DeliveryVerdictCopyInput): DeliveryVerdictCopy {
    const { routeReason, agentStreak, maxTurns } = verdict;
    const delivered = verdict.addressed;
    switch (routeReason) {
        case "self":
            return { outcome: "not_delivered", label: "Not delivered — the agent's own message" };
        case "targeted":
            return { outcome: "delivered", label: "Delivered — directed to this agent" };
        case "targeted_other":
            return { outcome: "not_delivered", label: "Not delivered — addressed to another agent" };
        case "direct":
            return { outcome: "delivered", label: "Delivered — direct message" };
        case "mention":
            return { outcome: "delivered", label: "Delivered — mentioned" };
        case "all":
            return { outcome: "delivered", label: "Delivered — @all in the group" };
        case "agent_pair":
            return { outcome: "delivered", label: "Delivered — pair handoff" };
        case "task_assigned":
            return { outcome: "delivered", label: "Delivered — task assigned" };
        case "not_addressed":
            return { outcome: "not_delivered", label: "Not delivered — not addressed" };
        case "out_of_scope":
            return { outcome: "not_delivered", label: "Not delivered — the sender's agent scope does not reach this agent" };
        case "loop_paused":
            return {
                outcome: "not_delivered",
                label: `Not delivered — paused by the loop guard (${agentStreak} of ${maxTurns} agent messages without a human)`,
            };
        default:
            return {
                outcome: delivered ? "delivered" : "not_delivered",
                label: `${delivered ? "Delivered" : "Not delivered"} — ${routeReason}`,
            };
    }
}

const KNOWN_ROUTE_REASONS = new Set(["self", "targeted", "targeted_other", "direct", "mention", "all", "agent_pair", "task_assigned", "not_addressed", "out_of_scope", "loop_paused"]);

/** deliveryVerdictCopy's label as coded copy (delivery.verdicts.*), for the viewer's language. */
export function deliveryVerdictMessage(verdict: DeliveryVerdictCopyInput): CodedCopy {
    const { routeReason, agentStreak, maxTurns } = verdict;
    if (routeReason === "loop_paused") return copy("delivery.verdicts.loop_paused", { streak: agentStreak, max: maxTurns });
    if (KNOWN_ROUTE_REASONS.has(routeReason)) return copy(`delivery.verdicts.${routeReason}`);
    return copy(verdict.addressed ? "delivery.verdicts.otherDelivered" : "delivery.verdicts.otherNotDelivered", { reason: routeReason });
}

/** Shown when a message has no stored verdict row. */
export const NO_DELIVERY_VERDICT_COPY =
    "No delivery decision recorded — this message predates the ledger or addressed nobody";

/** `81_000 → "81k"`, `420 → "420"`, `1_200_000 → "1.2M"`. */
export function formatTokenCount(tokens: number | null | undefined): string {
    if (tokens === null || tokens === undefined || !Number.isFinite(tokens) || tokens < 0) return "—";
    if (tokens < 1_000) return String(Math.round(tokens));
    if (tokens < 1_000_000) {
        const k = tokens / 1_000;
        return `${k >= 100 ? Math.round(k) : trimTrailingZero(k.toFixed(1))}k`;
    }
    const m = tokens / 1_000_000;
    return `${m >= 100 ? Math.round(m) : trimTrailingZero(m.toFixed(1))}M`;
}

/** `(81_000, 420) → "81k in · 420 out"`; a missing side reads "—". */
export function formatRunTokens(input: number | null | undefined, output: number | null | undefined): string {
    const hasInput = input !== null && input !== undefined && Number.isFinite(input);
    const hasOutput = output !== null && output !== undefined && Number.isFinite(output);
    if (!hasInput && !hasOutput) return "—";
    return `${formatTokenCount(input)} in · ${formatTokenCount(output)} out`;
}

/** `123_000 → "2m 03s"`, `8_400 → "8s"`, `3_720_000 → "1h 02m"`. */
export function formatRunDuration(ms: number | null | undefined): string {
    if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "—";
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    const totalSeconds = Math.round(ms / 1_000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export type RunStatusTone = "ok" | "bad" | "warn" | "info" | "muted";

export interface RunStatusCopy {
    label: string;
    tone: RunStatusTone;
}

/** Status → label plus a tone the surface maps to both a colour and an icon. */
export function runStatusCopy(status: string): RunStatusCopy {
    switch (status) {
        case "succeeded":
            return { label: "Succeeded", tone: "ok" };
        case "failed":
            return { label: "Failed", tone: "bad" };
        case "timeout":
            return { label: "Timed out", tone: "warn" };
        case "cancelled":
            return { label: "Cancelled", tone: "muted" };
        case "blocked":
            return { label: "Blocked", tone: "warn" };
        case "lost":
            return { label: "Lost", tone: "bad" };
        case "running":
            return { label: "Running", tone: "info" };
        default:
            return { label: status || "Unknown", tone: "muted" };
    }
}

/** Trigger kind → human label. */
export function triggerKindLabel(kind: string | null | undefined): string {
    switch (kind) {
        case "message":
            return "Message";
        case "task":
            return "Task";
        case "objective":
            return "Objective";
        case "other":
            return "Other";
        default:
            return kind || "Unknown";
    }
}

/** One day of `agent_run_daily`, as the Agent → Runs tab reads it. */
export interface RunDailyInput {
    runs: number;
    succeeded: number;
    failed: number;
    timeout: number;
    lost: number;
    p50Ms: number | null;
    p95Ms: number | null;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    toolCalls: number;
}

export interface RunsSummary {
    runs: number;
    succeeded: number;
    /** failed + timeout + lost — every terminal run that did not succeed. */
    unsuccessful: number;
    /** succeeded / terminal runs, or null when there is nothing to divide. */
    successRate: number | null;
    /** Run-weighted mean of the daily rollup percentiles; null with no samples. */
    p50Ms: number | null;
    p95Ms: number | null;
    inputTokens: number;
    outputTokens: number;
    costCents: number;
    toolCalls: number;
}

/**
 * Headline stats over the 30-day rollup window.
 *
 * Percentiles are not additive, so `p50`/`p95` are a run-weighted mean of each
 * day's stored percentile — an approximation of the window's percentile, honest
 * about its inputs. Every other figure is a plain sum.
 */
export function summarizeRunDaily(days: RunDailyInput[]): RunsSummary {
    let runs = 0;
    let succeeded = 0;
    let failed = 0;
    let timeout = 0;
    let lost = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costCents = 0;
    let toolCalls = 0;
    let p50Sum = 0;
    let p50Weight = 0;
    let p95Sum = 0;
    let p95Weight = 0;

    for (const day of days) {
        runs += day.runs;
        succeeded += day.succeeded;
        failed += day.failed;
        timeout += day.timeout;
        lost += day.lost;
        inputTokens += day.inputTokens;
        outputTokens += day.outputTokens;
        costCents += day.costCents;
        toolCalls += day.toolCalls;
        const weight = Math.max(0, day.runs || 0);
        if (day.p50Ms !== null && Number.isFinite(day.p50Ms) && weight > 0) {
            p50Sum += day.p50Ms * weight;
            p50Weight += weight;
        }
        if (day.p95Ms !== null && Number.isFinite(day.p95Ms) && weight > 0) {
            p95Sum += day.p95Ms * weight;
            p95Weight += weight;
        }
    }

    const unsuccessful = failed + timeout + lost;
    const terminal = succeeded + unsuccessful;
    return {
        runs,
        succeeded,
        unsuccessful,
        successRate: terminal > 0 ? succeeded / terminal : null,
        p50Ms: p50Weight > 0 ? p50Sum / p50Weight : null,
        p95Ms: p95Weight > 0 ? p95Sum / p95Weight : null,
        inputTokens,
        outputTokens,
        costCents,
        toolCalls,
    };
}

function trimTrailingZero(value: string): string {
    return value.endsWith(".0") ? value.slice(0, -2) : value;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether an id is a persisted UUID. Optimistic/pending chat bubbles carry a
 * temporary id, and the delivery endpoint rejects anything that is not a UUID —
 * so the Delivery action is only offered for real, stored messages.
 */
export function isPersistedUuid(id: string | null | undefined): boolean {
    return typeof id === "string" && UUID_RE.test(id);
}

/** One day of `agent_run_daily` plus its calendar day, as the chart reads it. */
export interface RunDailyDay extends RunDailyInput {
    day: string;
}

export interface RunChartDay {
    day: string;
    succeeded: number;
    unsuccessful: number;
    /** Whether a rollup row exists for the day, so "zero runs" reads apart from "no data". */
    hasData: boolean;
}

/**
 * The last `windowDays` UTC calendar days, oldest first, as a dense series the
 * chart can draw without gaps. Days come from `Date.UTC` and the keys use
 * `toISOString`, so the window and the rollup's `day` column are the same UTC
 * calendar. A missing rollup is `hasData: false`; a stored zero-run day is
 * `hasData: true` with zero counts.
 */
export function buildDailyWindow(daily: RunDailyDay[], windowDays: number, now: Date = new Date()): RunChartDay[] {
    const byDay = new Map(daily.map((row) => [row.day, row]));
    const out: RunChartDay[] = [];
    const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    for (let i = windowDays - 1; i >= 0; i--) {
        const key = new Date(base - i * 86_400_000).toISOString().slice(0, 10);
        const row = byDay.get(key);
        out.push({
            day: key,
            succeeded: row?.succeeded ?? 0,
            unsuccessful: (row?.failed ?? 0) + (row?.timeout ?? 0) + (row?.lost ?? 0),
            hasData: row !== undefined,
        });
    }
    return out;
}

/** The `?status=&cursor=` query the Runs tab appends to its endpoint. Pure. */
export function buildRunsQuery(params: { status?: string | null; cursor?: string | null }): string {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.cursor) search.set("cursor", params.cursor);
    return search.toString();
}

/**
 * The messaging-hub deep link for a run's triggering thread, or null when the
 * hub cannot honour it. `?group=` only opens group threads and `?agent=` only
 * direct ones; the team thread has no param, so it stays plain text.
 */
export function runThreadLink(run: {
    threadId: string | null;
    threadType: string | null;
    agentId: string | null;
}): string | null {
    if (!run.threadId) return null;
    if (run.threadType === "group") return `/messages?group=${encodeURIComponent(run.threadId)}`;
    if (run.threadType === "direct" && run.agentId) return `/messages?agent=${encodeURIComponent(run.agentId)}`;
    return null;
}
