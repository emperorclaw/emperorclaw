import { db } from "@/db";
import { messageThreads } from "@/db/schema";
import { and, eq, inArray, sql } from "drizzle-orm";
import { eventThreadIds, mostRestrictiveAudience, type RealtimeAudience } from "@/lib/direct-chat-mode";

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
    return mostRestrictiveAudience(threads);
}

export async function broadcastMcpEvent(companyId: string, payload: any) {
    if (!companyId) return;
    try {
        const audience = await realtimeAudienceFor(companyId, payload);
        let message = JSON.stringify({ companyId, audience, payload });
        if (Buffer.byteLength(message, "utf8") > NOTIFY_PAYLOAD_LIMIT) {
            const compact = {
                companyId,
                audience,
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
