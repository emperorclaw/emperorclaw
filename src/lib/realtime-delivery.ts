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
    /** The agents whose direct threads the event belongs to (human sockets only: lib/agent-access.ts). */
    directAgentIds?: string[];
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

export function parseRealtimeNotification(raw: string): { companyId: string; audience: RealtimeAudience | null; subject: RealtimeSubject | null; payload: unknown; message: string } | null {
    const data = JSON.parse(raw) as { companyId?: unknown; audience?: RealtimeAudience | null; subject?: RealtimeSubject | null; payload?: unknown };
    if (typeof data.companyId !== "string") return null;
    const subject = data.subject && Array.isArray(data.subject.projectIds) && Array.isArray(data.subject.customerIds)
        ? {
            projectIds: data.subject.projectIds.filter((id): id is string => typeof id === "string"),
            customerIds: data.subject.customerIds.filter((id): id is string => typeof id === "string"),
            agentIds: Array.isArray(data.subject.agentIds) ? data.subject.agentIds.filter((id): id is string => typeof id === "string") : [],
            directAgentIds: Array.isArray(data.subject.directAgentIds) ? data.subject.directAgentIds.filter((id): id is string => typeof id === "string") : [],
        }
        : null;
    return { companyId: data.companyId, audience: data.audience ?? null, subject, payload: data.payload, message: JSON.stringify(data.payload) };
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

/**
 * A signed-in person's browser socket. Carries the same expanded allow-sets as
 * an agent socket, but resolved from the member scope (lib/member-scope.ts) —
 * projects follow their customer, agents follow the member's allow-list. null
 * everywhere = unrestricted (admin/owner).
 */
export type HumanViewer = {
    companyId?: string;
    userId?: string;
    /** Effective role, for callers that need it; the filter itself only reads the allow-sets. */
    role?: string;
    allowedProjectIds?: ReadonlySet<string> | null;
    allowedCustomerIds?: ReadonlySet<string> | null;
    allowedAgentIds?: ReadonlySet<string> | null;
    /** Customers of the projects granted directly (project memberships), whose events about those projects pass. */
    grantedProjectCustomerIds?: ReadonlySet<string> | null;
    /** Agents limited to other people (lib/agent-access.ts): nothing about them or their DMs reaches this person. */
    hiddenAgentIds?: ReadonlySet<string> | null;
};

/**
 * Whether a signed-in person's socket gets this notification.
 *
 * - A private direct thread (an event carrying an audience) reaches only its
 *   one human owner and never any other user; an orphaned or mixed-private
 *   event (owner null) reaches nobody.
 * - Company-wide events pass the member's scope: a restricted member only gets
 *   events whose agents, customers and projects are all inside their allow-list
 *   (same rule as agent sockets, socketMayReceiveSubject).
 */
export function humanSocketReceives(
    event: { companyId: string; audience: RealtimeAudience | null; subject?: RealtimeSubject | null },
    viewer: HumanViewer,
): boolean {
    if (!viewer.companyId || viewer.companyId !== event.companyId) return false;
    const hidden = viewer.hiddenAgentIds;
    if (hidden && hidden.size > 0 && event.subject
        && [...(event.subject.agentIds ?? []), ...(event.subject.directAgentIds ?? [])].some((id) => hidden.has(id))) return false;
    if (event.audience) {
        return Boolean(event.audience.ownerUserId) && event.audience.ownerUserId === viewer.userId;
    }
    const subject = event.subject;
    // A member granted a project directly (0.20 project Access) gets events
    // about it even though its customer is not on their list: alongside
    // visible projects, the customer of a directly granted project passes.
    const viaProjects = viewer.grantedProjectCustomerIds;
    if (subject && viaProjects && viaProjects.size > 0 && subject.projectIds.length > 0 && viewer.allowedProjectIds
        && subject.projectIds.every((id) => viewer.allowedProjectIds!.has(id))) {
        const customers = viewer.allowedCustomerIds ?? new Set<string>();
        return socketMayReceiveSubject({ ...subject, customerIds: subject.customerIds.filter((id) => !(viaProjects.has(id) && !customers.has(id))) }, viewer);
    }
    return socketMayReceiveSubject(subject, viewer);
}

// ── Browser socket upgrade guards (/api/ws) ─────────────────────────────────

/**
 * Cross-site WebSocket hijacking guard: the session cookie rides along on any
 * cross-origin upgrade, so a browser socket is accepted only when its Origin
 * names this server. Browsers always send Origin on a WebSocket handshake, so
 * a missing or unparsable one is rejected too. Hosts compare case-insensitively
 * and include the port.
 */
export function originMatchesHost(origin: string | string[] | undefined, allowedHosts: readonly (string | null | undefined)[]): boolean {
    const raw = Array.isArray(origin) ? origin[0] : origin;
    if (!raw || raw === "null") return false;
    let originHost: string;
    try {
        const url = new URL(raw);
        if (url.protocol !== "http:" && url.protocol !== "https:") return false;
        originHost = url.host.toLowerCase();
    } catch {
        return false;
    }
    return allowedHosts.some((host) => typeof host === "string" && host.trim().toLowerCase() === originHost);
}

/**
 * Per-user socket cap: given one user's sockets oldest first, the ones to close
 * so at most `max` remain (the oldest go first).
 */
export function socketsOverCap<T>(socketsOldestFirst: readonly T[], max: number): T[] {
    const excess = socketsOldestFirst.length - Math.max(0, max);
    return excess > 0 ? socketsOldestFirst.slice(0, excess) : [];
}
