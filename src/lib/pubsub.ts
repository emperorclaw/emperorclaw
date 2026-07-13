import { db } from "@/db";
import { sql } from "drizzle-orm";

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

export async function broadcastMcpEvent(companyId: string, payload: any) {
    if (!companyId) return;
    try {
        let message = JSON.stringify({ companyId, payload });
        if (Buffer.byteLength(message, "utf8") > NOTIFY_PAYLOAD_LIMIT) {
            const compact = {
                companyId,
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
