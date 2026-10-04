import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { db } from "@/db";
import { agents, messageThreads, tasks, threadMessages, threadParticipants } from "@/db/schema";
import { mentionedAgentIds } from "@/lib/message-routing";
import { SLA_TRACKED_TASK_STATES } from "@/lib/task-state";

const OPEN_STATES = new Set<string>(SLA_TRACKED_TASK_STATES);

/**
 * Agent health: is each agent actually doing its job? Computed on demand from
 * the records Emperor already keeps — no new tracking, nothing for runtimes
 * to report beyond what they already do.
 *
 * The signal that matters most is "unanswered": a message addressed to an
 * agent that is still waiting long after it should have been answered. That
 * is how a silently stuck agent shows up before a person notices.
 */

export const HEALTH_WINDOW_DAYS = 7;
/** A request still pending after this long counts as unanswered. */
export const UNANSWERED_AFTER_MS = 10 * 60 * 1000;
/** Not seen for this long = offline. */
export const OFFLINE_AFTER_MS = 5 * 60 * 1000;
const MAX_MESSAGES = 20_000;

export type HealthStatus = "healthy" | "attention" | "down" | "idle";

export interface AgentHealth {
    id: string;
    name: string;
    role: string | null;
    avatarUrl: string | null;
    online: boolean;
    lastSeenAt: string | null;
    load: number;
    status: HealthStatus;
    reasons: string[];
    requests: number;
    replies: number;
    unanswered: number;
    failed: number;
    retries: number;
    medianResponseMs: number | null;
    openTasks: number;
    overdueTasks: number;
    doneTasks: number;
    monthlyCostCents: number;
    monthlyTokens: number;
    budgetStatus: string;
    /** Requests answered per day, oldest first (sparkline). */
    repliesByDay: number[];
}

export interface AttentionItem {
    agentId: string;
    agentName: string;
    kind: "unanswered" | "failed";
    messageId: string;
    text: string;
    since: string;
    link: string;
}

export interface CompanyHealth {
    windowDays: number;
    generatedAt: string;
    agents: AgentHealth[];
    attention: AttentionItem[];
    totals: { agents: number; online: number; unanswered: number; failed: number; medianResponseMs: number | null; costCents: number };
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Pure scoring, unit-tested: what state is an agent in, and why. */
export function scoreAgent(input: {
    online: boolean;
    unanswered: number;
    failed: number;
    overdueTasks: number;
    budgetStatus: string;
    requests: number;
    replies: number;
}): { status: HealthStatus; reasons: string[] } {
    const reasons: string[] = [];
    if (input.unanswered > 0) reasons.push(`${input.unanswered} unanswered message${input.unanswered === 1 ? "" : "s"}`);
    if (input.failed > 0) reasons.push(`${input.failed} message${input.failed === 1 ? "" : "s"} failed`);
    if (input.overdueTasks > 0) reasons.push(`${input.overdueTasks} overdue task${input.overdueTasks === 1 ? "" : "s"}`);
    if (input.budgetStatus && input.budgetStatus !== "active") reasons.push(`budget ${input.budgetStatus.replace(/_/g, " ")}`);
    if (!input.online && input.unanswered > 0) return { status: "down", reasons: ["offline with work waiting", ...reasons] };
    if (reasons.length > 0) return { status: "attention", reasons };
    if (!input.online) return { status: input.requests + input.replies === 0 ? "idle" : "attention", reasons: input.requests + input.replies === 0 ? [] : ["offline"] };
    return { status: "healthy", reasons: [] };
}

export async function computeCompanyHealth(companyId: string, options: { agentIds?: string[]; now?: Date } = {}): Promise<CompanyHealth> {
    const now = options.now ?? new Date();
    const since = new Date(now.getTime() - HEALTH_WINDOW_DAYS * 86_400_000);

    let agentRows = await db.select().from(agents).where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt)));
    if (options.agentIds) {
        const allowed = new Set(options.agentIds);
        agentRows = agentRows.filter((a) => allowed.has(a.id));
    }
    const roster = agentRows.map((a) => ({ id: a.id, name: a.name }));
    const agentIds = new Set(agentRows.map((a) => a.id));

    const [threads, directParticipants, messages, taskRows] = await Promise.all([
        db.select({ id: messageThreads.id, type: messageThreads.type }).from(messageThreads).where(eq(messageThreads.companyId, companyId)),
        db.select({ threadId: threadParticipants.threadId, agentId: threadParticipants.participantId }).from(threadParticipants)
            .where(and(eq(threadParticipants.companyId, companyId), eq(threadParticipants.participantType, "agent"))),
        db.select({
            id: threadMessages.id,
            threadId: threadMessages.threadId,
            senderType: threadMessages.senderType,
            senderId: threadMessages.senderId,
            targetAgentId: threadMessages.targetAgentId,
            text: threadMessages.text,
            deliveryState: threadMessages.deliveryState,
            metadataJson: threadMessages.metadataJson,
            createdAt: threadMessages.createdAt,
        }).from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), gte(threadMessages.createdAt, since)))
            .orderBy(threadMessages.createdAt)
            .limit(MAX_MESSAGES),
        agentIds.size
            ? db.select({ id: tasks.id, state: tasks.state, assignedAgentId: tasks.assignedAgentId, slaDueAt: tasks.slaDueAt, updatedAt: tasks.updatedAt })
                .from(tasks)
                .where(and(eq(tasks.companyId, companyId), inArray(tasks.assignedAgentId, [...agentIds]), isNull(tasks.deletedAt)))
            : Promise.resolve([]),
    ]);

    const threadType = new Map(threads.map((t) => [t.id, t.type]));
    // The agent that owns each direct thread.
    const directOwner = new Map<string, string>();
    for (const p of directParticipants) {
        if (p.agentId && threadType.get(p.threadId) === "direct") directOwner.set(p.threadId, p.agentId);
    }

    type Stats = { requests: number; replies: number; unanswered: number; failed: number; retries: number; responses: number[]; repliesByDay: number[] };
    const stats = new Map<string, Stats>();
    for (const id of agentIds) stats.set(id, { requests: 0, replies: 0, unanswered: 0, failed: 0, retries: 0, responses: [], repliesByDay: Array(HEALTH_WINDOW_DAYS).fill(0) });
    const agentName = new Map(agentRows.map((a) => [a.id, a.name]));

    type Request = { agentId: string; messageId: string; threadId: string; at: number; deliveryState: string; failed: boolean; text: string; link: string };
    const requests: Request[] = [];
    const answered = new Set<Request>();
    // Requests still waiting for a reply, per (thread, agent).
    const waiting = new Map<string, Request[]>();

    // Pass 1, oldest first: requests, replies, and which reply answered which request.
    for (const m of messages) {
        const type = threadType.get(m.threadId) ?? "team";
        const at = m.createdAt.getTime();
        if (m.senderType === "agent" && m.senderId && stats.has(m.senderId)) {
            const s = stats.get(m.senderId)!;
            s.replies += 1;
            const day = Math.min(HEALTH_WINDOW_DAYS - 1, Math.max(0, Math.floor((at - since.getTime()) / 86_400_000)));
            s.repliesByDay[day] += 1;
            const key = `${m.threadId}:${m.senderId}`;
            for (const req of waiting.get(key) ?? []) {
                s.responses.push(at - req.at);
                answered.add(req);
            }
            waiting.delete(key);
            continue;
        }
        // People's messages, and work the system handed one agent (daily
        // review, approval decisions, requests from other platforms).
        const metadataForKind = (m.metadataJson as Record<string, unknown>) || {};
        const systemWork = m.senderType === "system" && Boolean(m.targetAgentId) && !("runtimeControl" in metadataForKind);
        if (m.senderType !== "human" && !systemWork) continue;

        // Who was this message for?
        const addressed = new Set<string>();
        if (m.targetAgentId) addressed.add(m.targetAgentId);
        else if (type === "direct") {
            const owner = directOwner.get(m.threadId);
            if (owner) addressed.add(owner);
        } else {
            mentionedAgentIds(m.text || "", roster).forEach((id) => addressed.add(id));
        }

        const metadata = (m.metadataJson as Record<string, unknown>) || {};
        const failure = metadata.runtimeFailure as { agentId?: string } | undefined;
        for (const agentId of addressed) {
            const s = stats.get(agentId);
            if (!s) continue;
            s.requests += 1;
            s.retries += Number(metadata.failedAttempts) || 0;
            const req: Request = {
                agentId,
                messageId: m.id,
                threadId: m.threadId,
                at,
                deliveryState: m.deliveryState,
                failed: m.deliveryState === "cancelled" && Boolean(failure) && (!failure!.agentId || failure!.agentId === agentId),
                text: (m.text || "").slice(0, 160),
                link: type === "group" ? `/messages?group=${m.threadId}` : type === "direct" ? `/messages?agent=${agentId}` : "/messages",
            };
            requests.push(req);
            const key = `${m.threadId}:${agentId}`;
            if (!waiting.has(key)) waiting.set(key, []);
            waiting.get(key)!.push(req);
        }
    }

    // Pass 2: classify. A request counts as unanswered only if it is still
    // pending, no later reply from that agent answered it (older runtimes may
    // never advance the state), and it has waited past the threshold.
    const attention: AttentionItem[] = [];
    for (const req of requests) {
        const s = stats.get(req.agentId)!;
        const item = { agentId: req.agentId, agentName: agentName.get(req.agentId) ?? "Agent", messageId: req.messageId, text: req.text, since: new Date(req.at).toISOString(), link: req.link };
        if (req.failed) {
            s.failed += 1;
            attention.push({ ...item, kind: "failed" });
        } else if (!answered.has(req) && ["queued", "seen", "acting"].includes(req.deliveryState) && now.getTime() - req.at > UNANSWERED_AFTER_MS) {
            s.unanswered += 1;
            attention.push({ ...item, kind: "unanswered" });
        }
    }

    const health: AgentHealth[] = agentRows.map((a) => {
        const s = stats.get(a.id)!;
        const own = taskRows.filter((t) => t.assignedAgentId === a.id);
        const open = own.filter((t) => OPEN_STATES.has(t.state));
        const openTasks = open.length;
        const overdueTasks = open.filter((t) => t.slaDueAt && t.slaDueAt.getTime() < now.getTime()).length;
        const doneTasks = own.filter((t) => t.state === "done" && t.updatedAt.getTime() >= since.getTime()).length;
        const online = Boolean(a.lastSeenAt && now.getTime() - a.lastSeenAt.getTime() < OFFLINE_AFTER_MS);
        const { status, reasons } = scoreAgent({
            online,
            unanswered: s.unanswered,
            failed: s.failed,
            overdueTasks,
            budgetStatus: a.budgetStatus,
            requests: s.requests,
            replies: s.replies,
        });
        return {
            id: a.id,
            name: a.name,
            role: a.role,
            avatarUrl: a.avatarUrl,
            online,
            lastSeenAt: a.lastSeenAt ? a.lastSeenAt.toISOString() : null,
            load: a.currentLoad,
            status,
            reasons,
            requests: s.requests,
            replies: s.replies,
            unanswered: s.unanswered,
            failed: s.failed,
            retries: s.retries,
            medianResponseMs: median(s.responses),
            openTasks,
            overdueTasks,
            doneTasks,
            monthlyCostCents: Number(a.monthlyCostCents) || 0,
            monthlyTokens: a.monthlyTokenUsage,
            budgetStatus: a.budgetStatus,
            repliesByDay: s.repliesByDay,
        };
    });

    const order: Record<HealthStatus, number> = { down: 0, attention: 1, healthy: 2, idle: 3 };
    health.sort((x, y) => order[x.status] - order[y.status] || x.name.localeCompare(y.name));
    attention.sort((x, y) => (x.kind === y.kind ? x.since.localeCompare(y.since) : x.kind === "failed" ? -1 : 1));

    const allResponses = [...stats.values()].flatMap((s) => s.responses);
    return {
        windowDays: HEALTH_WINDOW_DAYS,
        generatedAt: now.toISOString(),
        agents: health,
        attention: attention.slice(0, 50),
        totals: {
            agents: health.length,
            online: health.filter((h) => h.online).length,
            unanswered: health.reduce((n, h) => n + h.unanswered, 0),
            failed: health.reduce((n, h) => n + h.failed, 0),
            medianResponseMs: median(allResponses),
            costCents: health.reduce((n, h) => n + h.monthlyCostCents, 0),
        },
    };
}
