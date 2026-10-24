import { socketMayReceive, type RealtimeAudience } from "./direct-chat-mode";

/**
 * Fan-out rule for one mcp_events NOTIFY (published by lib/pubsub.ts) onto the
 * /api/mcp/ws sockets (server.ts). Pure, so the rule is testable without a
 * websocket server. Relative imports only: server.ts loads it outside Next.
 */

/**
 * The projects/customers an event is about (lib/pubsub.ts realtimeSubjectFor).
 * Empty lists = not tied to any project or customer (team chat, agent status).
 */
export type RealtimeSubject = {
    projectIds: string[];
    customerIds: string[];
    /** Agents a presence/status event is about (agent status, typing, profile changes). */
    agentIds?: string[];
};

/**
 * agentId: the agent the token is bound to (null for a company-wide token).
 * allowedProjectIds / allowedCustomerIds: that agent's data scope, expanded
 * (lib/agent-scope.ts); null or absent = unrestricted.
 */
export type RealtimeSocket = {
    companyId?: string;
    agentId?: string | null;
    allowedProjectIds?: ReadonlySet<string> | null;
    allowedCustomerIds?: ReadonlySet<string> | null;
    /** The agent's "Agents it can work with" list (always itself); null = all. */
    allowedAgentIds?: ReadonlySet<string> | null;
};

export function parseRealtimeNotification(raw: string): { companyId: string; audience: RealtimeAudience | null; subject: RealtimeSubject | null; message: string } | null {
    const data = JSON.parse(raw) as { companyId?: unknown; audience?: RealtimeAudience | null; subject?: RealtimeSubject | null; payload?: unknown };
    if (typeof data.companyId !== "string") return null;
    const subject = data.subject && Array.isArray(data.subject.projectIds) && Array.isArray(data.subject.customerIds)
        ? {
            projectIds: data.subject.projectIds.filter((id): id is string => typeof id === "string"),
            customerIds: data.subject.customerIds.filter((id): id is string => typeof id === "string"),
            agentIds: Array.isArray(data.subject.agentIds) ? data.subject.agentIds.filter((id): id is string => typeof id === "string") : [],
        }
        : null;
    return { companyId: data.companyId, audience: data.audience ?? null, subject, message: JSON.stringify(data.payload) };
}

/**
 * A scoped agent's socket only gets events about projects/customers in its
 * scope: every project and customer the event names must be allowed. Events
 * naming none (team chat, presence) still reach it, like the REST rules.
 */
export function socketMayReceiveSubject(subject: RealtimeSubject | null | undefined, socket: RealtimeSocket): boolean {
    if (!subject) return true;
    // Presence of agents outside its list never reaches the agent (one-way).
    const reach = socket.allowedAgentIds ?? null;
    if (reach && (subject.agentIds ?? []).some((id) => !reach.has(id))) return false;
    const projects = socket.allowedProjectIds ?? null;
    const customers = socket.allowedCustomerIds ?? null;
    if (!projects && !customers) return true;
    if (subject.projectIds.some((id) => !projects || !projects.has(id))) return false;
    if (subject.customerIds.some((id) => !customers || !customers.has(id))) return false;
    return true;
}

/** Whether a socket gets this notification: same company, inside the audience, and inside its agent's data scope. */
export function socketReceives(
    notification: { companyId: string; audience: RealtimeAudience | null; subject?: RealtimeSubject | null },
    socket: RealtimeSocket,
): boolean {
    return socket.companyId === notification.companyId
        && socketMayReceive(notification.audience, socket)
        && socketMayReceiveSubject(notification.subject, socket);
}
