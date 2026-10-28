import { db } from "@/db";
import { agents, messageThreads, tasks } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { eventThreadIds, mostRestrictiveHumanAudience, type RealtimeAudience } from "@/lib/direct-chat-mode";
import type { RealtimeSubject } from "@/lib/realtime-delivery";

/**
 * Broadcasts an event to connected MCP WebSocket clients for a specific company.
 * Relies on PostgreSQL LISTEN/NOTIFY captured by custom `server.ts`.
 */
// PostgreSQL NOTIFY has a hard 8000-byte payload limit; exceeding it throws
// error 22023 "payload string too long". The underlying record is always
// persisted before this broadcast runs, so NOTIFY is only a realtime signal:
// for oversized events we emit a compact "refetch" envelope instead of failing
// the whole request. Stay safely under the limit to leave room for UTF-8.
const NOTIFY_PAYLOAD_LIMIT = 7500;

/**
 * Who may receive an event: null = every socket of the company. An event about
 * a private direct thread goes only to sockets bound to that thread's agent
 * (server.ts applies it). Throws when the thread cannot be looked up, so a
 * lookup failure never fans private data out to the whole company.
 */
export async function realtimeAudienceFor(companyId: string, payload: unknown): Promise<RealtimeAudience | null> {
    // A non-uuid cannot name a thread, so there is nothing private to protect.
    const threadIds = eventThreadIds(payload)
        .filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
    if (threadIds.length === 0) return null;
    const threads = await db.select({
        type: messageThreads.type,
        ownerUserId: messageThreads.ownerUserId,
        isPrivate: messageThreads.isPrivate,
        directAgentId: messageThreads.directAgentId,
    }).from(messageThreads)
        .where(and(inArray(messageThreads.id, threadIds), eq(messageThreads.companyId, companyId)));
    return mostRestrictiveHumanAudience(threads);
}

/**
 * An event for one signed-in person only (e.g. their inbox read/archive state
 * changed in another tab). The audience names the person and no agent, so no
 * agent socket and no other person receives it (lib/realtime-delivery.ts).
 */
export async function broadcastUserEvent(companyId: string, userId: string, payload: { type: string }) {
    if (!companyId || !userId) return;
    try {
        const audience: RealtimeAudience = { agentId: null, ownerUserId: userId };
        const subject: RealtimeSubject = { projectIds: [], customerIds: [], agentIds: [] };
        await db.execute(sql`SELECT pg_notify('mcp_events', ${JSON.stringify({ companyId, audience, subject, payload })})`);
    } catch (e) {
        console.error("Failed to broadcast user event:", e);
    }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Which projects/customers an event is about, so server.ts can keep it from
 * the sockets of agents scoped away from them (lib/realtime-delivery.ts).
 * Reads the ids the payload carries, plus the project of every task and
 * thread it names. Throws on a lookup failure (the caller then broadcasts
 * nothing rather than fanning scoped data out).
 */
export async function realtimeSubjectFor(companyId: string, payload: unknown): Promise<RealtimeSubject> {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, any>;
    const projectIds = new Set<string>();
    const customerIds = new Set<string>();
    const taskIds = new Set<string>();
    const directAgentIds = new Set<string>();
    const add = (set: Set<string>, value: unknown) => { if (typeof value === "string" && UUID_RE.test(value)) set.add(value); };
    add(projectIds, p.projectId);
    add(customerIds, p.customerId);
    add(taskIds, p.taskId);
    add(projectIds, p.project?.id);
    add(customerIds, p.project?.customerId);
    add(customerIds, p.customer?.id);
    add(taskIds, p.task?.id);
    add(projectIds, p.task?.projectId);
    for (const key of ["artifact", "memory", "incident", "approval", "pipeline", "folder", "schedule", "definition"]) {
        add(projectIds, p[key]?.projectId);
        add(customerIds, p[key]?.customerId);
        add(taskIds, p[key]?.taskId);
    }
    const threadIds = eventThreadIds(payload).filter((id) => UUID_RE.test(id));
    if (threadIds.length > 0) {
        const threads = await db.select({ projectId: messageThreads.projectId, taskId: messageThreads.taskId, directAgentId: messageThreads.directAgentId }).from(messageThreads)
            .where(and(inArray(messageThreads.id, threadIds), eq(messageThreads.companyId, companyId)));
        for (const thread of threads) { add(projectIds, thread.projectId); add(taskIds, thread.taskId); add(directAgentIds, thread.directAgentId); }
    }
    if (taskIds.size > 0) {
        const rows = await db.select({ projectId: tasks.projectId }).from(tasks)
            .where(and(inArray(tasks.id, [...taskIds]), eq(tasks.companyId, companyId)));
        for (const row of rows) add(projectIds, row.projectId);
    }
    // Presence/status events name the agent they are about. Only real agent
    // ids count (participant_status may carry a person's id).
    const candidates = new Set<string>();
    if (p.type !== "thread_message") {
        add(candidates, p.agentId);
        add(candidates, p.agent?.id);
        add(candidates, p.session?.agentId);
        add(candidates, p.objective?.agentId);
        if (p.type === "participant_status") add(candidates, p.participantId);
    }
    const agentIds = candidates.size > 0
        ? (await db.select({ id: agents.id }).from(agents).where(and(inArray(agents.id, [...candidates]), eq(agents.companyId, companyId)))).map((a) => a.id)
        : [];
    return { projectIds: [...projectIds], customerIds: [...customerIds], agentIds, directAgentIds: [...directAgentIds] };
}

export async function broadcastMcpEvent(companyId: string, payload: any) {
    if (!companyId) return;
    try {
        const audience = await realtimeAudienceFor(companyId, payload);
        const subject = await realtimeSubjectFor(companyId, payload);
        let message = JSON.stringify({ companyId, audience, subject, payload });
        if (Buffer.byteLength(message, "utf8") > NOTIFY_PAYLOAD_LIMIT) {
            const compact = {
                companyId,
                audience,
                subject,
                payload: {
                    type: payload?.type ?? "event",
                    truncated: true,
                    threadId: payload?.thread?.id ?? payload?.threadId ?? null,
                    messageId: payload?.message?.id ?? payload?.id ?? null,
                    targetAgentId: payload?.message?.targetAgentId ?? payload?.targetAgentId ?? null,
                },
            };
            message = JSON.stringify(compact);
        }
        await db.execute(sql`SELECT pg_notify('mcp_events', ${message})`);
    } catch (e) {
        console.error("Failed to broadcast MCP event:", e);
    }
}
