import { and, asc, eq, inArray, isNull, ne, notInArray, type AnyColumn, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { agentAccess, agents, companyMembers, messageThreads, threadParticipants, users } from "@/db/schema";
import {
    agentAccessChangeAllowed, agentUse, isAgentAccessMode, normalizeAgentAccess,
    type AgentAccessFacts, type AgentAccessMode, type AgentUse,
} from "@/lib/agent-access";
import { humanActor, recordAudit } from "@/lib/audit";
import { memberMaySeeAgent, normalizeMemberScope, type MemberScope } from "@/lib/member-scope";
import { mentionedAgentIds } from "@/lib/message-routing";
import { roleGte, type Role } from "@/lib/role-matrix";

/**
 * Server side of lib/agent-access.ts: gathers the facts (which agents are
 * limited to some people, who is on their list) and answers for one person.
 * Only agents whose access is not 'everyone' are loaded, so a company that
 * never limits an agent pays one small query and nothing changes. Loaded once
 * per viewer object (one request's guard context), never across requests.
 */

export type AgentAccessViewer = { companyId: string; userId: string; role: Role; scope: MemberScope | null };

export type LimitedAgent = AgentAccessFacts & { id: string; name: string };

/** The company's agents limited to some people, with their people lists (one fresh read). */
export async function loadLimitedAgents(companyId: string): Promise<Map<string, LimitedAgent>> {
    const rows = await db.select({ id: agents.id, name: agents.name, access: agents.access, ownerUserId: agents.ownerUserId })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), isNull(agents.deletedAt), ne(agents.access, "everyone")));
    const out = new Map<string, LimitedAgent>(rows.map((row) => [row.id, { ...row, people: [] as string[] }]));
    const peopleAgents = rows.filter((row) => row.access === "people").map((row) => row.id);
    if (peopleAgents.length > 0) {
        const people = await db.select({ agentId: agentAccess.agentId, userId: agentAccess.userId }).from(agentAccess)
            .where(and(eq(agentAccess.companyId, companyId), inArray(agentAccess.agentId, peopleAgents)));
        for (const row of people) (out.get(row.agentId)!.people as string[]).push(row.userId);
    }
    return out;
}

const limitedMemo = new WeakMap<object, Promise<Map<string, LimitedAgent>>>();

/** loadLimitedAgents, memoized on the viewer object so one request reads it once. */
function limitedAgentsFor(viewer: AgentAccessViewer): Promise<Map<string, LimitedAgent>> {
    let rows = limitedMemo.get(viewer);
    if (!rows) {
        rows = loadLimitedAgents(viewer.companyId);
        limitedMemo.set(viewer, rows);
    }
    return rows;
}

/**
 * The canonical id of the agent a request names, resolved exactly like the
 * writes resolve it (lib/mcp.ts resolveAgentId: trimmed, a UUID in any case,
 * or a name). null = no such agent in this company (callers deny).
 */
export async function canonicalAgentId(companyId: string, ref: unknown): Promise<string | null> {
    if (typeof ref !== "string" || !ref.trim()) return null;
    const { resolveAgentId } = await import("@/lib/mcp");
    try {
        return await resolveAgentId(companyId, ref);
    } catch {
        return null;
    }
}

function isAdmin(viewer: AgentAccessViewer): boolean {
    return roleGte(viewer.role, "admin");
}

/**
 * What this person may do with one agent: "full", "metadata" (owners/admins)
 * or "none". `agentRef` is resolved to the canonical id first (a name, an
 * uppercase UUID); an agent that does not exist is "none", never "full".
 */
export async function agentUseFor(viewer: AgentAccessViewer, agentRef: string | null | undefined): Promise<AgentUse> {
    const agentId = await canonicalAgentId(viewer.companyId, agentRef);
    if (!agentId) return "none";
    return canonicalAgentUse(viewer, agentId, await limitedAgentsFor(viewer));
}

function canonicalAgentUse(viewer: AgentAccessViewer, agentId: string, limitedAgents: Map<string, LimitedAgent>): AgentUse {
    const inScope = memberMaySeeAgent(viewer.scope, agentId);
    const limited = limitedAgents.get(agentId);
    if (!limited) return inScope ? "full" : "none";
    return agentUse({ userId: viewer.userId, isAdmin: isAdmin(viewer) }, limited, inScope);
}

/** May this person chat with, mention, assign or open the private chats of this agent? */
export async function memberMayUseAgent(viewer: AgentAccessViewer, agentId: string | null | undefined): Promise<boolean> {
    return (await agentUseFor(viewer, agentId)) === "full";
}

/**
 * The limited agents this person may NOT use (inside their scope or not).
 * `metadata` is the subset an owner/admin still sees as a locked card.
 */
export async function agentsNotUsableBy(viewer: AgentAccessViewer): Promise<{ hidden: Set<string>; metadata: Set<string> }> {
    const hidden = new Set<string>();
    const metadata = new Set<string>();
    const subject = { userId: viewer.userId, isAdmin: isAdmin(viewer) };
    for (const agent of (await limitedAgentsFor(viewer)).values()) {
        const use = agentUse(subject, agent, memberMaySeeAgent(viewer.scope, agent.id));
        if (use === "full") continue;
        hidden.add(agent.id);
        if (use === "metadata") metadata.add(agent.id);
    }
    return { hidden, metadata };
}

/** SQL filter dropping the agents this person may not use (undefined = no filter). */
export function usableAgentCondition(hidden: ReadonlySet<string>, column: AnyColumn): SQL | undefined {
    return hidden.size > 0 ? notInArray(column, [...hidden]) : undefined;
}

/**
 * Every agent a create/update body would hand work to must exist and be
 * usable (refs resolved like the write resolves them; one limited-agents read).
 */
export async function memberMayUseAllAgents(viewer: AgentAccessViewer, agentRefs: readonly unknown[]): Promise<boolean> {
    if (agentRefs.length === 0) return true;
    const limited = await limitedAgentsFor(viewer);
    for (const ref of agentRefs) {
        const id = await canonicalAgentId(viewer.companyId, ref);
        if (!id || canonicalAgentUse(viewer, id, limited) !== "full") return false;
    }
    return true;
}

/** Agents @mentioned in `text` that this person may not use (so they cannot wake them). */
export async function mentionedAgentsNotUsable(viewer: AgentAccessViewer, text: string): Promise<{ id: string; name: string }[]> {
    if (!text || !text.includes("@")) return [];
    const { hidden } = await agentsNotUsableBy(viewer);
    if (hidden.size === 0) return [];
    const roster = await db.select({ id: agents.id, name: agents.name }).from(agents)
        .where(and(eq(agents.companyId, viewer.companyId), isNull(agents.deletedAt)));
    const mentioned = mentionedAgentIds(text, roster);
    return roster.filter((agent) => mentioned.has(agent.id) && hidden.has(agent.id));
}

/** Owner names for agent cards ("Only Ana"). */
export async function ownerNames(userIds: readonly (string | null)[]): Promise<Map<string, string>> {
    const ids = [...new Set(userIds.filter((id): id is string => Boolean(id)))];
    if (ids.length === 0) return new Map();
    const rows = await db.select({ id: users.id, name: users.displayName, email: users.email }).from(users).where(inArray(users.id, ids));
    return new Map(rows.map((row) => [row.id, row.name || UNNAMED_MEMBER]));
}

// ─── Changing who can use an agent ─────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class AgentAccessError extends Error {
    constructor(message: string, readonly status: 400 | 403 | 404) {
        super(message);
        this.name = "AgentAccessError";
    }
}

export type AgentAccessInfo = {
    access: AgentAccessMode;
    owner: { id: string; name: string } | null;
    people: { id: string; name: string }[];
};

type Person = { id: string; name: string };

/** A person's display name; never derived from their email. */
export const UNNAMED_MEMBER = "Unnamed member";

/** Company members (not deleted) whose member scope lets them see this agent. */
export async function membersWhoCanSeeAgent(companyId: string, agentId: string): Promise<Person[]> {
    const rows = await db.select({ userId: companyMembers.userId, role: companyMembers.role, scopeJson: companyMembers.scopeJson, instanceRole: users.instanceRole, name: users.displayName, email: users.email })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), isNull(users.deletedAt))).orderBy(asc(users.email)).limit(500);
    const out: Person[] = [];
    for (const row of rows) {
        const unrestricted = row.role === "owner" || row.role === "admin" || row.instanceRole === "instance_admin";
        // Agent visibility only reads scope_json.agentIds, so no membership lookup is needed.
        const scope = unrestricted ? null : normalizeMemberScope(row.scopeJson);
        if (memberMaySeeAgent(scope, agentId)) out.push({ id: row.userId, name: row.name || UNNAMED_MEMBER });
    }
    return out;
}

export async function loadAgentAccessInfo(companyId: string, agentId: string): Promise<AgentAccessInfo | null> {
    if (!UUID_RE.test(agentId)) return null;
    const [agent] = await db.select({ access: agents.access, ownerUserId: agents.ownerUserId }).from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.id, agentId), isNull(agents.deletedAt))).limit(1);
    if (!agent) return null;
    const people = await db.select({ userId: agentAccess.userId }).from(agentAccess)
        .where(and(eq(agentAccess.companyId, companyId), eq(agentAccess.agentId, agentId)));
    const names = await ownerNames([agent.ownerUserId, ...people.map((p) => p.userId)]);
    return {
        access: normalizeAgentAccess(agent.access),
        owner: agent.ownerUserId ? { id: agent.ownerUserId, name: names.get(agent.ownerUserId) ?? "Former member" } : null,
        people: people.map((p) => ({ id: p.userId, name: names.get(p.userId) ?? "Former member" })),
    };
}

/**
 * Set who can use an agent: its access mode, the people list ('people') and
 * its owner. Only its owner, owners and admins; an admin never lets
 * themselves in (lib/agent-access.ts agentAccessChangeAllowed). Everyone named
 * must be a member who can see the agent through their member scope. Audited;
 * an owner change notifies the previous and the new owner.
 */
export async function setAgentAccess(
    viewer: AgentAccessViewer,
    agentId: string,
    input: { access?: unknown; userIds?: unknown; ownerUserId?: unknown },
): Promise<AgentAccessInfo> {
    const before = await loadAgentAccessInfo(viewer.companyId, agentId);
    if (!before || (await agentUseFor(viewer, agentId)) === "none") throw new AgentAccessError("Agent not found", 404);
    const access = input.access === undefined ? before.access : input.access;
    if (!isAgentAccessMode(access)) throw new AgentAccessError("access must be everyone, people or owner", 400);
    const visible = new Map((await membersWhoCanSeeAgent(viewer.companyId, agentId)).map((p) => [p.id, p]));

    let ownerUserId = before.owner?.id ?? null;
    if (input.ownerUserId !== undefined) {
        if (input.ownerUserId === null) ownerUserId = null;
        else if (typeof input.ownerUserId !== "string" || !visible.has(input.ownerUserId)) throw new AgentAccessError("The owner must be a member who can see this agent", 400);
        else ownerUserId = input.ownerUserId;
    }
    // A limited agent with no owner yet: whoever limits it owns it, unless they named someone.
    if (access !== "everyone" && !ownerUserId) ownerUserId = viewer.userId;

    let people = before.people.map((p) => p.id);
    if (input.userIds !== undefined) {
        if (!Array.isArray(input.userIds) || input.userIds.some((id) => typeof id !== "string" || !visible.has(id))) {
            throw new AgentAccessError("Everyone on the list must be a member who can see this agent", 400);
        }
        people = [...new Set(input.userIds as string[])];
    }
    people = access === "people" ? people.filter((id) => id !== ownerUserId) : [];

    // An orphan: a limited agent whose owner was removed (member removal clears
    // owner_user_id, and deleting the user does via the FK). Only a NULL owner
    // counts: an instance admin without a company membership may own agents.
    const ownerGone = before.access !== "everyone" && before.owner === null;
    const decision = agentAccessChangeAllowed(
        { userId: viewer.userId, isAdmin: isAdmin(viewer) },
        { access: before.access, ownerUserId: before.owner?.id ?? null, people: before.people.map((p) => p.id) },
        { access, ownerUserId, people },
        { ownerGone },
    );
    if (!decision.ok) throw new AgentAccessError(decision.error, decision.status);

    await db.transaction(async (tx) => {
        await tx.update(agents).set({ access, ownerUserId }).where(and(eq(agents.companyId, viewer.companyId), eq(agents.id, agentId)));
        await tx.delete(agentAccess).where(and(eq(agentAccess.companyId, viewer.companyId), eq(agentAccess.agentId, agentId)));
        if (people.length) await tx.insert(agentAccess).values(people.map((userId) => ({ agentId, userId, companyId: viewer.companyId })));
        if (ownerGone) {
            // Recovering an orphan never opens the old owner's history. Their
            // private threads were archived when they left and stay owner-bound;
            // nobody else's private chat is touched. The agent's SHARED direct
            // threads (no owner, not private) are archived and marked private
            // with no owner, which makes them "belong to nobody"
            // (lib/direct-chat-mode.ts): their messages and their runs' steps
            // and summaries are redacted like any private thread's
            // (run-ledger-reads), while the agent itself keeps its own context.
            const sealed = await tx.update(messageThreads).set({ archivedAt: new Date(), isPrivate: true }).where(and(
                eq(messageThreads.companyId, viewer.companyId), eq(messageThreads.type, "direct"),
                eq(messageThreads.directAgentId, agentId), isNull(messageThreads.archivedAt),
                isNull(messageThreads.ownerUserId), eq(messageThreads.isPrivate, false),
            )).returning({ id: messageThreads.id });
            // Run visibility is participant-based (agent-activity loadThreadVisibility):
            // with no human participants left, those runs read as a private chat.
            if (sealed.length) {
                await tx.delete(threadParticipants).where(and(
                    inArray(threadParticipants.threadId, sealed.map((t) => t.id)), eq(threadParticipants.participantType, "human"),
                ));
            }
        }
    });

    const [agent] = await db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).limit(1);
    const label = agent?.name ?? "agent";
    const samePeople = [...before.people.map((p) => p.id)].sort().join() === [...people].sort().join();
    if (before.access !== access || !samePeople) {
        // Who is on the list stays out of the log: a count only.
        await recordAudit({
            companyId: viewer.companyId, actor: humanActor(viewer.userId), action: "agent.access_changed", target: { type: "agent", id: agentId },
            before: { access: before.access, accessCount: before.people.length }, after: { access, accessCount: people.length }, meta: { label },
        });
    }
    const previousOwner = before.owner?.id ?? null;
    if (ownerUserId && ownerUserId !== previousOwner) {
        const toName = visible.get(ownerUserId)?.name ?? "someone";
        await recordAudit({
            companyId: viewer.companyId, actor: humanActor(viewer.userId), action: "agent.owner_transferred", target: { type: "agent", id: agentId },
            before: { ownerUserId: previousOwner }, after: { ownerUserId }, meta: { label, toName },
        });
        await notifyAgentTransferred(viewer.companyId, { id: agentId, name: label, limited: access !== "everyone" }, { previousOwnerId: previousOwner, to: { id: ownerUserId, name: toName }, byUserId: viewer.userId });
    }
    const { broadcastMcpEvent } = await import("@/lib/pubsub");
    await broadcastMcpEvent(viewer.companyId, { type: "agent_access_changed", agentId });
    return (await loadAgentAccessInfo(viewer.companyId, agentId))!;
}

/** Tell the previous and the new owner (not whoever did it, they know). Never breaks the change. */
async function notifyAgentTransferred(companyId: string, agent: { id: string; name: string; limited: boolean }, input: { previousOwnerId: string | null; to: Person; byUserId: string }) {
    try {
        const { notify } = await import("@/lib/notifications");
        const by = (await ownerNames([input.byUserId])).get(input.byUserId) ?? "An admin";
        const common = {
            kind: "agent_transferred" as const, link: `/agents/${agent.id}`, sourceType: "agent", sourceId: agent.id,
            // A limited agent's name never reaches the company webhook.
            privateOutboundTitle: agent.limited ? "An agent changed owner" : null,
        };
        if (input.previousOwnerId && input.previousOwnerId !== input.byUserId) {
            await notify(companyId, [input.previousOwnerId], { ...common, title: `Your agent ${agent.name} was transferred to ${input.to.name} by ${by}`, dedupeKey: `agent_transferred:${agent.id}:from:${input.previousOwnerId}` });
        }
        if (input.to.id !== input.byUserId) {
            await notify(companyId, [input.to.id], { ...common, title: `${by} gave you the agent ${agent.name}`, dedupeKey: `agent_transferred:${agent.id}:to:${input.to.id}` });
        }
    } catch (error) {
        console.warn("[agents] transfer notification failed:", error instanceof Error ? error.message : error);
    }
}

/**
 * "Who can use it" at hire time: the person hiring owns the new agent; with
 * access other than 'everyone' (the default) it is limited right away. A
 * failure here never undoes the hire: the agent stays open to everyone.
 */
export async function applyHireAccess(viewer: AgentAccessViewer, agentId: string, body: { access?: unknown; accessUserIds?: unknown; ownerUserId?: unknown }): Promise<string | null> {
    await db.update(agents).set({ ownerUserId: viewer.userId }).where(and(eq(agents.companyId, viewer.companyId), eq(agents.id, agentId), isNull(agents.ownerUserId)));
    if (body.access === undefined || body.access === "everyone") return null;
    try {
        await setAgentAccess(viewer, agentId, { access: body.access, userIds: body.accessUserIds, ownerUserId: body.ownerUserId ?? viewer.userId });
        return null;
    } catch (error) {
        return error instanceof AgentAccessError ? error.message : "Could not limit who can use this agent";
    }
}

/** A company member as an agent-access viewer (role and fresh scope from the DB); null when not a member. */
export async function viewerForUser(companyId: string, userId: string): Promise<AgentAccessViewer | null> {
    // Inbound senders (webhooks) can carry any string: not a member, never a query error.
    if (typeof userId !== "string" || !UUID_RE.test(userId)) return null;
    const [row] = await db.select({ role: companyMembers.role, scopeJson: companyMembers.scopeJson, instanceRole: users.instanceRole })
        .from(companyMembers).innerJoin(users, eq(users.id, companyMembers.userId))
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId), isNull(users.deletedAt))).limit(1);
    if (!row) return null;
    const role = (row.instanceRole === "instance_admin" ? "instance_admin" : row.role) as Role;
    const { resolveMemberScope } = await import("@/lib/member-scope");
    return { companyId, userId, role, scope: roleGte(role, "admin") ? null : await resolveMemberScope(companyId, userId, row.scopeJson) };
}

/**
 * Notifications about an agent this person may not use (its status, or a
 * message in one of its threads) are dropped, like out-of-scope ones.
 */
export async function filterNotificationsForAgentUse<T extends { sourceType: string | null; sourceId: string | null }>(viewer: AgentAccessViewer, rows: T[]): Promise<T[]> {
    const { hidden } = await agentsNotUsableBy(viewer);
    if (hidden.size === 0) return rows;
    const messageIds = rows.filter((r) => r.sourceType === "message" && r.sourceId && UUID_RE.test(r.sourceId)).map((r) => r.sourceId as string);
    const { threadMessages, messageThreads } = await import("@/db/schema");
    const messages = messageIds.length
        ? await db.select({ id: threadMessages.id, senderType: threadMessages.senderType, senderId: threadMessages.senderId, targetAgentId: threadMessages.targetAgentId, directAgentId: messageThreads.directAgentId })
            .from(threadMessages).innerJoin(messageThreads, eq(messageThreads.id, threadMessages.threadId))
            .where(and(eq(threadMessages.companyId, viewer.companyId), inArray(threadMessages.id, messageIds)))
        : [];
    const hiddenMessage = new Set(messages.filter((m) => [m.directAgentId, m.targetAgentId, m.senderType === "agent" ? m.senderId : null]
        .some((id) => id && hidden.has(id))).map((m) => m.id));
    return rows.filter((row) => {
        if (row.sourceType === "agent") return !(row.sourceId && hidden.has(row.sourceId));
        if (row.sourceType === "message") return !(row.sourceId && hiddenMessage.has(row.sourceId));
        return true;
    });
}

/**
 * An agent allow-list for read surfaces that take one (undefined = all):
 * the member-scope list minus the limited agents this person may not use.
 * `metadataOk` keeps the ones an owner/admin sees as metadata (status, cost).
 */
export async function usableAgentIdList(viewer: AgentAccessViewer, scoped: readonly string[] | undefined, options: { metadataOk?: boolean } = {}): Promise<string[] | undefined> {
    const { hidden, metadata } = await agentsNotUsableBy(viewer);
    const drop = new Set([...hidden].filter((id) => !(options.metadataOk && metadata.has(id))));
    if (drop.size === 0) return scoped ? [...scoped] : undefined;
    const base = scoped ?? (await db.select({ id: agents.id }).from(agents)
        .where(and(eq(agents.companyId, viewer.companyId), isNull(agents.deletedAt)))).map((row) => row.id);
    return base.filter((id) => !drop.has(id));
}
