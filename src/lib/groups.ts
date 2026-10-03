import { and, asc, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
export const MAX_GROUP_TITLE = 80;
export const MAX_GROUP_DESCRIPTION = 600;
export const MAX_GROUP_MEMBERS = 50;
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
    createdByType: string;
    createdById: string | null;
    createdAt: string;
    members: GroupMember[];
}

function cleanTitle(value: unknown): string {
    const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
    if (!title) throw new GroupError("A group needs a name", 400);
    if (title.length > MAX_GROUP_TITLE) throw new GroupError(`Group names are limited to ${MAX_GROUP_TITLE} characters`, 400);
    return title;
}

function cleanDescription(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new GroupError("description must be a string", 400);
    const description = value.trim();
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
    return {
        id: thread.id,
        title: thread.title || "Untitled group",
        description: thread.description,
        createdByType: thread.createdByType,
        createdById: thread.createdById,
        createdAt: thread.createdAt.toISOString(),
        members,
    };
}

export async function getGroup(companyId: string, groupId: string): Promise<GroupSummary> {
    const thread = await getGroupThread(companyId, groupId);
    const members = await loadGroupMembers(companyId, [thread.id]);
    return summarize(thread, members.get(thread.id) ?? []);
}

/** Every active group, optionally only those an agent belongs to. */
export async function listGroups(companyId: string, options: { agentId?: string | null } = {}): Promise<GroupSummary[]> {
    let threads = await db.select().from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, GROUP_THREAD_TYPE),
        isNull(messageThreads.archivedAt),
    )).orderBy(asc(messageThreads.title));
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
    agentIds?: unknown;
    humanUserIds?: unknown;
}): Promise<GroupSummary> {
    const title = cleanTitle(input.title);
    const description = cleanDescription(input.description);
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

export async function updateGroup(companyId: string, groupId: string, input: { title?: unknown; description?: unknown }): Promise<GroupSummary> {
    const thread = await getGroupThread(companyId, groupId);
    const patch: Partial<typeof messageThreads.$inferInsert> = {};
    if (input.title !== undefined) patch.title = cleanTitle(input.title);
    if (input.description !== undefined) patch.description = cleanDescription(input.description);
    if (Object.keys(patch).length) await db.update(messageThreads).set(patch).where(eq(messageThreads.id, thread.id));
    return getGroup(companyId, thread.id);
}

export async function addGroupMembers(companyId: string, groupId: string, input: { agentIds?: unknown; humanUserIds?: unknown }): Promise<GroupSummary> {
    const thread = await getGroupThread(companyId, groupId);
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

/** Posting in a group makes a human a member (a reader row is promoted). */
export async function joinGroupAsHuman(companyId: string, groupId: string, userId: string): Promise<void> {
    await insertMembers(companyId, groupId, [], [userId]);
}

export interface GroupListEntry extends GroupSummary {
    unreadCount: number;
    lastMessageText: string | null;
    lastMessageAt: string | null;
}

/** Groups for the Messages sidebar: last message and this user's unread count. */
export async function listGroupsForUser(companyId: string, userId: string): Promise<GroupListEntry[]> {
    const groups = await listGroups(companyId);
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
    return groups
        .map((g) => {
            const last = latestBy.get(g.id);
            return {
                ...g,
                unreadCount: unreadBy.get(g.id) ?? 0,
                lastMessageText: last?.text ?? null,
                lastMessageAt: last ? last.createdAt.toISOString() : null,
            };
        })
        .sort((a, b) => (b.lastMessageAt ?? b.createdAt).localeCompare(a.lastMessageAt ?? a.createdAt));
}
