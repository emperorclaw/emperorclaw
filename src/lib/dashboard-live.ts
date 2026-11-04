import { loadRecentAgentMessages, loadRecentReasoning, loadRecentTransitions } from "@/lib/live-feed";
import {
    approvalTitle, deriveEvents, LIVE_RECENT_MS, pickThoughts,
    type HandoffRow, type PendingApprovalRow, type ReasoningRow, type TaskTransitionRow,
} from "@/lib/live-feed-v2";
import { buildRunLive, publicActivityLine } from "@/lib/run-events";
import { loadRunThoughtRows, runThoughtVisible, type RunThoughtRow } from "@/lib/run-thoughts";
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

export { loadRunThoughtRows, runThoughtVisible, type RunThoughtRow } from "@/lib/run-thoughts";

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
