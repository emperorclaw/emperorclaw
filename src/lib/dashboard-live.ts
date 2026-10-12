import { loadRecentAgentMessages, loadRecentReasoning, loadRecentTransitions } from "@/lib/live-feed";
import {
    approvalTitle, deriveEvents, LIVE_RECENT_MS, pickThoughts,
    type HandoffRow, type PendingApprovalRow, type ReasoningRow, type TaskTransitionRow,
} from "@/lib/live-feed-v2";
import { taskTitle } from "@/lib/emperor-entities";
import type { SceneLiveEvent, SceneThought } from "@/lib/team-scene";

/**
 * The web dashboard's living-office extras: each agent's latest thought and
 * the recent moments (handoff, task done, needs you, blocked). Built from the
 * same loaders and pure helpers as the device feed (live-feed / live-feed-v2),
 * with a stricter privacy rule: the dashboard is read by any company member,
 * so reasoning comes from team and group threads only — never a direct
 * thread, whoever is looking — and agent pair threads only for owners/admins.
 */

/** Thread types whose reasoning may reach the company dashboard. */
const DASHBOARD_THOUGHT_THREADS: ReadonlySet<string> = new Set(["team", "group"]);
/** No direct reply is ever eligible on the dashboard. */
const NO_DIRECT_REPLIES: ReadonlySet<string> = new Set();

export interface DashboardLiveRows {
    reasoning: ReasoningRow[];
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
    // Defence in depth: the SQL already reads shared threads only.
    const shared = rows.reasoning.filter((r) => known.has(r.agentId) && DASHBOARD_THOUGHT_THREADS.has(r.threadType));
    const picked = pickThoughts(shared, { nowMs: rows.nowMs, creatorReplyIds: NO_DIRECT_REPLIES });
    const thoughts: SceneThought[] = [...picked].map(([agentId, t]) => ({
        memberKey: `agent:${agentId}`,
        text: t.thought,
        at: new Date(rows.nowMs - t.ageSec * 1000).toISOString(),
    })).sort((a, b) => b.at.localeCompare(a.at) || a.memberKey.localeCompare(b.memberKey));

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

/**
 * Three bounded, company-scoped queries per poll (reasoning tails, recent
 * agent messages, task transitions), all from the last 10 minutes.
 */
export async function loadDashboardLive(companyId: string, options: {
    now: Date;
    agents: { id: string; name: string }[];
    approvals: PendingApprovalRow[];
    /** Owners/admins may see agent pair threads; everyone else never reads them. */
    includePairThreads: boolean;
}): Promise<DashboardLive> {
    const since = new Date(options.now.getTime() - LIVE_RECENT_MS);
    const shared = { includePairThreads: options.includePairThreads };
    const [reasoning, messages, transitionRows] = await Promise.all([
        loadRecentReasoning(companyId, since, [], shared),
        loadRecentAgentMessages(companyId, since, shared),
        loadRecentTransitions(companyId, since),
    ]);
    return dashboardLiveFromRows({
        reasoning,
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
