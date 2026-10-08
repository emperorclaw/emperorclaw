import { and, asc, count, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, companyMembers, messageThreads, threadMessages, threadParticipants, users } from "@/db/schema";
import { resolveAgentId } from "@/lib/mcp";

/**
 * Group chats: shared channels like the team channel, but only for their
 * members. A group is a `message_threads` row with type = 'group'. Its AGENT
 * participants are the only agents that receive its messages (message sync is
 * already participant-scoped), and agents answer exactly as in team chat:
 * when @mentioned. Any company human can read and post; posting makes them a
 * member. Humans and agents (via MCP) create and manage groups alike.
 */

export const GROUP_THREAD_TYPE = "group";
/**
 * Reserved marker for a dedicated two-way thread between two agents. It is a
 * machine-managed description value, never a user-settable one: `cleanDescription`
 * rejects it, and a thread only counts as a pair thread when BOTH the marker and
 * `createdByType === "system"` hold (a user cannot forge the system creator).
 */
export const AGENT_PAIR_DESCRIPTION = "agent-pair";
export const MAX_GROUP_TITLE = 80;
export const MAX_GROUP_DESCRIPTION = 600;
export const MAX_GROUP_MEMBERS = 50;
export const MAX_GROUP_ICON = 16;
export const MAX_GROUPS_PER_COMPANY = 200;

/** Human participant rows created just by opening a group (read cursor only). */
export const READER_ROLE = "reader";

export class GroupError extends Error {
    constructor(message: string, public status: number) {
        super(message);
    }
}

export type GroupActor = { type: "human" | "agent" | "system"; id: string | null };

export interface GroupMember {
    kind: "agent" | "human";
    id: string;
    name: string;
    role: string;
    avatarUrl?: string | null;
    status?: string | null;
}

export interface GroupSummary {
    id: string;
    title: string;
    description: string | null;
    icon: string | null;
    createdByType: string;
    createdById: string | null;
    createdAt: string;
    members: GroupMember[];
    /** True when this is a machine-managed two-agent pair thread. */
    isAgentPair: boolean;
}

function cleanTitle(value: unknown): string {
    const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!title) throw new GroupError("A group needs a name", 400);
    if (title.length > MAX_GROUP_TITLE) throw new GroupError(`Group names are limited to ${MAX_GROUP_TITLE} characters`, 400);
    return title;
}

/** A short emoji (or a few characters); empty clears it back to the default. */
function cleanIcon(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new GroupError("icon must be a string", 400);
    const icon = value.trim();
    if ([...icon].length > 4 || icon.length > MAX_GROUP_ICON) throw new GroupError("icon must be one emoji", 400);
    return icon || null;
}

function cleanDescription(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new GroupError("description must be a string", 400);
    const description = value.trim();
    // The pair-thread marker is machine-managed: a user must not be able to turn
    // an ordinary group into a pair thread (which would let them read/route its
    // messages without a mention). Reject it outright.
    if (description === AGENT_PAIR_DESCRIPTION) throw new GroupError("That description is reserved", 400);
    if (description.length > MAX_GROUP_DESCRIPTION) throw new GroupError(`Descriptions are limited to ${MAX_GROUP_DESCRIPTION} characters`, 400);
    return description || null;
}

function stringList(value: unknown, field: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new GroupError(`${field} must be a list of strings`, 400);
    return [...new Set((value as string[]).map((v) => v.trim()).filter(Boolean))];
}

/** Agent ids or names → company agent ids. Unknown agents are an error, not a silent drop. */
async function resolveAgents(companyId: string, refs: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const ref of refs) {
        try {
            ids.push(await resolveAgentId(companyId, ref));
        } catch {
            throw new GroupError(`Agent not found: ${ref}`, 404);
        }
    }
    return [...new Set(ids)];
}

/** User ids → ids of users who belong to this company. */
async function resolveHumans(companyId: string, userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await db.select({ userId: companyMembers.userId }).from(companyMembers)
        .where(and(eq(companyMembers.companyId, companyId), inArray(companyMembers.userId, userIds)));
    const found = new Set(rows.map((r) => r.userId));
    const missing = userIds.filter((id) => !found.has(id));
    if (missing.length) throw new GroupError(`Not a member of this company: ${missing[0]}`, 404);
    return userIds;
}

export async function getGroupThread(companyId: string, groupId: string) {
    if (!/^[0-9a-f-]{36}$/i.test(groupId)) throw new GroupError("Group not found", 404);
    const [thread] = await db.select().from(messageThreads).where(and(
        eq(messageThreads.id, groupId),
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, GROUP_THREAD_TYPE),
        isNull(messageThreads.archivedAt),
    )).limit(1);
    if (!thread) throw new GroupError("Group not found", 404);
    return thread;
}

/** Members of the given groups, agents first, with display names. Readers are excluded. */
export async function loadGroupMembers(companyId: string, groupIds: string[]): Promise<Map<string, GroupMember[]>> {
    const result = new Map<string, GroupMember[]>(groupIds.map((id) => [id, []]));
    if (groupIds.length === 0) return result;
    const rows = await db.select().from(threadParticipants).where(and(
        eq(threadParticipants.companyId, companyId),
        inArray(threadParticipants.threadId, groupIds),
    )).orderBy(asc(threadParticipants.createdAt));

    const agentIds = [...new Set(rows.filter((r) => r.participantType === "agent" && r.participantId).map((r) => r.participantId!))];
    const userIds = [...new Set(rows.filter((r) => r.participantType === "human" && r.participantRef && r.role !== READER_ROLE).map((r) => r.participantRef!))];
    const [agentRows, userRows] = await Promise.all([
        agentIds.length
            ? db.select({ id: agents.id, name: agents.name, avatarUrl: agents.avatarUrl, status: agents.status }).from(agents)
                .where(and(eq(agents.companyId, companyId), inArray(agents.id, agentIds), isNull(agents.deletedAt)))
            : Promise.resolve([]),
        userIds.length
            ? db.select({ id: users.id, displayName: users.displayName, email: users.email }).from(users).where(inArray(users.id, userIds))
            : Promise.resolve([]),
    ]);
    const agentById = new Map(agentRows.map((a) => [a.id, a]));
    const userById = new Map(userRows.map((u) => [u.id, u]));

    for (const row of rows) {
        const list = result.get(row.threadId);
        if (!list) continue;
        if (row.participantType === "agent" && row.participantId) {
            const agent = agentById.get(row.participantId);
            if (agent) list.push({ kind: "agent", id: agent.id, name: agent.name, role: row.role, avatarUrl: agent.avatarUrl, status: agent.status });
        } else if (row.participantType === "human" && row.participantRef && row.role !== READER_ROLE) {
            const user = userById.get(row.participantRef);
            if (user) list.push({ kind: "human", id: user.id, name: user.displayName || user.email, role: row.role });
        }
    }
    for (const list of result.values()) list.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1));
    return result;
}

function summarize(thread: typeof messageThreads.$inferSelect, members: GroupMember[]): GroupSummary {
    const isPair = isAgentPairThread(thread);
    return {
        id: thread.id,
        title: thread.title || "Untitled group",
        description: isPair ? pairThreadPurpose(members) : thread.description,
        icon: thread.icon ?? null,
        createdByType: thread.createdByType,
        createdById: thread.createdById,
        createdAt: thread.createdAt.toISOString(),
        members,
        isAgentPair: isPair,
    };
}

/** Human-readable purpose for a pair thread — never the raw "agent-pair" marker. */
export function pairThreadPurpose(members: GroupMember[]): string {
    const agents = members.filter((m) => m.kind === "agent").map((m) => m.name);
    if (agents.length >= 2) return `Private agent conversation between ${agents[0]} and ${agents[1]}`;
    return "Private agent conversation";
}

export async function getGroup(companyId: string, groupId: string, actor?: GroupActor): Promise<GroupSummary> {
    const thread = await getGroupThread(companyId, groupId);
    if (actor) await assertCanReadGroup(companyId, thread, actor);
    const members = await loadGroupMembers(companyId, [thread.id]);
    return summarize(thread, members.get(thread.id) ?? []);
}

/** Every active group, optionally only those an agent belongs to. */
export async function listGroups(companyId: string, options: { agentId?: string | null; includePairThreads?: boolean } = {}): Promise<GroupSummary[]> {
    let threads = await db.select().from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, GROUP_THREAD_TYPE),
        isNull(messageThreads.archivedAt),
    )).orderBy(asc(messageThreads.title));
    if (options.includePairThreads === false) {
        // Pair threads are private agent handoffs; they must not show up in an
        // unscoped ("everything") listing for any MCP caller.
        threads = threads.filter((t) => !isAgentPairThread(t));
    }
    if (options.agentId) {
        const memberOf = await db.select({ threadId: threadParticipants.threadId }).from(threadParticipants).where(and(
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.participantType, "agent"),
            eq(threadParticipants.participantId, options.agentId),
        ));
        const ids = new Set(memberOf.map((m) => m.threadId));
        threads = threads.filter((t) => ids.has(t.id));
    }
    const members = await loadGroupMembers(companyId, threads.map((t) => t.id));
    return threads.map((t) => summarize(t, members.get(t.id) ?? []));
}

async function memberCount(groupId: string): Promise<number> {
    const [row] = await db.select({ value: count() }).from(threadParticipants).where(and(
        eq(threadParticipants.threadId, groupId),
        sql`${threadParticipants.role} <> ${READER_ROLE}`,
    ));
    return Number(row?.value) || 0;
}

async function insertMembers(companyId: string, groupId: string, agentIds: string[], userIds: string[], role = "member") {
    const rows = [
        ...agentIds.map((id) => ({ threadId: groupId, companyId, participantType: "agent", participantId: id, role })),
        ...userIds.map((id) => ({ threadId: groupId, companyId, participantType: "human", participantRef: id, role, lastReadAt: sql`now()` })),
    ];
    if (rows.length === 0) return;
    // Migration 0032's unique participant indexes make re-adding a member a no-op.
    await db.insert(threadParticipants).values(rows).onConflictDoNothing();
    // A human who only had a reader row becomes a real member.
    if (userIds.length) {
        await db.update(threadParticipants).set({ role })
            .where(and(
                eq(threadParticipants.threadId, groupId),
                eq(threadParticipants.participantType, "human"),
                inArray(threadParticipants.participantRef, userIds),
                eq(threadParticipants.role, READER_ROLE),
            ));
    }
}

export async function createGroup(companyId: string, actor: GroupActor, input: {
    title: unknown;
    description?: unknown;
    icon?: unknown;
    agentIds?: unknown;
    humanUserIds?: unknown;
}): Promise<GroupSummary> {
    const title = cleanTitle(input.title);
    const description = cleanDescription(input.description);
    const icon = cleanIcon(input.icon);
    const agentIds = await resolveAgents(companyId, stringList(input.agentIds, "agentIds"));
    const userIds = await resolveHumans(companyId, stringList(input.humanUserIds, "humanUserIds"));

    // The creator is always a member, so an agent that opens a group can talk in it.
    if (actor.type === "agent" && actor.id && !agentIds.includes(actor.id)) agentIds.unshift(actor.id);
    if (actor.type === "human" && actor.id && !userIds.includes(actor.id)) userIds.unshift(actor.id);
    if (agentIds.length + userIds.length > MAX_GROUP_MEMBERS) throw new GroupError(`Groups are limited to ${MAX_GROUP_MEMBERS} members`, 400);

    const [existing] = await db.select({ value: count() }).from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, GROUP_THREAD_TYPE),
        isNull(messageThreads.archivedAt),
    ));
    if ((Number(existing?.value) || 0) >= MAX_GROUPS_PER_COMPANY) throw new GroupError(`A company can have at most ${MAX_GROUPS_PER_COMPANY} active groups`, 400);

    const [thread] = await db.insert(messageThreads).values({
        companyId,
        type: GROUP_THREAD_TYPE,
        title,
        description,
        icon,
        createdByType: actor.type,
        createdById: actor.id && /^[0-9a-f-]{36}$/i.test(actor.id) ? actor.id : null,
    }).returning();

    await insertMembers(companyId, thread.id, agentIds, userIds);
    // The creator owns the group (only display today; no extra powers).
    const creator = actor.type === "agent" ? { col: threadParticipants.participantId, type: "agent" } : actor.type === "human" ? { col: threadParticipants.participantRef, type: "human" } : null;
    if (creator && actor.id) {
        await db.update(threadParticipants).set({ role: "owner" }).where(and(
            eq(threadParticipants.threadId, thread.id),
            eq(threadParticipants.participantType, creator.type),
            eq(creator.col, actor.id),
        ));
    }
    return getGroup(companyId, thread.id);
}

export async function updateGroup(companyId: string, groupId: string, input: { title?: unknown; description?: unknown; icon?: unknown }): Promise<GroupSummary> {
    const thread = await getGroupThread(companyId, groupId);
    if (isAgentPairThread(thread)) throw new GroupError("A pair thread cannot be edited", 403);
    const patch: Partial<typeof messageThreads.$inferInsert> = {};
    if (input.title !== undefined) patch.title = cleanTitle(input.title);
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (input.icon !== undefined) patch.icon = cleanIcon(input.icon);
    if (Object.keys(patch).length) await db.update(messageThreads).set(patch).where(eq(messageThreads.id, thread.id));
    return getGroup(companyId, thread.id);
}

export async function addGroupMembers(companyId: string, groupId: string, input: { agentIds?: unknown; humanUserIds?: unknown }): Promise<GroupSummary> {
    const thread = await getGroupThread(companyId, groupId);
    if (isAgentPairThread(thread)) throw new GroupError("A pair thread cannot gain members", 403);
    const agentIds = await resolveAgents(companyId, stringList(input.agentIds, "agentIds"));
    const userIds = await resolveHumans(companyId, stringList(input.humanUserIds, "humanUserIds"));
    if (agentIds.length + userIds.length === 0) throw new GroupError("Nobody to add", 400);
    if ((await memberCount(thread.id)) + agentIds.length + userIds.length > MAX_GROUP_MEMBERS) {
        throw new GroupError(`Groups are limited to ${MAX_GROUP_MEMBERS} members`, 400);
    }
    await insertMembers(companyId, thread.id, agentIds, userIds);
    return getGroup(companyId, thread.id);
}

export async function removeGroupMember(companyId: string, groupId: string, member: { kind: unknown; id: unknown }): Promise<GroupSummary> {
    const thread = await getGroupThread(companyId, groupId);
    if (isAgentPairThread(thread)) throw new GroupError("A pair thread cannot lose members", 403);
    if (typeof member.id !== "string" || !member.id) throw new GroupError("Member id is required", 400);
    if (member.kind === "agent") {
        const agentId = await resolveAgents(companyId, [member.id]).then((ids) => ids[0]);
        await db.delete(threadParticipants).where(and(
            eq(threadParticipants.threadId, thread.id),
            eq(threadParticipants.participantType, "agent"),
            eq(threadParticipants.participantId, agentId),
        ));
    } else if (member.kind === "human") {
        // Keep the read cursor; just stop being a member.
        await db.update(threadParticipants).set({ role: READER_ROLE }).where(and(
            eq(threadParticipants.threadId, thread.id),
            eq(threadParticipants.participantType, "human"),
            eq(threadParticipants.participantRef, member.id),
        ));
    } else {
        throw new GroupError('kind must be "agent" or "human"', 400);
    }
    return getGroup(companyId, thread.id);
}

export async function archiveGroup(companyId: string, groupId: string): Promise<void> {
    const thread = await getGroupThread(companyId, groupId);
    if (isAgentPairThread(thread)) throw new GroupError("A pair thread cannot be archived", 403);
    await db.update(messageThreads).set({ archivedAt: new Date() }).where(eq(messageThreads.id, thread.id));
}

export async function isAgentGroupMember(companyId: string, groupId: string, agentId: string): Promise<boolean> {
    const [row] = await db.select({ id: threadParticipants.id }).from(threadParticipants).where(and(
        eq(threadParticipants.companyId, companyId),
        eq(threadParticipants.threadId, groupId),
        eq(threadParticipants.participantType, "agent"),
        eq(threadParticipants.participantId, agentId),
    )).limit(1);
    return Boolean(row);
}

/**
 * A dedicated two-way thread between two agents. It reuses `message_threads`
 * with type 'group' (which old runtimes already sync and scope by participant)
 * and is marked by the reserved `description` AND `createdByType === "system"`.
 * Both agents are participants, so a message posted by either reaches the
 * other, and the routing verdict marks it `agent_pair` (addressed without
 * @mention). Company owners/admins can read it in the Messages UI under groups.
 */
export function isAgentPairThread(thread: { description: string | null; createdByType: string | null }): boolean {
    // Both the reserved marker AND a system creator: description alone is
    // user-settable, so a human/agent-created group with the marker is not a
    // pair thread (and `cleanDescription` rejects the marker anyway).
    return thread.description === AGENT_PAIR_DESCRIPTION && thread.createdByType === "system";
}

function agentPairTitle(nameA: string, nameB: string): string {
    return `${nameA} ↔ ${nameB}`;
}

export async function ensureAgentPairThread(companyId: string, agentA: string, agentB: string) {
    if (agentA === agentB) {
        throw new Error("Agent pair requires two distinct agents");
    }
    const [first, second] = [agentA, agentB].sort();

    return db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`agent-pair:${companyId}:${first}:${second}`}))`);

        // A pair thread already exists only if a SYSTEM-created group thread
        // with the reserved marker has exactly these two agents as participants.
        const candidates = await tx.select({ threadId: threadParticipants.threadId })
            .from(threadParticipants)
            .innerJoin(messageThreads, and(
                eq(messageThreads.id, threadParticipants.threadId),
                eq(messageThreads.companyId, companyId),
                eq(messageThreads.type, GROUP_THREAD_TYPE),
                eq(messageThreads.description, AGENT_PAIR_DESCRIPTION),
                eq(messageThreads.createdByType, "system"),
                isNull(messageThreads.archivedAt),
            ))
            .where(and(
                eq(threadParticipants.companyId, companyId),
                eq(threadParticipants.participantType, "agent"),
                eq(threadParticipants.participantId, first),
            ));

        for (const candidate of candidates) {
            const [other] = await tx.select({ id: threadParticipants.id })
                .from(threadParticipants)
                .where(and(
                    eq(threadParticipants.companyId, companyId),
                    eq(threadParticipants.threadId, candidate.threadId),
                    eq(threadParticipants.participantType, "agent"),
                    eq(threadParticipants.participantId, second),
                ))
                .limit(1);
            if (!other) continue;
            // Exactly two AGENT participants: a pair thread counts only its
            // agents, so a human's read-cursor ("reader") row from opening the
            // thread must not make it look like it gained a member.
            const [{ value: total }] = await tx.select({ value: count() }).from(threadParticipants)
                .where(and(
                    eq(threadParticipants.companyId, companyId),
                    eq(threadParticipants.threadId, candidate.threadId),
                    eq(threadParticipants.participantType, "agent"),
                ));
            if (Number(total) !== 2) continue;
            const [existing] = await tx.select().from(messageThreads)
                .where(eq(messageThreads.id, candidate.threadId)).limit(1);
            if (existing) return existing;
        }

        const [nameA, nameB] = await Promise.all([
            tx.select({ name: agents.name }).from(agents)
                .where(and(eq(agents.id, first), eq(agents.companyId, companyId))).limit(1)
                .then((rows) => rows[0]?.name ?? "Agent"),
            tx.select({ name: agents.name }).from(agents)
                .where(and(eq(agents.id, second), eq(agents.companyId, companyId))).limit(1)
                .then((rows) => rows[0]?.name ?? "Agent"),
        ]);

        const [created] = await tx.insert(messageThreads).values({
            companyId,
            type: GROUP_THREAD_TYPE,
            title: agentPairTitle(nameA, nameB),
            description: AGENT_PAIR_DESCRIPTION,
            createdByType: "system",
        }).returning();

        await tx.insert(threadParticipants).values([
            { threadId: created.id, companyId, participantType: "agent", participantId: first, role: "member" },
            { threadId: created.id, companyId, participantType: "agent", participantId: second, role: "member" },
        ]);

        return created;
    });
}

/** Posting in a group makes a human a member (a reader row is promoted). */
export async function joinGroupAsHuman(companyId: string, groupId: string, userId: string): Promise<void> {
    await insertMembers(companyId, groupId, [], [userId]);
}

/** Owners and admins: the only humans allowed to read an agent pair thread. */
export async function isCompanyOwnerOrAdmin(companyId: string, userId: string): Promise<boolean> {
    const [row] = await db.select({ role: companyMembers.role }).from(companyMembers)
        .where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, userId)))
        .limit(1);
    return row?.role === "owner" || row?.role === "admin";
}

/**
 * A pair thread is a private agent handoff: only its member agents and the
 * company's owners/admins may read it. Ordinary groups are readable by anyone
 * in the company, so this is a no-op for them. Operator (system) tokens are
 * allowed through — they are the company-wide credential that creates and
 * manages agents.
 */
export async function assertCanReadGroup(companyId: string, thread: typeof messageThreads.$inferSelect, actor: GroupActor): Promise<void> {
    if (!isAgentPairThread(thread)) return;
    if (actor.type === "agent" && actor.id) {
        if (!(await isAgentGroupMember(companyId, thread.id, actor.id))) {
            throw new GroupError("Access denied: that pair thread is private", 403);
        }
    } else if (actor.type === "human" && actor.id) {
        if (!(await isCompanyOwnerOrAdmin(companyId, actor.id))) {
            throw new GroupError("Access denied: that pair thread is private", 403);
        }
    }
}

/** The other agent participant in a pair thread, or null when there isn't one. */
export async function pairThreadCounterpart(companyId: string, threadId: string, agentId: string): Promise<string | null> {
    const [row] = await db.select({ participantId: threadParticipants.participantId }).from(threadParticipants).where(and(
        eq(threadParticipants.companyId, companyId),
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.participantType, "agent"),
        ne(threadParticipants.participantId, agentId),
    )).limit(1);
    return row?.participantId ?? null;
}

const TASK_LINK_RE = /emperor:\/\/task\/([0-9a-fA-F-]{36})/;

/**
 * The task a pair-thread conversation is about, if any: a task link in a
 * message (`emperor://task/<id>`), or a task id carried in message metadata
 * (`taskId` / `taskIds`). `messages` is newest-first; the newest match wins.
 * Pure — no DB access — so the derivation is unit-tested directly.
 */
export function relatedTaskId(messages: Array<{ text?: string | null; metadataJson?: unknown }>): string | null {
    for (const message of messages) {
        const link = TASK_LINK_RE.exec(message.text ?? "");
        if (link) return link[1];
        const metadata = message.metadataJson && typeof message.metadataJson === "object" ? (message.metadataJson as Record<string, unknown>) : {};
        const taskIds = metadata.taskIds;
        if (Array.isArray(taskIds) && typeof taskIds[0] === "string" && taskIds[0]) return taskIds[0];
        const taskId = metadata.taskId;
        if (typeof taskId === "string" && taskId) return taskId;
    }
    return null;
}

/** A read-only summary of one of an agent's active pair threads. */
export interface AgentConversation {
    threadId: string;
    counterpart: { id: string; name: string; avatarUrl: string | null } | null;
    lastMessageText: string | null;
    lastMessageAt: string | null;
    relatedTaskId: string | null;
}

/** An agent's active pair threads, newest activity first, capped. */
export async function listAgentConversations(companyId: string, agentId: string, limit = 5): Promise<AgentConversation[]> {
    const pairThreads = await db.select({ id: messageThreads.id })
        .from(messageThreads)
        .innerJoin(threadParticipants, eq(threadParticipants.threadId, messageThreads.id))
        .where(and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, GROUP_THREAD_TYPE),
            eq(messageThreads.description, AGENT_PAIR_DESCRIPTION),
            eq(messageThreads.createdByType, "system"),
            isNull(messageThreads.archivedAt),
            eq(threadParticipants.companyId, companyId),
            eq(threadParticipants.participantType, "agent"),
            eq(threadParticipants.participantId, agentId),
        ));
    if (pairThreads.length === 0) return [];
    const threadIds = pairThreads.map((t) => t.id);

    const counterpartRows = await db.select({ threadId: threadParticipants.threadId, participantId: threadParticipants.participantId })
        .from(threadParticipants)
        .where(and(
            eq(threadParticipants.companyId, companyId),
            inArray(threadParticipants.threadId, threadIds),
            eq(threadParticipants.participantType, "agent"),
            ne(threadParticipants.participantId, agentId),
        ));
    const counterpartIdByThread = new Map<string, string>();
    for (const row of counterpartRows) if (row.participantId) counterpartIdByThread.set(row.threadId, row.participantId);
    const counterpartIds = [...new Set(counterpartIdByThread.values())];

    const [agentRows, latest, recentMessages] = await Promise.all([
        counterpartIds.length
            ? db.select({ id: agents.id, name: agents.name, avatarUrl: agents.avatarUrl }).from(agents)
                .where(and(eq(agents.companyId, companyId), inArray(agents.id, counterpartIds), isNull(agents.deletedAt)))
            : Promise.resolve([]),
        db.selectDistinctOn([threadMessages.threadId], { threadId: threadMessages.threadId, text: threadMessages.text, createdAt: threadMessages.createdAt })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, threadIds)))
            .orderBy(threadMessages.threadId, desc(threadMessages.createdAt)),
        db.select({ threadId: threadMessages.threadId, text: threadMessages.text, metadataJson: threadMessages.metadataJson })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, threadIds)))
            .orderBy(desc(threadMessages.createdAt))
            .limit(threadIds.length * 20),
    ]);
    const agentById = new Map(agentRows.map((a) => [a.id, a]));
    const latestByThread = new Map(latest.map((l) => [l.threadId, l]));
    const messagesByThread = new Map<string, Array<{ text: string | null; metadataJson: unknown }>>();
    for (const m of recentMessages) {
        const list = messagesByThread.get(m.threadId) ?? [];
        list.push({ text: m.text, metadataJson: m.metadataJson });
        messagesByThread.set(m.threadId, list);
    }

    return pairThreads
        .map((t) => {
            const counterpartId = counterpartIdByThread.get(t.id);
            const counterpart = counterpartId ? agentById.get(counterpartId) ?? null : null;
            const last = latestByThread.get(t.id);
            return {
                threadId: t.id,
                counterpart: counterpart ? { id: counterpart.id, name: counterpart.name, avatarUrl: counterpart.avatarUrl } : null,
                lastMessageText: last?.text ?? null,
                lastMessageAt: last ? last.createdAt.toISOString() : null,
                relatedTaskId: relatedTaskId(messagesByThread.get(t.id) ?? []),
            };
        })
        .filter((c) => c.counterpart !== null)
        .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""))
        .slice(0, limit);
}

export interface GroupListEntry extends GroupSummary {
    unreadCount: number;
    lastMessageText: string | null;
    lastMessageAt: string | null;
    /** The task a pair-thread conversation is about (pair threads only). */
    relatedTaskId: string | null;
}

/** Groups for the Messages sidebar: last message and this user's unread count. */
export async function listGroupsForUser(companyId: string, userId: string): Promise<GroupListEntry[]> {
    // Pair threads are a private agent handoff. Only owners/admins see them
    // (read-only); everyone else gets the ordinary groups they belong to.
    const isAdmin = await isCompanyOwnerOrAdmin(companyId, userId);
    let groups = await listGroups(companyId);
    if (!isAdmin) groups = groups.filter((g) => !g.isAgentPair);
    if (groups.length === 0) return [];
    const ids = groups.map((g) => g.id);
    const latest = await db.selectDistinctOn([threadMessages.threadId], { threadId: threadMessages.threadId, text: threadMessages.text, createdAt: threadMessages.createdAt })
        .from(threadMessages)
        .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, ids)))
        .orderBy(threadMessages.threadId, desc(threadMessages.createdAt));
    const latestBy = new Map(latest.map((l) => [l.threadId, l]));
    const unread = await db.select({ threadId: threadMessages.threadId, value: count() }).from(threadMessages)
        .leftJoin(threadParticipants, and(
            eq(threadParticipants.threadId, threadMessages.threadId),
            eq(threadParticipants.participantType, "human"),
            eq(threadParticipants.participantRef, userId),
        ))
        .where(and(
            eq(threadMessages.companyId, companyId),
            inArray(threadMessages.threadId, ids),
            eq(threadMessages.senderType, "agent"),
            // Only members get an unread badge; a group you never opened stays quiet.
            sql`${threadParticipants.id} IS NOT NULL AND ${threadParticipants.role} <> ${READER_ROLE}`,
            sql`(${threadParticipants.lastReadAt} IS NULL OR ${threadMessages.createdAt} > ${threadParticipants.lastReadAt})`,
        ))
        .groupBy(threadMessages.threadId);
    const unreadBy = new Map(unread.map((u) => [u.threadId, Number(u.value) || 0]));
    // Related task for pair threads, derived from their recent messages.
    const pairIds = groups.filter((g) => g.isAgentPair).map((g) => g.id);
    const pairMessages = pairIds.length
        ? await db.select({ threadId: threadMessages.threadId, text: threadMessages.text, metadataJson: threadMessages.metadataJson })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, pairIds)))
            .orderBy(desc(threadMessages.createdAt))
            .limit(pairIds.length * 20)
        : [];
    const pairMessagesByThread = new Map<string, Array<{ text: string | null; metadataJson: unknown }>>();
    for (const m of pairMessages) {
        const list = pairMessagesByThread.get(m.threadId) ?? [];
        list.push({ text: m.text, metadataJson: m.metadataJson });
        pairMessagesByThread.set(m.threadId, list);
    }
    const relatedTaskByThread = new Map<string, string | null>();
    for (const id of pairIds) relatedTaskByThread.set(id, relatedTaskId(pairMessagesByThread.get(id) ?? []));
    return groups
        .map((g) => {
            const last = latestBy.get(g.id);
            return {
                ...g,
                unreadCount: unreadBy.get(g.id) ?? 0,
                lastMessageText: last?.text ?? null,
                lastMessageAt: last ? last.createdAt.toISOString() : null,
                relatedTaskId: g.isAgentPair ? relatedTaskByThread.get(g.id) ?? null : null,
            };
        })
        .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
}
