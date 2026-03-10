import { db } from "@/db";
import { sql } from "drizzle-orm";

/**
 * Broadcasts an event to connected MCP WebSocket clients for a specific company.
 * Relies on PostgreSQL LISTEN/NOTIFY captured by custom `server.ts`.
 */
export async function broadcastMcpEvent(companyId: string, payload: any) {
    if (!companyId) return;
    try {
        const message = JSON.stringify({ companyId, payload });
        await db.execute(sql`SELECT pg_notify('mcp_events', ${message})`);
    } catch (e) {
        console.error("Failed to broadcast MCP event:", e);
    }
}
