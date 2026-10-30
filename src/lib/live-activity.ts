// Pure logic behind the chat's "agent is working" row.
//
// The Hermes bridge refreshes typing + currentActivity every few seconds while
// a turn runs. A refresh can be late (flaky network, busy bridge thread, long
// tool call), and the server clears currentActivity whenever a refresh arrives
// without one. Without a hold, the live line would blink out on every missed
// beat and the user would think the agent is stuck.
//
// Since 0.9 the chat also gets `liveRuns` built from real run events; the
// helpers at the bottom of this file merge and shape them. Everything here is
// pure and client-safe (type-only imports from the server modules).

import type { RunLive, RunLiveUsage, RunStep } from "@/lib/run-events";
import { formatRunDuration, formatTokenCount } from "@/lib/run-ledger-copy";
import { copy, type CodedCopy } from "@/lib/coded-copy";

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

// ─── Live runs (0.9 run events) ─────────────────────────────────────────────

/** Steps kept per live run in the browser (matches RUN_LIVE_MAX_STEPS on the server). */
export const LIVE_RUN_STEPS_KEPT = 8;

/**
 * Poll intervals (docs/design/hermes-persistent-runtime.md §4.7): fast while a
 * run is live, slow when idle. A hidden tab does not poll at all.
 */
export const CHAT_POLL_MS = {
    direct: { active: 1_500, idle: 3_000 },
    team: { active: 2_000, idle: 5_000 },
} as const;

export function chatPollDelayMs(surface: keyof typeof CHAT_POLL_MS, running: boolean): number {
    return running ? CHAT_POLL_MS[surface].active : CHAT_POLL_MS[surface].idle;
}

/**
 * A live run as the browser holds it: plus the client clock when it arrived
 * and when its current step began (stable across polls of the same step, so
 * the step timer does not jitter).
 */
export type ClientLiveRun = RunLive & { receivedAt: number; currentStartedAt: number };

function sameCurrent(a: RunLive["current"], b: RunLive["current"]): boolean {
    return a.kind === b.kind && a.summary === b.summary && (a.toolName ?? null) === (b.toolName ?? null);
}

/**
 * Fold one poll's `liveRuns` into the held list. Steps are merged by seq (a
 * poll with `eventsSince` only carries newer ones) and capped; everything else
 * is replaced. A run missing from the poll has aged out and is dropped. An
 * absent `liveRuns` (older server) keeps nothing.
 */
export function mergeLiveRuns(prev: readonly ClientLiveRun[], incoming: readonly RunLive[] | undefined, receivedAt: number): ClientLiveRun[] {
    if (!incoming) return [];
    const byId = new Map(prev.map((run) => [run.runId, run]));
    return incoming.map((run) => {
        const old = byId.get(run.runId);
        const steps = new Map<number, RunStep>();
        for (const step of old?.steps ?? []) steps.set(step.seq, step);
        for (const step of run.steps ?? []) steps.set(step.seq, step);
        const merged = [...steps.values()].sort((a, b) => a.seq - b.seq).slice(-LIVE_RUN_STEPS_KEPT);
        const currentStartedAt = old && sameCurrent(old.current, run.current)
            ? old.currentStartedAt
            : receivedAt - Math.max(0, run.current.sinceMs);
        return { ...run, steps: merged, receivedAt, currentStartedAt };
    });
}

/** `<runId>:<seq>,…` for the next poll's `eventsSince`, or null when no run has steps yet. */
export function eventsSinceParam(runs: readonly ClientLiveRun[]): string | null {
    const parts: string[] = [];
    for (const run of runs) {
        const last = run.steps[run.steps.length - 1];
        if (last) parts.push(`${run.runId}:${last.seq}`);
    }
    return parts.length > 0 ? parts.join(",") : null;
}

/** The newest still-running run, optionally for one agent. Runs arrive newest first. */
export function runningRun<T extends Pick<RunLive, "status" | "agentId">>(runs: readonly T[], agentId?: string | null): T | null {
    for (const run of runs) {
        if (run.status !== "running") continue;
        if (agentId && run.agentId !== agentId) continue;
        return run;
    }
    return null;
}

/** Kinds whose step timer is worth showing ("Running terminal · npm test · 4s"). */
export function isTimedStepKind(kind: string): boolean {
    return kind === "tool.start" || kind === "tool.progress" || kind === "tool.prepare" || kind === "compaction.start" || kind === "subagent.start";
}

/** The last reasoning line among the steps, unless reasoning is already the current line. */
export function lastReasoningLine(run: Pick<RunLive, "steps" | "current">): string | null {
    if (run.current.kind === "reasoning") return null;
    for (let i = run.steps.length - 1; i >= 0; i--) {
        const step = run.steps[i];
        if (step.kind === "reasoning" && step.summary) return clipActivity(`Thinking · ${step.summary}`);
    }
    return null;
}

/** lastReasoningLine as coded copy (runTimeline.thinkingLine), for the viewer's language. */
export function lastReasoningCopy(run: Pick<RunLive, "steps" | "current">): CodedCopy | null {
    if (run.current.kind === "reasoning") return null;
    for (let i = run.steps.length - 1; i >= 0; i--) {
        const step = run.steps[i];
        if (step.kind === "reasoning" && step.summary) {
            const summary = clipActivity(step.summary, LIVE_ACTIVITY_MAX_CHARS - "Thinking · ".length);
            return summary ? copy("runTimeline.thinkingLine", { summary }) : null;
        }
    }
    return null;
}

/**
 * The part of an activity line worth announcing to a screen reader: the step
 * itself ("Thinking", "Running write_file", "write_file done"), without the
 * reasoning text or tool target after " · ". Consecutive reasoning beats share
 * one headline, so a live region keyed on it speaks once per step, not once
 * per streamed thought.
 */
export function stepHeadline(line: string | null | undefined): string | null {
    const clean = clipActivity(line);
    if (!clean) return null;
    const head = clean.split(" · ")[0].replace(/(?:…|\.\.\.)$/, "").trim();
    return head || clean;
}

// ─── Timeline rows ──────────────────────────────────────────────────────────

/** A step as the timeline endpoint returns it: any event kind, not just live step kinds. */
export interface TimelineStep {
    seq: number;
    ts: string;
    kind: string;
    toolName?: string;
    toolCallId?: string;
    status?: string;
    durationMs?: number;
    summary?: string;
}

export type TimelineRowKind = "tool" | "reasoning" | "compaction" | "notice" | "subagent" | "approval" | "end";
export type TimelineRowStatus = "running" | "ok" | "error" | "interrupted" | "info";

export interface TimelineRow {
    key: string;
    kind: TimelineRowKind;
    label: string;
    /** The label as coded copy (runTimeline.rows.*); tool rows show the tool name and have none. */
    labelCopy?: CodedCopy;
    detail: string | null;
    status: TimelineRowStatus;
    durationMs: number | null;
    ts: string;
}

const row = (key: string) => copy(`runTimeline.rows.${key}`);

function rowStatus(status: string | undefined, fallback: TimelineRowStatus): TimelineRowStatus {
    if (status === "ok" || status === "error" || status === "interrupted" || status === "running") return status;
    return fallback;
}

/**
 * Turn raw steps into timeline rows. A `tool.end` closes its `tool.start`
 * (paired by toolCallId, else by the oldest open start of the same tool), so a
 * tool reads as one row: running, then done with its duration. `notice`
 * events are muted lines.
 */
export function timelineRows(steps: readonly TimelineStep[]): TimelineRow[] {
    const ordered = [...steps].sort((a, b) => a.seq - b.seq);
    const rows: TimelineRow[] = [];
    const openById = new Map<string, number>();
    const openByName = new Map<string, number[]>();
    const closeOpen = (index: number, name: string, callId: string | undefined) => {
        if (callId) openById.delete(callId);
        const list = openByName.get(name);
        if (list) openByName.set(name, list.filter((i) => i !== index));
    };

    for (const step of ordered) {
        const key = `s${step.seq}`;
        const base = { key, detail: step.summary ?? null, durationMs: step.durationMs ?? null, ts: step.ts };
        switch (step.kind) {
            case "tool.prepare":
            case "tool.start": {
                const name = step.toolName || "tool";
                const existing = step.toolCallId ? openById.get(step.toolCallId) : undefined;
                if (existing != null) {
                    // tool.start after tool.prepare for the same call: one row.
                    rows[existing] = { ...rows[existing], detail: base.detail ?? rows[existing].detail };
                    break;
                }
                rows.push({ ...base, kind: "tool", label: name, status: "running", durationMs: null });
                const index = rows.length - 1;
                if (step.toolCallId) openById.set(step.toolCallId, index);
                openByName.set(name, [...(openByName.get(name) ?? []), index]);
                break;
            }
            case "tool.end": {
                const name = step.toolName || "tool";
                let index = step.toolCallId ? openById.get(step.toolCallId) : undefined;
                if (index == null) index = openByName.get(name)?.[0];
                const status = rowStatus(step.status, "ok");
                if (index != null) {
                    rows[index] = { ...rows[index], status, durationMs: base.durationMs, detail: base.detail ?? rows[index].detail };
                    closeOpen(index, name, step.toolCallId);
                } else {
                    rows.push({ ...base, kind: "tool", label: name, status });
                }
                break;
            }
            case "reasoning":
                rows.push({ ...base, kind: "reasoning", label: "Thinking", labelCopy: row("thinking"), status: "info", durationMs: null });
                break;
            case "notice":
                rows.push({ ...base, kind: "notice", label: "Note", labelCopy: row("note"), status: "info", durationMs: null });
                break;
            case "compaction.start":
                rows.push({ ...base, kind: "compaction", label: "Tidying memory", labelCopy: row("tidyingMemory"), detail: null, status: "running", durationMs: null });
                break;
            case "compaction.end": {
                let open = -1;
                for (let i = rows.length - 1; i >= 0; i--) {
                    if (rows[i].kind === "compaction" && rows[i].status === "running") { open = i; break; }
                }
                const done = { label: "Memory tidied", labelCopy: row("memoryTidied"), status: rowStatus(step.status, "ok"), durationMs: base.durationMs };
                if (open >= 0) rows[open] = { ...rows[open], ...done };
                else rows.push({ ...base, kind: "compaction", detail: null, ...done });
                break;
            }
            case "subagent.start":
                rows.push({ ...base, kind: "subagent", label: "Delegating", labelCopy: row("delegating"), status: "running" });
                break;
            case "subagent.end":
                rows.push({ ...base, kind: "subagent", label: "Subagent finished", labelCopy: row("subagentFinished"), status: rowStatus(step.status, "ok") });
                break;
            case "approval.auto":
                rows.push({ ...base, kind: "approval", label: "Auto-approved", labelCopy: row("autoApproved"), status: "info", durationMs: null });
                break;
            case "clarify.auto":
                rows.push({ ...base, kind: "approval", label: "Proceeded with best judgment", labelCopy: row("bestJudgment"), status: "info", durationMs: null });
                break;
            case "turn.failed":
                rows.push({ ...base, kind: "end", label: "Failed", labelCopy: row("failed"), status: "error" });
                break;
            case "turn.interrupted":
                rows.push({ ...base, kind: "end", label: "Stopped", labelCopy: row("stopped"), status: "interrupted" });
                break;
            default:
                break;
        }
    }
    return rows;
}

// ─── Copy ───────────────────────────────────────────────────────────────────

/** "Worked 42s · 6 tools · 18.2k tokens · deepseek-v4" for an agent reply footer. */
export function runFooterSummary(run: {
    durationMs?: number | null;
    toolCalls?: number | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    model?: string | null;
}): string | null {
    const parts: string[] = [];
    if (run.durationMs != null && run.durationMs >= 0) parts.push(`Worked ${formatRunDuration(run.durationMs)}`);
    if (run.toolCalls != null && run.toolCalls > 0) parts.push(`${run.toolCalls} ${run.toolCalls === 1 ? "tool" : "tools"}`);
    const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
    if (tokens > 0) parts.push(`${formatTokenCount(tokens)} tokens`);
    const model = run.model?.trim();
    if (model) parts.push(model.length > 40 ? `${model.slice(0, 39)}…` : model);
    return parts.length > 0 ? parts.join(" · ") : null;
}

/** "18.2k in · 900 out · 12k cached · 41% context" for live usage. */
export function liveUsageLine(usage: RunLiveUsage | null | undefined): string | null {
    if (!usage) return null;
    const parts = [`${formatTokenCount(usage.input)} in`, `${formatTokenCount(usage.output)} out`];
    if (usage.cacheRead > 0) parts.push(`${formatTokenCount(usage.cacheRead)} cached`);
    if (usage.contextPercent != null) parts.push(`${usage.contextPercent}% context`);
    return parts.join(" · ");
}

/** Share of prompt tokens served from the provider cache (0–100), or null. */
export function cacheHitPercent(inputTokens: number | null | undefined, cacheReadTokens: number | null | undefined): number | null {
    if (inputTokens == null || cacheReadTokens == null || inputTokens <= 0 || cacheReadTokens < 0) return null;
    return Math.min(100, Math.round((cacheReadTokens / inputTokens) * 100));
}

// ─── Bridge version badges (§4.6) ───────────────────────────────────────────

/** Where the 0.9 upgrade guide lives (src/content/docs/v1.1/hermes-migration-0.9.md). */
export const HERMES_MIGRATION_DOC_HREF = "/docs/v1.1/hermes-migration-0-9";

export type BridgeBadgeState = "current" | "update-available" | "unsupported" | "legacy";

export interface BridgeBadgeCopy {
    label: string;
    tone: "ok" | "warn" | "bad" | "muted";
    /** Tooltip text. */
    hint: string;
    /** Whether to offer the upgrade guide. */
    showGuide: boolean;
}

/** Badge copy for a runtime's bridge version. Managed agents update by recreating the runtime. */
export function bridgeBadgeCopy(state: BridgeBadgeState, version: string | null, managed: boolean): BridgeBadgeCopy {
    const update = managed ? "Recreate the runtime to update." : "Run `emperor-hermes update`.";
    switch (state) {
        case "current":
            return { label: version ? `Bridge ${version}` : "Bridge current", tone: "ok", hint: "The runtime bridge is up to date.", showGuide: false };
        case "update-available":
            return { label: "Update available", tone: "warn", hint: `Bridge ${version ?? "?"} is older than the latest release. ${update}`, showGuide: true };
        case "unsupported":
            return { label: "Unsupported bridge", tone: "bad", hint: `Bridge ${version ?? "?"} is no longer supported. ${update}`, showGuide: true };
        case "legacy":
        default:
            return { label: "Legacy bridge", tone: "muted", hint: `0.3.x is deprecated and stops working in 0.10.0. ${update}`, showGuide: true };
    }
}
