import { z } from "zod";
import { and, desc, eq, gt, gte, inArray, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRunEvents, agentRuns, messageThreads, threadParticipants } from "@/db/schema";
import { cleanSnippet, redactSensitive } from "@/lib/live-feed-v2";
import { clampRunTimestamp, isTerminalRunStatus, startRunSchema } from "@/lib/run-ledger";

/**
 * Run events (0.9): the live steps of one agent run, streamed by the runtime
 * in batches to POST /api/mcp/agents/runs/[id]/events and read back by chat
 * (`liveRuns`), the Right now card and the run timeline.
 *
 * The exported types are the cross-stream contract (docs/design/
 * hermes-persistent-runtime.md §4.2, §4.3, §4.7). Change them only together
 * with that document. Validation, caps, the activity line and the live-run
 * read model live here (not in routes) so they are unit-testable without a
 * database.
 */

// ─── Event kinds (bridge → server, §4.3) ────────────────────────────────────

export const RUN_EVENT_KINDS = [
    "turn.queued",
    "turn.started",
    "reasoning",
    "notice",
    "tool.prepare",
    "tool.start",
    "tool.progress",
    "tool.end",
    "status",
    "usage",
    "subagent.start",
    "subagent.end",
    "approval.auto",
    "clarify.auto",
    "compaction.start",
    "compaction.end",
    "turn.completed",
    "turn.failed",
    "turn.interrupted",
] as const;
export type RunEventKind = (typeof RUN_EVENT_KINDS)[number];

/** Kinds that end a turn. They clear the agent's typing row. */
export const TERMINAL_RUN_EVENT_KINDS = ["turn.completed", "turn.failed", "turn.interrupted"] as const satisfies readonly RunEventKind[];
export type TerminalRunEventKind = (typeof TERMINAL_RUN_EVENT_KINDS)[number];

/** Kinds dropped first when a run (or a bridge spool) is over its cap. */
export const DROPPABLE_RUN_EVENT_KINDS = ["reasoning", "tool.progress", "usage", "notice"] as const satisfies readonly RunEventKind[];

export const RUN_EVENT_STATUSES = ["ok", "error", "running", "interrupted"] as const;
export type RunEventStatus = (typeof RUN_EVENT_STATUSES)[number];

export function isRunEventKind(value: string): value is RunEventKind {
    return (RUN_EVENT_KINDS as readonly string[]).includes(value);
}

export function isTerminalRunEventKind(kind: string): kind is TerminalRunEventKind {
    return (TERMINAL_RUN_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isDroppableRunEventKind(kind: string): boolean {
    return (DROPPABLE_RUN_EVENT_KINDS as readonly string[]).includes(kind);
}

// ─── Per-kind `data` payloads (all optional; unknown keys are kept, redacted) ─

export interface TurnQueuedData { position?: number; coalesced?: number }
export interface TurnStartedData { queueMs?: number }
/**
 * Tool events carry Hermes' own short label (`context`, e.g. `hostname`) in
 * `summary`, never raw args. `target` is a rev-1 fallback, still read.
 */
export interface ToolStartData { target?: string }
/** First line of the result (≤ 160 chars, redacted), only when the tool errored. */
export interface ToolEndData { preview?: string }
export interface ToolProgressData { percent?: number }
/** `kind` is the Hermes status kind, e.g. `compacting`. */
export interface StatusData { kind?: string }
export interface UsageData {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    calls?: number;
    contextUsed?: number;
    contextMax?: number;
    contextPercent?: number;
    model?: string;
    costUsd?: number;
}
export interface SubagentData { name?: string }
export interface CompactionData { before?: number; after?: number }
/** `exitReason` = receipt `turn_exit_reason`; `steps` = Hermes `agent.step` count. */
export interface TurnEndData { exitReason?: string; failureReason?: string; steps?: number }

export interface RunEventDataByKind {
    "turn.queued": TurnQueuedData;
    "turn.started": TurnStartedData;
    reasoning: Record<string, never>;
    notice: Record<string, never>;
    "tool.prepare": Record<string, never>;
    "tool.start": ToolStartData;
    "tool.progress": ToolProgressData;
    "tool.end": ToolEndData;
    status: StatusData;
    usage: UsageData;
    "subagent.start": SubagentData;
    "subagent.end": SubagentData;
    "approval.auto": Record<string, never>;
    "clarify.auto": Record<string, never>;
    "compaction.start": CompactionData;
    "compaction.end": CompactionData;
    "turn.completed": TurnEndData;
    "turn.failed": TurnEndData;
    "turn.interrupted": TurnEndData;
}

// ─── Limits ─────────────────────────────────────────────────────────────────

/** Request body cap for one batch (UTF-8 bytes). */
export const RUN_EVENTS_BODY_MAX_BYTES = 128 * 1024;
/** Events per batch. */
export const RUN_EVENTS_BATCH_MAX = 200;
/** Events stored per run. Over it, droppable kinds go first. */
export const RUN_EVENTS_PER_RUN_MAX = 2_000;
export const RUN_EVENT_SUMMARY_MAX_CHARS = 500;
export const RUN_EVENT_DATA_MAX_BYTES = 2 * 1024;
export const RUN_EVENT_TOOL_NAME_MAX_CHARS = 100;
export const RUN_EVENT_TOOL_CALL_ID_MAX_CHARS = 200;
/** Events for a finished run are accepted this long after `ended_at` (late flushes). */
export const RUN_EVENTS_LATE_ACCEPT_MS = 10 * 60 * 1000;
/** `thread_participants.typingUntil` window set by a non-terminal event. */
export const RUN_EVENT_TYPING_TTL_MS = 20_000;
export const RUN_ACTIVITY_MAX_CHARS = 200;
/** Per-agent ingestion rate limit (requests per minute). */
export const RUN_EVENTS_PER_MINUTE = 1_200;

// ─── Wire schema (§4.2) ─────────────────────────────────────────────────────

const isoDate = z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "must be an ISO-8601 timestamp",
});

/**
 * One event as sent by the runtime. Zod objects strip unknown keys, so a newer
 * bridge's extra fields are dropped, never rejected. An unknown `kind` is
 * rejected (the batch is retried by the bridge, so a typo surfaces fast).
 * Text fields are accepted generously here and capped/redacted on store.
 */
export const runEventInputSchema = z.object({
    id: z.string().uuid(),
    seq: z.number().int().min(0).max(2_000_000_000),
    ts: isoDate,
    kind: z.enum(RUN_EVENT_KINDS),
    toolName: z.string().max(1_000).nullish(),
    toolCallId: z.string().max(1_000).nullish(),
    status: z.enum(RUN_EVENT_STATUSES).nullish(),
    durationMs: z.number().int().min(0).max(2_000_000_000).nullish(),
    summary: z.string().max(20_000).nullish(),
    data: z.record(z.string(), z.unknown()).nullish(),
});
export type RunEventInput = z.infer<typeof runEventInputSchema>;

/** POST /api/mcp/agents/runs/[id]/events body. `run` = the start payload. */
export const runEventBatchSchema = z.object({
    run: startRunSchema.optional(),
    events: z.array(runEventInputSchema).max(RUN_EVENTS_BATCH_MAX),
});
export type RunEventBatch = z.infer<typeof runEventBatchSchema>;

/** 200 response of the ingestion endpoint. */
export interface RunEventIngestResult {
    accepted: number;
    duplicates: number;
    /** Events dropped by the per-run cap (also added to `agent_runs.events_dropped`). */
    dropped: number;
    /** Highest seq stored for this run (−1 when none). */
    lastSeq: number;
    runStatus: string;
}

// ─── Read model for the browser (§4.7) ──────────────────────────────────────

/** Kinds that become timeline steps in `RunLive.steps`. */
export const RUN_STEP_KINDS = ["tool.start", "tool.end", "reasoning", "notice", "compaction.start", "compaction.end"] as const satisfies readonly RunEventKind[];
export type RunStepKind = (typeof RUN_STEP_KINDS)[number];
/** `RunLive.steps` holds at most this many (newest last). */
export const RUN_LIVE_MAX_STEPS = 8;
/** A finished run stays in `liveRuns` this long after it ended. */
export const RUN_LIVE_RECENT_MS = 60_000;

export interface RunStep {
    seq: number;
    /** ISO-8601 event time. */
    ts: string;
    kind: RunStepKind;
    toolName?: string;
    toolCallId?: string;
    status?: RunEventStatus;
    durationMs?: number;
    summary?: string;
}

export interface RunCurrent {
    kind: RunEventKind;
    toolName?: string;
    /** One display line, ≤ 200 chars (e.g. `Running terminal · npm test`). */
    summary: string;
    /** Milliseconds since that event (drives the ticking timer). */
    sinceMs: number;
}

export interface RunLiveUsage {
    input: number;
    output: number;
    cacheRead: number;
    /** contextUsed / contextMax × 100, rounded; null when unknown. */
    contextPercent: number | null;
}

export interface RunLive {
    runId: string;
    agentId: string | null;
    triggerMessageId: string | null;
    status: string;
    /** ISO-8601. */
    startedAt: string;
    endedAt?: string;
    current: RunCurrent;
    steps: RunStep[];
    usage?: RunLiveUsage;
}

/** Minimal run row the read model needs (a subset of `agent_runs`). */
export interface RunLiveSource {
    id: string;
    agentId: string | null;
    triggerMessageId: string | null;
    status: string;
    startedAt: Date;
    endedAt: Date | null;
}

/** Minimal event row the read model needs (a subset of `agent_run_events`). */
export interface RunEventSource {
    seq: number;
    ts: Date;
    kind: string;
    toolName: string | null;
    toolCallId: string | null;
    status: string | null;
    durationMs: number | null;
    summary: string | null;
    data: unknown;
}

// ─── Sanitizing ─────────────────────────────────────────────────────────────

function truncateChars(text: string, max: number): string {
    const chars = Array.from(text);
    if (chars.length <= max) return text;
    return `${chars.slice(0, Math.max(0, max - 3)).join("").trimEnd()}...`;
}

function redactValue(value: unknown, depth: number): unknown {
    if (typeof value === "string") return redactSensitive(value);
    if (depth > 4 || value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 50)) {
        out[key] = redactValue(item, depth + 1);
    }
    return out;
}

/**
 * Redact every string in `data` and enforce the 2 KiB cap. Over the cap the
 * payload is replaced by `{truncated: true}` rather than cut mid-structure.
 */
export function sanitizeRunEventData(data: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
    if (!data || Object.keys(data).length === 0) return null;
    const redacted = redactValue(data, 0) as Record<string, unknown>;
    const bytes = new TextEncoder().encode(JSON.stringify(redacted)).length;
    return bytes <= RUN_EVENT_DATA_MAX_BYTES ? redacted : { truncated: true };
}

export interface SanitizedRunEvent {
    id: string;
    seq: number;
    ts: Date;
    kind: RunEventKind;
    toolName: string | null;
    toolCallId: string | null;
    status: RunEventStatus | null;
    durationMs: number | null;
    summary: string | null;
    data: Record<string, unknown> | null;
}

/** Cap, redact and clamp one validated event for storage. */
export function sanitizeRunEvent(event: RunEventInput, now: Date = new Date()): SanitizedRunEvent {
    const summary = event.summary ? cleanSnippet(event.summary, RUN_EVENT_SUMMARY_MAX_CHARS) : "";
    const toolName = event.toolName?.trim() ? truncateChars(event.toolName.trim(), RUN_EVENT_TOOL_NAME_MAX_CHARS) : null;
    const toolCallId = event.toolCallId?.trim() ? truncateChars(event.toolCallId.trim(), RUN_EVENT_TOOL_CALL_ID_MAX_CHARS) : null;
    return {
        id: event.id,
        seq: event.seq,
        // Runtimes have no trustworthy clock: same clamp as run timestamps.
        ts: clampRunTimestamp(event.ts, now),
        kind: event.kind,
        toolName,
        toolCallId,
        status: event.status ?? null,
        durationMs: event.durationMs ?? null,
        summary: summary || null,
        data: sanitizeRunEventData(event.data ?? null),
    };
}

// ─── Cap policy ─────────────────────────────────────────────────────────────

/**
 * Apply the per-run cap to one batch. `existing` = events already stored for
 * the run. Terminal turn events are always kept (they end the run's live
 * state). Then non-droppable kinds, then droppable ones, each in seq order,
 * until the run is full. Returns the kept events (seq order) and the drop count.
 */
export function applyRunEventCap<T extends { seq: number; kind: string }>(
    existing: number,
    events: readonly T[],
    cap: number = RUN_EVENTS_PER_RUN_MAX,
): { kept: T[]; dropped: number } {
    const room = Math.max(0, cap - existing);
    if (events.length <= room) return { kept: [...events].sort((a, b) => a.seq - b.seq), dropped: 0 };

    const terminal = events.filter((event) => isTerminalRunEventKind(event.kind));
    const rest = events.filter((event) => !isTerminalRunEventKind(event.kind)).sort((a, b) => a.seq - b.seq);
    const important = rest.filter((event) => !isDroppableRunEventKind(event.kind));
    const droppable = rest.filter((event) => isDroppableRunEventKind(event.kind));

    let left = Math.max(0, room - terminal.length);
    const keptImportant = important.slice(0, left);
    left -= keptImportant.length;
    const keptDroppable = droppable.slice(0, left);

    const kept = [...terminal, ...keptImportant, ...keptDroppable].sort((a, b) => a.seq - b.seq);
    return { kept, dropped: events.length - kept.length };
}

// ─── Activity line ──────────────────────────────────────────────────────────

function dataString(data: unknown, key: string): string | null {
    if (!data || typeof data !== "object") return null;
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "string" && value.trim() ? value.trim() : null;
}

function dataNumber(data: unknown, key: string): number | null {
    if (!data || typeof data !== "object") return null;
    const value = (data as Record<string, unknown>)[key];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function joinLine(head: string, tail: string | null | undefined): string {
    const clean = tail?.replace(/\s+/g, " ").trim();
    return clean ? `${head} · ${clean}` : head;
}

/**
 * The one-line "what is the agent doing" text for an event (≤ 200 chars,
 * redacted), or null for kinds that do not change it (usage, terminal turn
 * kinds). Shared by the ingestion side effect (`currentActivity`) and the
 * `RunLive.current` read model.
 */
export function deriveActivityLine(event: Pick<RunEventSource, "kind" | "toolName" | "status" | "summary" | "data">): string | null {
    const tool = event.toolName || "a tool";
    let line: string | null;
    switch (event.kind) {
        case "turn.queued": {
            const position = dataNumber(event.data, "position");
            line = position != null && position > 0 ? `Queued · position ${position}` : "Queued";
            break;
        }
        case "turn.started":
            line = "Working";
            break;
        case "reasoning":
            line = "Thinking…";
            break;
        case "notice":
            line = event.summary || null;
            break;
        case "tool.prepare":
            line = `Preparing ${tool}`;
            break;
        case "tool.start":
            line = joinLine(`Running ${tool}`, event.summary || dataString(event.data, "target"));
            break;
        case "tool.progress": {
            const percent = dataNumber(event.data, "percent");
            line = joinLine(`Running ${tool}`, percent != null ? `${Math.round(percent)}%` : event.summary);
            break;
        }
        case "tool.end":
            line = event.status === "error" ? `${tool} failed` : `Finished ${tool}`;
            break;
        case "status":
            line = dataString(event.data, "kind") === "compacting" ? "Tidying memory…" : (event.summary || "Working");
            break;
        case "subagent.start":
            line = joinLine("Delegating", dataString(event.data, "name"));
            break;
        case "subagent.end":
            line = joinLine("Subagent finished", dataString(event.data, "name"));
            break;
        case "approval.auto":
            line = joinLine("Auto-approved", event.summary);
            break;
        case "clarify.auto":
            line = "Proceeding with best judgment";
            break;
        case "compaction.start":
            line = "Tidying memory…";
            break;
        case "compaction.end":
            line = "Memory tidied";
            break;
        default:
            line = null;
    }
    return line ? cleanSnippet(line, RUN_ACTIVITY_MAX_CHARS) : null;
}

/**
 * The typing-row effect of a batch, from its newest event: `clear` when the
 * turn ended (a terminal kind, or a post-reply compaction finishing on a run
 * that is no longer running), `set` with the activity line otherwise, or null
 * when nothing in the batch changes the line (e.g. a usage-only batch).
 */
export function typingEffectFor(
    events: readonly Pick<RunEventSource, "seq" | "kind" | "toolName" | "status" | "summary" | "data">[],
    runStatus: string,
): { action: "clear" } | { action: "set"; activity: string } | null {
    const ordered = [...events].sort((a, b) => b.seq - a.seq);
    for (const event of ordered) {
        if (isTerminalRunEventKind(event.kind)) return { action: "clear" };
        if (event.kind === "compaction.end" && runStatus !== "running") return { action: "clear" };
        const line = deriveActivityLine(event);
        if (line) return { action: "set", activity: line };
    }
    return null;
}

// ─── Read model builders ────────────────────────────────────────────────────

export function isRunStepKind(kind: string): kind is RunStepKind {
    return (RUN_STEP_KINDS as readonly string[]).includes(kind);
}

function isRunEventStatus(value: string | null): value is RunEventStatus {
    return value != null && (RUN_EVENT_STATUSES as readonly string[]).includes(value);
}

export function toRunStep(event: RunEventSource): RunStep | null {
    if (!isRunStepKind(event.kind)) return null;
    return {
        seq: event.seq,
        ts: event.ts.toISOString(),
        kind: event.kind,
        ...(event.toolName ? { toolName: event.toolName } : {}),
        ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
        ...(isRunEventStatus(event.status) ? { status: event.status } : {}),
        ...(event.durationMs != null ? { durationMs: event.durationMs } : {}),
        ...(event.summary ? { summary: event.summary } : {}),
    };
}

/** Live usage from a `usage` event's data, or null when it carries no tokens. */
export function liveUsageFromData(data: unknown): RunLiveUsage | null {
    const input = dataNumber(data, "input");
    const output = dataNumber(data, "output");
    if (input == null && output == null) return null;
    const used = dataNumber(data, "contextUsed");
    const max = dataNumber(data, "contextMax");
    const reported = dataNumber(data, "contextPercent");
    return {
        input: Math.max(0, Math.round(input ?? 0)),
        output: Math.max(0, Math.round(output ?? 0)),
        cacheRead: Math.max(0, Math.round(dataNumber(data, "cacheRead") ?? 0)),
        contextPercent: reported != null
            ? Math.min(100, Math.max(0, Math.round(reported)))
            : used != null && max != null && max > 0 ? Math.min(100, Math.round((used / max) * 100)) : null,
    };
}

/**
 * Build one `RunLive` from a run row and its events (any order; only the
 * newest matter). `current` is the newest event with a display line; a run
 * with none yet reads "Working" since its start.
 */
export function buildRunLive(run: RunLiveSource, events: readonly RunEventSource[], now: Date = new Date()): RunLive {
    const ordered = [...events].sort((a, b) => a.seq - b.seq);
    const steps: RunStep[] = [];
    for (const event of ordered) {
        const step = toRunStep(event);
        if (step) steps.push(step);
    }

    let current: RunCurrent | null = null;
    let usage: RunLiveUsage | undefined;
    for (let i = ordered.length - 1; i >= 0; i--) {
        const event = ordered[i];
        if (!usage && event.kind === "usage") usage = liveUsageFromData(event.data) ?? undefined;
        if (!current) {
            const terminal = isTerminalRunEventKind(event.kind);
            const line = terminal
                ? (event.kind === "turn.completed" ? "Done" : event.kind === "turn.failed" ? "Failed" : "Stopped")
                : deriveActivityLine(event);
            if (line) {
                current = {
                    kind: event.kind as RunEventKind,
                    ...(event.toolName ? { toolName: event.toolName } : {}),
                    summary: line,
                    sinceMs: Math.max(0, now.getTime() - event.ts.getTime()),
                };
            }
        }
        if (current && usage) break;
    }

    return {
        runId: run.id,
        agentId: run.agentId,
        triggerMessageId: run.triggerMessageId,
        status: run.status,
        startedAt: run.startedAt.toISOString(),
        ...(run.endedAt ? { endedAt: run.endedAt.toISOString() } : {}),
        current: current ?? {
            kind: "turn.started",
            summary: "Working",
            sinceMs: Math.max(0, now.getTime() - run.startedAt.getTime()),
        },
        steps: steps.slice(-RUN_LIVE_MAX_STEPS),
        ...(usage ? { usage } : {}),
    };
}

/**
 * Parse the `eventsSince=<runId>:<seq>,…` request param into runId → seq.
 * Malformed entries are skipped; the highest seq wins for a repeated run.
 */
export function parseEventsSince(param: string | null | undefined): Map<string, number> {
    const out = new Map<string, number>();
    if (!param) return out;
    for (const part of param.split(",").slice(0, 50)) {
        const [runId, seqText] = part.trim().split(":");
        const seq = Number(seqText);
        if (!runId || !/^[0-9a-f-]{36}$/i.test(runId) || !Number.isInteger(seq) || seq < 0) continue;
        out.set(runId, Math.max(seq, out.get(runId) ?? -1));
    }
    return out;
}

/** `loadLiveRuns` never looks at runs started longer ago than this. */
export const RUN_LIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The newest `perRun` events of each run (company-scoped), oldest first per
 * run. One `LATERAL ... ORDER BY seq DESC LIMIT n` probe per run, served by the
 * (run_id, seq) unique index, so cost is bounded by `perRun`, not by run size.
 * Timestamps are read as epoch millis so the process timezone never shifts them.
 */
export async function loadRunEventsTail(companyId: string, runIds: readonly string[], perRun = 40): Promise<Map<string, RunEventSource[]>> {
    const out = new Map<string, RunEventSource[]>();
    const ids = [...new Set(runIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 100);
    if (ids.length === 0) return out;
    const rows = await db.execute<{
        run_id: string; seq: number; ts_ms: string | number; kind: string; tool_name: string | null;
        tool_call_id: string | null; status: string | null; duration_ms: number | null;
        summary: string | null; data: unknown;
    }>(sql`
        SELECT r.run_id, e.seq, extract(epoch from e.ts) * 1000 AS ts_ms, e.kind, e.tool_name,
               e.tool_call_id, e.status, e.duration_ms, e.summary, e.data
        FROM unnest(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]) AS r(run_id)
        CROSS JOIN LATERAL (
            SELECT * FROM ${agentRunEvents} ev
            WHERE ev.run_id = r.run_id AND ev.company_id = ${companyId}
            ORDER BY ev.seq DESC
            LIMIT ${Math.max(1, Math.min(perRun, 500))}
        ) e
        ORDER BY r.run_id, e.seq`);
    for (const row of rows.rows) {
        const list = out.get(row.run_id) ?? [];
        list.push({
            seq: Number(row.seq),
            ts: new Date(Math.round(Number(row.ts_ms))),
            kind: row.kind,
            toolName: row.tool_name,
            toolCallId: row.tool_call_id,
            status: row.status,
            durationMs: row.duration_ms,
            summary: row.summary,
            data: row.data,
        });
        out.set(row.run_id, list);
    }
    return out;
}

/**
 * The thread's live runs for chat: runs that are `running` or ended less than
 * `RUN_LIVE_RECENT_MS` ago, newest first, each with its newest events. With
 * `since` (from `parseEventsSince`), `steps` only holds events newer than the
 * given seq for that run. Privacy (thread visibility) is the caller's job.
 */
export async function loadLiveRuns(
    companyId: string,
    threadId: string,
    options: { since?: Map<string, number>; now?: Date; limit?: number } = {},
): Promise<RunLive[]> {
    const now = options.now ?? new Date();
    const recent = new Date(now.getTime() - RUN_LIVE_RECENT_MS);
    const runs = await db
        .select({
            id: agentRuns.id,
            agentId: agentRuns.agentId,
            triggerMessageId: agentRuns.triggerMessageId,
            status: agentRuns.status,
            startedAt: agentRuns.startedAt,
            endedAt: agentRuns.endedAt,
        })
        .from(agentRuns)
        .where(and(
            eq(agentRuns.companyId, companyId),
            eq(agentRuns.threadId, threadId),
            or(eq(agentRuns.status, "running"), gt(agentRuns.endedAt, recent)),
            // Served by agent_runs_thread_started_idx; a run older than this is
            // closed as lost long before (LOST_RUN_AFTER_MS = 2 h).
            gte(agentRuns.startedAt, new Date(now.getTime() - RUN_LIVE_MAX_AGE_MS)),
        ))
        .orderBy(desc(agentRuns.startedAt))
        .limit(options.limit ?? 10);
    if (runs.length === 0) return [];

    // Newest 40 events per run is plenty for 8 steps + current + usage.
    const byRun = await loadRunEventsTail(companyId, runs.map((run) => run.id), 40);

    return runs.map((run) => {
        const live = buildRunLive(run, byRun.get(run.id) ?? [], now);
        const sinceSeq = options.since?.get(run.id);
        if (sinceSeq != null) live.steps = live.steps.filter((step) => step.seq > sinceSeq);
        return live;
    });
}

// ─── Ingestion (POST /api/mcp/agents/runs/[id]/events) ─────────────────────

export type RunEventRunRow = typeof agentRuns.$inferSelect;

export type RunEventsAcceptance = "accept" | "gone";

/**
 * Whether a run still takes events: always while running (and while `lost`,
 * which a late finish may revive), and for `RUN_EVENTS_LATE_ACCEPT_MS` after a
 * terminal run ended (late flushes); then `gone` (410).
 */
export function runEventsAcceptance(run: Pick<RunEventRunRow, "status" | "endedAt">, now: Date = new Date()): RunEventsAcceptance {
    if (!isTerminalRunStatus(run.status) || run.status === "lost") return "accept";
    if (!run.endedAt) return "accept";
    return now.getTime() - run.endedAt.getTime() <= RUN_EVENTS_LATE_ACCEPT_MS ? "accept" : "gone";
}

/**
 * Store one validated batch for an existing run. Idempotent: rows conflicting
 * on the id or on (run_id, seq) are skipped and counted as duplicates. The
 * per-run cap is applied against the rows already stored.
 */
export async function insertRunEvents(
    run: Pick<RunEventRunRow, "id" | "companyId" | "agentId" | "threadId" | "status">,
    events: readonly RunEventInput[],
    now: Date = new Date(),
): Promise<RunEventIngestResult & { stored: SanitizedRunEvent[] }> {
    const [stats] = await db
        .select({
            count: sql<number>`count(*)::int`,
            maxSeq: sql<number | null>`max(${agentRunEvents.seq})`,
        })
        .from(agentRunEvents)
        .where(eq(agentRunEvents.runId, run.id));
    const existing = Number(stats?.count ?? 0);
    const previousMax = stats?.maxSeq == null ? -1 : Number(stats.maxSeq);

    // A batch repeating a seq keeps its first event; the rest are duplicates.
    const unique: RunEventInput[] = [];
    const seenSeq = new Set<number>();
    for (const event of events) {
        if (seenSeq.has(event.seq)) continue;
        seenSeq.add(event.seq);
        unique.push(event);
    }
    // A retried batch: seqs already stored are duplicates, not cap drops (one
    // index probe), so a replay never inflates events_dropped.
    const storedSeqs = unique.length === 0 ? new Set<number>() : new Set((await db
        .select({ seq: agentRunEvents.seq })
        .from(agentRunEvents)
        .where(and(eq(agentRunEvents.runId, run.id), inArray(agentRunEvents.seq, unique.map((event) => event.seq)))))
        .map((row) => row.seq));
    const sanitized = unique.filter((event) => !storedSeqs.has(event.seq)).map((event) => sanitizeRunEvent(event, now));
    const { kept, dropped } = applyRunEventCap(existing, sanitized);

    let inserted: { id: string; seq: number }[] = [];
    if (kept.length > 0) {
        inserted = await db
            .insert(agentRunEvents)
            .values(kept.map((event) => ({
                ...event,
                companyId: run.companyId,
                runId: run.id,
                agentId: run.agentId,
                threadId: run.threadId,
            })))
            // No target: skips a conflict on the PK and on (run_id, seq) alike.
            .onConflictDoNothing()
            .returning({ id: agentRunEvents.id, seq: agentRunEvents.seq });
    }

    if (dropped > 0) {
        await db
            .update(agentRuns)
            .set({ eventsDropped: sql`coalesce(${agentRuns.eventsDropped}, 0) + ${dropped}` })
            .where(eq(agentRuns.id, run.id));
    }

    const insertedIds = new Set(inserted.map((row) => row.id));
    const lastSeq = inserted.reduce((max, row) => Math.max(max, row.seq), previousMax);
    return {
        accepted: inserted.length,
        duplicates: events.length - dropped - inserted.length,
        dropped,
        lastSeq,
        runStatus: run.status,
        stored: kept.filter((event) => insertedIds.has(event.id)),
    };
}

// --- Typing side effect guards ------------------------------------------------

/**
 * Gate a batch's typing effect by the run's state: a run that already ended
 * may only clear the row (a late flush must not show the agent working again).
 */
export function gateTypingEffect(
    effect: ReturnType<typeof typingEffectFor>,
    runStatus: string,
): ReturnType<typeof typingEffectFor> {
    if (!effect) return null;
    if (effect.action === "set" && runStatus !== "running") return null;
    return effect;
}

/**
 * Whether the run's typing row may be touched, and how: `update` when the
 * agent already participates in the thread, `insert` for the company's team
 * thread (every agent belongs to it; rows are created lazily), null otherwise
 * (unknown or foreign thread, or a thread the agent is not in). A `clear` is
 * also skipped (null) when the agent has a newer running run in that thread.
 */
export async function runTypingTarget(input: {
    companyId: string;
    threadId: string;
    agentId: string;
    runId: string;
    runStartedAt: Date;
    action: "set" | "clear";
}): Promise<"update" | "insert" | null> {
    const [thread] = await db.select({ type: messageThreads.type }).from(messageThreads).where(and(
        eq(messageThreads.id, input.threadId),
        eq(messageThreads.companyId, input.companyId),
    )).limit(1);
    if (!thread) return null;

    if (input.action === "clear") {
        const [newer] = await db.select({ id: agentRuns.id }).from(agentRuns).where(and(
            eq(agentRuns.companyId, input.companyId),
            eq(agentRuns.agentId, input.agentId),
            eq(agentRuns.threadId, input.threadId),
            eq(agentRuns.status, "running"),
            ne(agentRuns.id, input.runId),
            gt(agentRuns.startedAt, input.runStartedAt),
        )).limit(1);
        if (newer) return null;
    }

    const [participant] = await db.select({ id: threadParticipants.id }).from(threadParticipants).where(and(
        eq(threadParticipants.companyId, input.companyId),
        eq(threadParticipants.threadId, input.threadId),
        eq(threadParticipants.participantType, "agent"),
        eq(threadParticipants.participantId, input.agentId),
    )).limit(1);
    if (participant) return "update";
    return thread.type === "team" ? "insert" : null;
}
