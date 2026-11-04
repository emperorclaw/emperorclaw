import { sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRunEvents, agentRuns, messageThreads, threadParticipants } from "@/db/schema";
import { AGENT_PAIR_DESCRIPTION } from "@/lib/groups";
import { cleanSnippet, LIVE_RECENT_MS, THOUGHT_MAX } from "@/lib/live-feed-v2";
import { buildRunLive, deriveActivityLine, isTerminalRunEventKind, publicActivityLine, RUN_LIVE_MAX_AGE_MS, type RunEventSource } from "@/lib/run-events";

/**
 * Live run steps (0.9 bridges stream run events) for the surfaces that show
 * what an agent is doing right now: the web dashboard and the device feed.
 * Kept apart from both so live-feed and dashboard-live can share it without
 * importing each other.
 */

/** Newest events read per running run: enough to fall back past a bare reasoning beat. */
const RUN_THOUGHT_EVENTS = 8;
/** At most this many running runs (one per agent) are read per poll. */
const RUN_THOUGHT_MAX_RUNS = 200;

/** One agent's newest running run with its newest events, as loaded for the dashboard. */
export interface RunThoughtRow {
    runId: string;
    agentId: string;
    threadId: string | null;
    /** Null when the run has no thread, or its thread is archived or foreign. */
    threadType: string | null;
    /** A machine-managed agent pair thread. */
    pairThread: boolean;
    /** The viewer is a human participant of the run's thread. */
    viewerInThread: boolean;
    /** The run's thread is the viewer's own private direct chat (owner_user_id = viewer). */
    viewerOwnsThread?: boolean;
    startedAtMs: number;
    /** Newest events of the run, any order. */
    events: RunEventSource[];
}

/**
 * Whether the viewer may read a run's thread on the dashboard: team threads,
 * ordinary groups, pair threads for owners/admins, threads the viewer takes
 * part in, and runs with no thread (task work), as on the Agents page.
 * Everything else (another member's direct chat, an archived or foreign
 * thread) is private.
 */
export function runThoughtVisible(row: Pick<RunThoughtRow, "threadId" | "threadType" | "pairThread" | "viewerInThread">, includePairThreads: boolean): boolean {
    if (!row.threadId) return true;
    if (row.viewerInThread) return true;
    if (row.threadType === "team") return true;
    if (row.threadType === "group") return !row.pairThread || includePairThreads;
    return false;
}

/**
 * Whether a screen may show a run's thread. Stricter than the dashboard: a
 * screen is read by whoever stands in front of it, so taking part in a thread
 * is not enough. Every member takes part in an agent's shared direct chat
 * (the Work log in private mode), which carries other people's task wakes and
 * routines. A direct chat counts only when it is the creator's own private
 * chat; team, group and thread-less task runs follow the dashboard.
 */
export function screenRunVisible(row: Pick<RunThoughtRow, "threadId" | "threadType" | "pairThread" | "viewerOwnsThread">, includePairThreads: boolean): boolean {
    if (!row.threadId) return true;
    if (row.threadType === "team") return true;
    if (row.threadType === "group") return !row.pairThread || includePairThreads;
    return row.threadType === "direct" && row.viewerOwnsThread === true;
}

const UUID_RE = /^[0-9a-f-]{36}$/i;

/**
 * Each agent's newest running run (started in the last 24 h) with its newest
 * RUN_THOUGHT_EVENTS events, in ONE query. Runs come from the partial
 * agent_runs_running_idx (status = 'running'), one per agent (DISTINCT ON),
 * at most RUN_THOUGHT_MAX_RUNS; each run's events are a LATERAL
 * `ORDER BY seq DESC LIMIT n` probe on agent_run_events_run_seq_uq, so cost is
 * bounded by the number of working agents, not by run length. The thread
 * type, the pair flag and the viewer's participation come along for redaction.
 * Timestamps are read as epoch millis so the process timezone never shifts them.
 */
export async function loadRunThoughtRows(companyId: string, options: {
    now: Date;
    /** Restrict to these agents (the dashboard roster or a member scope). */
    agentIds?: readonly string[];
    viewerUserId: string | null;
}): Promise<RunThoughtRow[]> {
    const ids = options.agentIds ? [...new Set(options.agentIds)].filter((id) => UUID_RE.test(id)) : null;
    if (ids && ids.length === 0) return [];
    const cutoffMs = options.now.getTime() - RUN_LIVE_MAX_AGE_MS;
    const agentFilter = ids ? sql`AND ar.agent_id = ANY(ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[])` : sql``;
    const viewerInThread = options.viewerUserId
        ? sql`EXISTS (SELECT 1 FROM ${threadParticipants} vp WHERE vp.thread_id = r.thread_id AND vp.participant_type = 'human' AND vp.participant_ref = ${options.viewerUserId})`
        : sql`false`;
    const viewerOwnsThread = options.viewerUserId
        ? sql`(t.is_private AND t.owner_user_id = ${options.viewerUserId})`
        : sql`false`;
    const result = await db.execute<{
        run_id: string; agent_id: string; thread_id: string | null; started_ms: string | number;
        thread_type: string | null; pair_thread: boolean | null; viewer_in_thread: boolean | null;
        viewer_owns_thread: boolean | null; seq: number; ts_ms: string | number; kind: string; tool_name: string | null; tool_call_id: string | null;
        status: string | null; duration_ms: number | null; summary: string | null; data: unknown;
    }>(sql`
        SELECT r.id AS run_id, r.agent_id, r.thread_id, extract(epoch from r.started_at) * 1000 AS started_ms,
               t.type AS thread_type,
               (t.description = ${AGENT_PAIR_DESCRIPTION} AND t.created_by_type = 'system') AS pair_thread,
               ${viewerInThread} AS viewer_in_thread,
               ${viewerOwnsThread} AS viewer_owns_thread,
               e.seq, extract(epoch from e.ts) * 1000 AS ts_ms, e.kind, e.tool_name, e.tool_call_id,
               e.status, e.duration_ms, e.summary, e.data
        FROM (
            SELECT DISTINCT ON (ar.agent_id) ar.id, ar.agent_id, ar.thread_id, ar.started_at
            FROM ${agentRuns} ar
            WHERE ar.status = 'running'
              AND ar.company_id = ${companyId}
              AND ar.agent_id IS NOT NULL
              AND ar.started_at >= (to_timestamp(${cutoffMs}::double precision / 1000) AT TIME ZONE 'UTC')
              ${agentFilter}
            ORDER BY ar.agent_id, ar.started_at DESC
            LIMIT ${RUN_THOUGHT_MAX_RUNS}
        ) r
        LEFT JOIN ${messageThreads} t ON t.id = r.thread_id AND t.company_id = ${companyId} AND t.archived_at IS NULL
        CROSS JOIN LATERAL (
            SELECT * FROM ${agentRunEvents} ev
            WHERE ev.run_id = r.id AND ev.company_id = ${companyId}
            ORDER BY ev.seq DESC
            LIMIT ${RUN_THOUGHT_EVENTS}
        ) e`);
    const byRun = new Map<string, RunThoughtRow>();
    for (const row of result.rows) {
        let run = byRun.get(row.run_id);
        if (!run) {
            run = {
                runId: row.run_id,
                agentId: row.agent_id,
                threadId: row.thread_id,
                threadType: row.thread_type,
                pairThread: row.pair_thread === true,
                viewerInThread: row.viewer_in_thread === true,
                viewerOwnsThread: row.viewer_owns_thread === true,
                startedAtMs: Math.round(Number(row.started_ms)),
                events: [],
            };
            byRun.set(row.run_id, run);
        }
        run.events.push({
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
    }
    return [...byRun.values()];
}

/**
 * Pure: each agent's thought for a screen (GET /api/mcp/live) from its live
 * run step, the same line the dashboard shows. Only a run the screen may read
 * counts (screenRunVisible, with the screen's creator as viewer), and only a
 * step that carries real text: the reasoning itself, or a tool step with its
 * target ("Running terminal: npm test"). A private run, a bare "Thinking…" or
 * "Working" gives no thought at all, so a screen never shows a placeholder as
 * if the agent had written it.
 */
export function screenThoughtsFromRuns(rows: readonly RunThoughtRow[], options: { nowMs: number; includePairThreads: boolean }): Map<string, { thought: string; ageSec: number }> {
    const out = new Map<string, { thought: string; ageSec: number }>();
    const now = new Date(options.nowMs);
    const newestFirst = [...rows].sort((a, b) => b.startedAtMs - a.startedAtMs);
    for (const row of newestFirst) {
        if (out.has(row.agentId) || row.events.length === 0) continue;
        if (!screenRunVisible(row, options.includePairThreads)) continue;
        if (!runIsFresh(row, options.nowMs)) continue;
        const live = buildRunLive({ id: row.runId, agentId: row.agentId, triggerMessageId: null, status: "running", startedAt: new Date(row.startedAtMs), endedAt: null }, row.events, now);
        const line = live.current.summary;
        const split = line.indexOf(" · ");
        if (split < 0) continue;
        const label = line.slice(0, split);
        const text = line.slice(split + 3).trim();
        if (!text) continue;
        const thought = cleanSnippet(live.current.kind === "reasoning" ? text : `${label}: ${text}`, THOUGHT_MAX);
        if (!thought) continue;
        out.set(row.agentId, { thought, ageSec: Math.floor(live.current.sinceMs / 1000) });
    }
    return out;
}

/**
 * What `activity` and `step.label` say for a run a screen may not read: no
 * tool name, no step kind, nothing from the conversation.
 */
export const PRIVATE_ACTIVITY = "Working in a private chat";
/** `step.label` on a screen: a short generic headline ("Running terminal"); the device stores 26 chars. */
export const STEP_LABEL_MAX = 26;
/** `step.text` on a screen: the step's own detail (reasoning, tool target). */
export const STEP_TEXT_MAX = 100;
/** A running run whose newest event is older than this is treated as gone (a crashed bridge leaves it `running`). */
export const SCREEN_RUN_FRESH_MS = LIVE_RECENT_MS;

/** A running run's current step as a screen shows it. */
export interface ScreenStep {
    /** Generic headline, e.g. "Thinking", "Running terminal", or PRIVATE_ACTIVITY. Never conversation text unless the run is readable. */
    label: string;
    /** The step's real detail; only for a run the screen may read, on an opted-in token. */
    text?: string;
    /** Seconds since the step started. */
    sec: number;
    /**
     * Step identity (`<runId>:<seq>` of the event behind it), NOT serialized
     * (non-enumerable): the ETag tracks it so a new step with the same label
     * refreshes the device's timer, while the ticking `sec` stays out.
     */
    readonly key?: string;
}

/** Whether a running run still looks alive: its newest event is at most SCREEN_RUN_FRESH_MS old. */
export function runIsFresh(row: Pick<RunThoughtRow, "events">, nowMs: number): boolean {
    let newest = -Infinity;
    for (const e of row.events) newest = Math.max(newest, e.ts.getTime());
    return Number.isFinite(newest) && nowMs - newest <= SCREEN_RUN_FRESH_MS;
}

/** The newest event that sets the run's current line (what buildRunLive().current came from). */
function currentEventOf(events: readonly RunEventSource[]): RunEventSource | null {
    const newestFirst = [...events].sort((a, b) => b.seq - a.seq);
    return newestFirst.find((e) => isTerminalRunEventKind(e.kind) || deriveActivityLine(e) !== null) ?? null;
}

/** Plain ASCII for a 240x240 screen font: fold accents and typographic punctuation, drop the rest. */
export function screenAscii(value: string): string {
    return value
        .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
        .replace(/[\u201C\u201D\u201E\u2033]/g, "\"")
        .replace(/[\u2010-\u2015\u2212]/g, "-")
        .replace(/\u2026/g, "...")
        .replace(/\u00B7/g, "-")
        .replace(/[\u00A0\u2000-\u200B\u202F]/g, " ")
        .normalize("NFKD")
        .replace(/[^\x20-\x7E]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** A step headline for a screen: ASCII, without a trailing ellipsis ("Thinking..." -> "Thinking"). */
function stepLabel(value: string): string {
    return cleanSnippet(screenAscii(value).replace(/\s*\.{2,}$/, ""), STEP_LABEL_MAX);
}

function withKey(step: Omit<ScreenStep, "key">, key: string): ScreenStep {
    return Object.defineProperty(step, "key", { value: key, enumerable: false }) as ScreenStep;
}

/**
 * Pure: each agent's current run step for a screen (GET /api/mcp/live), from
 * its newest running run with events — the dashboard's live line split at
 * " · " into a headline (`label`) and its detail (`text`). A run whose newest
 * event is older than SCREEN_RUN_FRESH_MS gives no step (a crashed bridge
 * leaves its run `running`).
 *
 * Privacy, by run:
 *  - a run the screen may not read (screenRunVisible false: another member's
 *    private chat, the shared Work log, any direct chat without the creator
 *    as viewer) is only PRIVATE_ACTIVITY — not even the tool name;
 *  - a readable run on a token without thoughts gets publicActivityLine's
 *    generic label (the kind of step and the tool name);
 *  - a readable run on an opted-in token (`allowText`) also gets `text`, and
 *    its headline is taken from the line itself.
 */
export function screenStepsFromRuns(rows: readonly RunThoughtRow[], options: { nowMs: number; includePairThreads: boolean; allowText: boolean }): Map<string, ScreenStep> {
    const out = new Map<string, ScreenStep>();
    const now = new Date(options.nowMs);
    const newestFirst = [...rows].sort((a, b) => b.startedAtMs - a.startedAtMs);
    for (const row of newestFirst) {
        if (out.has(row.agentId) || row.events.length === 0) continue;
        if (!runIsFresh(row, options.nowMs)) continue;
        const live = buildRunLive({ id: row.runId, agentId: row.agentId, triggerMessageId: null, status: "running", startedAt: new Date(row.startedAtMs), endedAt: null }, row.events, now);
        const sec = Math.floor(live.current.sinceMs / 1000);
        const event = currentEventOf(row.events);
        const key = `${row.runId}:${event?.seq ?? 0}`;
        if (!screenRunVisible(row, options.includePairThreads)) {
            out.set(row.agentId, withKey({ label: PRIVATE_ACTIVITY, sec }, key));
            continue;
        }
        const publicLabel = stepLabel(event ? publicActivityLine(event) : "Working") || "Working";
        if (!options.allowText) {
            out.set(row.agentId, withKey({ label: publicLabel, sec }, key));
            continue;
        }
        const line = live.current.summary;
        const split = line.indexOf(" · ");
        const label = split >= 0 ? stepLabel(line.slice(0, split)) || publicLabel : publicLabel;
        const detail = split >= 0 ? line.slice(split + 3) : line;
        const text = cleanSnippet(screenAscii(detail), STEP_TEXT_MAX);
        const sameAsLabel = stepLabel(detail).toLowerCase() === label.toLowerCase();
        out.set(row.agentId, withKey(text && !sameAsLabel ? { label, text, sec } : { label, sec }, key));
    }
    return out;
}
