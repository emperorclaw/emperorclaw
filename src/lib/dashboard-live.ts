import { sql } from "drizzle-orm";
import { db } from "@/db";
import { agentRunEvents, agentRuns, messageThreads, threadParticipants } from "@/db/schema";
import { AGENT_PAIR_DESCRIPTION } from "@/lib/groups";
import { loadRecentAgentMessages, loadRecentReasoning, loadRecentTransitions } from "@/lib/live-feed";
import {
    approvalTitle, deriveEvents, LIVE_RECENT_MS, pickThoughts,
    type HandoffRow, type PendingApprovalRow, type ReasoningRow, type TaskTransitionRow,
} from "@/lib/live-feed-v2";
import { buildRunLive, publicActivityLine, RUN_LIVE_MAX_AGE_MS, type RunEventSource } from "@/lib/run-events";
import { taskTitle } from "@/lib/emperor-entities";
import type { SceneLiveEvent, SceneThought } from "@/lib/team-scene";

/**
 * The web dashboard's living-office extras: each agent's latest thought and
 * the recent moments (handoff, task done, needs you, blocked). Built from the
 * same loaders and pure helpers as the device feed (live-feed / live-feed-v2),
 * with a stricter privacy rule: the dashboard is read by any company member,
 * so legacy reasoning (thread_message_reasoning, pre-0.9 bridges) comes from
 * team and group threads only — never a direct thread, whoever is looking —
 * and agent pair threads only for owners/admins.
 *
 * 0.9 bridges stream run events instead. An agent with a running run that has
 * events shows its live step, the same line as chat ("Thinking · …",
 * "Running terminal · npm test"), from any thread. For a thread the viewer may
 * not read (a direct chat they are not in, or a pair thread for a non-admin)
 * the step is reduced to its generic label ("Thinking…", "Running terminal").
 */

/** Thread types whose reasoning may reach the company dashboard. */
const DASHBOARD_THOUGHT_THREADS: ReadonlySet<string> = new Set(["team", "group"]);
/** No direct reply is ever eligible on the dashboard. */
const NO_DIRECT_REPLIES: ReadonlySet<string> = new Set();
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
 * Pure: each agent's live step from its running run, as a bubble. The line is
 * chat's own (`buildRunLive().current`); for a private run only the generic
 * label of the same step. It is split at the first " · " into the bubble's
 * label ("Thinking", "Running terminal") and text. Runs without events are
 * skipped, so the agent can fall back to a legacy thought.
 */
export function runThoughtsFromRows(rows: readonly RunThoughtRow[], options: { nowMs: number; includePairThreads: boolean }): Map<string, SceneThought> {
    const out = new Map<string, SceneThought>();
    const now = new Date(options.nowMs);
    const newestFirst = [...rows].sort((a, b) => b.startedAtMs - a.startedAtMs);
    for (const row of newestFirst) {
        if (out.has(row.agentId) || row.events.length === 0) continue;
        const live = buildRunLive({ id: row.runId, agentId: row.agentId, triggerMessageId: null, status: "running", startedAt: new Date(row.startedAtMs), endedAt: null }, row.events, now);
        let line = live.current.summary;
        if (!runThoughtVisible(row, options.includePairThreads)) {
            const source = [...row.events].sort((a, b) => b.seq - a.seq).find((event) => event.kind === live.current.kind);
            line = publicActivityLine(source ?? { kind: live.current.kind, toolName: live.current.toolName ?? null, status: null });
        }
        const split = line.indexOf(" · ");
        out.set(row.agentId, {
            memberKey: `agent:${row.agentId}`,
            label: split >= 0 ? line.slice(0, split) : line,
            text: split >= 0 ? line.slice(split + 3) : "",
            at: new Date(options.nowMs - live.current.sinceMs).toISOString(),
        });
    }
    return out;
}

/** Bubble order: newest first, then by member key (stable rotation). */
function byNewest(a: SceneThought, b: SceneThought): number {
    return b.at.localeCompare(a.at) || a.memberKey.localeCompare(b.memberKey);
}

export interface DashboardLiveRows {
    reasoning: ReasoningRow[];
    /** 0.9 running runs with their newest events; a run's step wins over `reasoning` per agent. */
    runThoughts?: RunThoughtRow[];
    /** Owners/admins may read agent pair threads (run steps; legacy reasoning is filtered in SQL). */
    includePairThreads?: boolean;
    handoffs: HandoffRow[];
    transitions: TaskTransitionRow[];
    approvals: PendingApprovalRow[];
    agents: { id: string; name: string }[];
    nowMs: number;
}

export interface DashboardLive {
    thoughts: SceneThought[];
    liveEvents: SceneLiveEvent[];
}

/** Pure: rows → thoughts and events keyed by dashboard member key. */
export function dashboardLiveFromRows(rows: DashboardLiveRows): DashboardLive {
    const known = new Set(rows.agents.map((a) => a.id));
    const live = runThoughtsFromRows((rows.runThoughts ?? []).filter((r) => known.has(r.agentId)), {
        nowMs: rows.nowMs,
        includePairThreads: rows.includePairThreads === true,
    });
    // Defence in depth: the SQL already reads shared threads only.
    const shared = rows.reasoning.filter((r) => known.has(r.agentId) && DASHBOARD_THOUGHT_THREADS.has(r.threadType));
    const picked = pickThoughts(shared, { nowMs: rows.nowMs, creatorReplyIds: NO_DIRECT_REPLIES });
    // Legacy reasoning only for agents without a live run step (older bridges).
    const legacy: SceneThought[] = [...picked].filter(([agentId]) => !live.has(agentId)).map(([agentId, t]) => ({
        memberKey: `agent:${agentId}`,
        text: t.thought,
        at: new Date(rows.nowMs - t.ageSec * 1000).toISOString(),
    }));
    const thoughts = [...live.values(), ...legacy].sort(byNewest);

    const events = deriveEvents({
        handoffs: rows.handoffs,
        transitions: rows.transitions,
        approvals: rows.approvals,
        roster: rows.agents,
        shown: known,
        nowMs: rows.nowMs,
    });
    const liveEvents: SceneLiveEvent[] = events.map((e) => ({
        id: e.id,
        type: e.t,
        actorKey: `agent:${e.a}`,
        targetKey: e.b ? `agent:${e.b}` : null,
        title: e.title ?? null,
        at: new Date(rows.nowMs - e.ageSec * 1000).toISOString(),
    }));
    return { thoughts, liveEvents };
}

/** A pending approval row as the dashboard page reads it, before titling. */
export interface DashboardApprovalInput {
    id: string;
    requesterAgentId: string | null;
    actionType: string;
    rationale: string | null;
    requestedAt: Date;
    taskInput: unknown;
    taskType: string | null;
}

/** One row per approval (the page's join can repeat one), titled like the device feed. */
export function pendingApprovalRows(rows: DashboardApprovalInput[]): PendingApprovalRow[] {
    const seen = new Set<string>();
    const out: PendingApprovalRow[] = [];
    for (const a of rows) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        const task = a.taskType ? taskTitle({ inputJson: a.taskInput, taskType: a.taskType }) : null;
        out.push({ id: a.id, requesterAgentId: a.requesterAgentId, title: approvalTitle({ actionType: a.actionType, rationale: a.rationale, taskTitle: task }), requestedAtMs: a.requestedAt.getTime() });
    }
    return out;
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
    const result = await db.execute<{
        run_id: string; agent_id: string; thread_id: string | null; started_ms: string | number;
        thread_type: string | null; pair_thread: boolean | null; viewer_in_thread: boolean | null;
        seq: number; ts_ms: string | number; kind: string; tool_name: string | null; tool_call_id: string | null;
        status: string | null; duration_ms: number | null; summary: string | null; data: unknown;
    }>(sql`
        SELECT r.id AS run_id, r.agent_id, r.thread_id, extract(epoch from r.started_at) * 1000 AS started_ms,
               t.type AS thread_type,
               (t.description = ${AGENT_PAIR_DESCRIPTION} AND t.created_by_type = 'system') AS pair_thread,
               ${viewerInThread} AS viewer_in_thread,
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

/** Live run steps alone, for the fast thought poll: one query, redacted for the viewer. */
export async function loadRunThoughts(companyId: string, options: {
    now: Date;
    agentIds?: readonly string[];
    viewerUserId: string | null;
    includePairThreads: boolean;
}): Promise<SceneThought[]> {
    const rows = await loadRunThoughtRows(companyId, options);
    return [...runThoughtsFromRows(rows, { nowMs: options.now.getTime(), includePairThreads: options.includePairThreads }).values()].sort(byNewest);
}

/**
 * Four bounded, company-scoped queries per poll: live run steps (running runs
 * only), and from the last 10 minutes reasoning tails, recent agent messages
 * and task transitions.
 */
export async function loadDashboardLive(companyId: string, options: {
    now: Date;
    agents: { id: string; name: string }[];
    approvals: PendingApprovalRow[];
    /** Owners/admins may see agent pair threads; everyone else never reads them. */
    includePairThreads: boolean;
    /** The signed-in member: their own direct chats show full live steps. */
    viewerUserId?: string | null;
}): Promise<DashboardLive> {
    const since = new Date(options.now.getTime() - LIVE_RECENT_MS);
    const shared = { includePairThreads: options.includePairThreads };
    const [runThoughts, reasoning, messages, transitionRows] = await Promise.all([
        loadRunThoughtRows(companyId, { now: options.now, agentIds: options.agents.map((a) => a.id), viewerUserId: options.viewerUserId ?? null }),
        loadRecentReasoning(companyId, since, [], shared),
        loadRecentAgentMessages(companyId, since, shared),
        loadRecentTransitions(companyId, since),
    ]);
    return dashboardLiveFromRows({
        reasoning,
        runThoughts,
        includePairThreads: options.includePairThreads,
        handoffs: messages.map((m) => ({ id: m.id, senderId: m.senderId, targetAgentId: m.targetAgentId, text: m.text ?? "", createdAtMs: m.createdAt.getTime() })),
        transitions: transitionRows.map((r) => ({
            id: r.id, state: r.state ?? "", actorType: r.actorType, actorId: r.actorId, assignedAgentId: r.assignedAgentId,
            title: taskTitle({ inputJson: { title: r.title }, taskType: r.taskType }), createdAtMs: r.createdAt.getTime(),
        })),
        approvals: options.approvals,
        agents: options.agents,
        nowMs: options.now.getTime(),
    });
}
