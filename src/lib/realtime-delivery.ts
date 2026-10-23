import { socketMayReceive, type RealtimeAudience } from "./direct-chat-mode";

/**
 * Fan-out rule for one mcp_events NOTIFY (published by lib/pubsub.ts) onto the
 * /api/mcp/ws sockets (server.ts). Pure, so the rule is testable without a
 * websocket server. Relative imports only: server.ts loads it outside Next.
 */
export type RealtimeSocket = { companyId?: string; agentId?: string | null };

export function parseRealtimeNotification(raw: string): { companyId: string; audience: RealtimeAudience | null; message: string } | null {
    const data = JSON.parse(raw) as { companyId?: unknown; audience?: RealtimeAudience | null; payload?: unknown };
    if (typeof data.companyId !== "string") return null;
    return { companyId: data.companyId, audience: data.audience ?? null, message: JSON.stringify(data.payload) };
}

/** Whether a socket gets this notification: same company, and inside the audience when there is one. */
export function socketReceives(notification: { companyId: string; audience: RealtimeAudience | null }, socket: RealtimeSocket): boolean {
    return socket.companyId === notification.companyId && socketMayReceive(notification.audience, socket);
}
