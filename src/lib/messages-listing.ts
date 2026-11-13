import { and, asc, count, desc, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { agents, messageThreads, threadMessages, threadParticipants } from "@/db/schema";
import { getDirectChatMode } from "@/lib/control-plane";
import { listGroupsForUser, READER_ROLE, type GroupListEntry } from "@/lib/groups";
import { isMissingSchemaError } from "@/lib/schema-compat";
import { userMayUseThread, type DirectChatMode } from "@/lib/direct-chat-mode";
import { memberAgentCondition, type MemberScope } from "@/lib/member-scope";
import { agentsNotUsableBy, usableAgentCondition } from "@/lib/agent-access-server";
import { memberMaySeeGroup } from "@/lib/group-route";
import type { Role } from "@/lib/roles";

/**
 * What the Messages page lists for one person, decided in one place so the
 * page and the nav badge (/api/chat/unread-count) can never disagree about
 * which conversations count.
 *
 * Listed: one direct thread per visible agent (the "primary": your main chat
 * in private mode, with your extra chats with that agent alongside it in
 * `extraChats`; the shared one in shared mode, the most recent winning), your
 * earlier private threads in shared mode, the team thread and the groups you
 * can see. NOT listed: an agent's shared thread in private mode (its Work log,
 * reached from the agent's panel), someone else's private thread, archived
 * threads, deleted agents, agents outside your scope or limited to others.
 */
export type MessagesViewer = { companyId: string; userId: string; role: Role | null; scope: MemberScope | null };

type AgentRow = typeof agents.$inferSelect;
type ThreadRow = typeof messageThreads.$inferSelect;

export type ListedDirectThread = {
    agent: AgentRow;
    thread: ThreadRow;
    /** "primary" = the agent's row in Direct Messages; "operations" = its Work log (not listed); "private" = your earlier private thread, or (in `extraChats`) an extra chat. */
    kind: "primary" | "operations" | "private";
    latest: { text: string; createdAt: Date } | null;
};

export type MessagesListing = {
    directChatMode: DirectChatMode;
    /** Agents this person may see and chat with, for the Direct Messages list. */
    agents: AgentRow[];
    /** Primary and secondary direct threads (Work logs included, flagged "operations"). */
    direct: ListedDirectThread[];
    teamThread: ThreadRow | null;
    groups: GroupListEntry[];
    /** Every thread the Messages list shows: what the badge counts and "Mark all as read" clears. */
    listedThreadIds: string[];
    /**
     * Private mode: the person's open EXTRA chats per agent (not the main
     * chat, which is the agent's "primary" entry in `direct`). They share the
     * agent's one sidebar row; their ids are in listedThreadIds, so the badge
     * and "Mark all as read" cover them. Absent when the person has none, so
     * the listing is exactly what it was before multiple chats.
     */
    extraChats?: ListedDirectThread[];
};

/** The company's team thread, read-only (the page creates it with ensureTeamThread first). */
async function findTeamThread(companyId: string): Promise<ThreadRow | null> {
    const [row] = await db.select().from(messageThreads).where(and(
        eq(messageThreads.companyId, companyId),
        eq(messageThreads.type, "team"),
        isNull(messageThreads.archivedAt),
    )).orderBy(messageThreads.createdAt).limit(1);
    return row ?? null;
}

export async function loadMessagesListing(viewer: MessagesViewer): Promise<MessagesListing> {
    const { companyId, userId, scope } = viewer;
    const directChatMode = await getDirectChatMode(companyId);
    // Nor the DMs of an agent limited to other people (0.20), admins included.
    const { hidden } = viewer.role
        ? await agentsNotUsableBy({ companyId, userId, role: viewer.role, scope })
        : { hidden: new Set<string>() };
    const visibleAgents = await db.select().from(agents).where(
        and(eq(agents.companyId, companyId), isNull(agents.deletedAt), memberAgentCondition(scope, agents.id), usableAgentCondition(hidden, agents.id))
    );
    const agentById = new Map(visibleAgents.map((agent) => [agent.id, agent]));

    // The direct threads this person is a human participant in.
    const userThreads = await db.select({ thread: messageThreads }).from(messageThreads)
        .innerJoin(threadParticipants, and(
            eq(threadParticipants.threadId, messageThreads.id),
            eq(threadParticipants.companyId, messageThreads.companyId),
            eq(threadParticipants.participantType, "human"),
            eq(threadParticipants.participantRef, userId),
        ))
        .where(and(eq(messageThreads.companyId, companyId), eq(messageThreads.type, "direct"), isNull(messageThreads.archivedAt)))
        .then((rows) => [...new Map(rows.map((r) => [r.thread.id, r.thread])).values()]);
    const userThreadIds = userThreads.map((thread) => thread.id);

    const agentParticipants = userThreadIds.length > 0
        ? await db.select({ threadId: threadParticipants.threadId, agentId: threadParticipants.participantId }).from(threadParticipants)
            .where(and(eq(threadParticipants.companyId, companyId), inArray(threadParticipants.threadId, userThreadIds), eq(threadParticipants.participantType, "agent")))
            .orderBy(asc(threadParticipants.createdAt))
        : [];
    const agentByThread = new Map<string, string>();
    for (const row of agentParticipants) {
        if (row.agentId && !agentByThread.has(row.threadId)) agentByThread.set(row.threadId, row.agentId);
    }

    const latestRows = userThreadIds.length > 0
        ? await db.selectDistinctOn([threadMessages.threadId], { threadId: threadMessages.threadId, text: threadMessages.text, createdAt: threadMessages.createdAt })
            .from(threadMessages)
            .where(and(eq(threadMessages.companyId, companyId), inArray(threadMessages.threadId, userThreadIds)))
            .orderBy(threadMessages.threadId, desc(threadMessages.createdAt))
        : [];
    const latestByThread = new Map(latestRows.map((row) => [row.threadId, { text: row.text, createdAt: row.createdAt }]));

    const primaryByAgent = new Map<string, ListedDirectThread>();
    const secondary: ListedDirectThread[] = [];
    // Private mode: every chat the person owns with an agent; the main chat
    // becomes the agent's primary entry and the rest are its extra chats.
    const ownedByAgent = new Map<string, ListedDirectThread[]>();
    for (const thread of userThreads) {
        const agentId = agentByThread.get(thread.id);
        const agent = agentId ? agentById.get(agentId) : undefined;
        if (!agent) continue;
        // Someone else's private thread is never listed, even with a stray row.
        if (!userMayUseThread(thread, userId)) continue;
        const latest = latestByThread.get(thread.id) ?? null;
        const primary = directChatMode === "private" ? thread.ownerUserId === userId : !thread.isPrivate && !thread.ownerUserId;
        if (!primary) {
            secondary.push({ agent, thread, kind: thread.ownerUserId ? "private" : "operations", latest });
            continue;
        }
        if (directChatMode === "private") {
            ownedByAgent.set(agent.id, [...(ownedByAgent.get(agent.id) ?? []), { agent, thread, kind: "primary", latest }]);
            continue;
        }
        const current = primaryByAgent.get(agent.id);
        if (!current || latestTime(latest) >= latestTime(current.latest)) primaryByAgent.set(agent.id, { agent, thread, kind: "primary", latest });
    }
    const extraChats: ListedDirectThread[] = [];
    for (const [agentId, owned] of ownedByAgent) {
        // The main chat; failing that (no main yet), the most recent, as before.
        const main = owned.find((entry) => entry.thread.isMain)
            ?? owned.reduce((best, entry) => (latestTime(entry.latest) >= latestTime(best.latest) ? entry : best));
        primaryByAgent.set(agentId, main);
        for (const entry of owned) if (entry !== main) extraChats.push({ ...entry, kind: "private" });
    }

    const teamThread = await findTeamThread(companyId);

    // Group chats. A server whose database hasn't run the group migration yet
    // still renders Messages; it just shows no groups.
    let groups: GroupListEntry[] = [];
    try {
        groups = (await listGroupsForUser(companyId, userId)).filter((g) => memberMaySeeGroup(scope, g));
    } catch (error) {
        if (!isMissingSchemaError(error)) throw error;
    }

    const direct = [...primaryByAgent.values(), ...secondary];
    const listedThreadIds = [
        ...direct.filter((d) => d.kind !== "operations").map((d) => d.thread.id),
        ...(teamThread ? [teamThread.id] : []),
        ...groups.map((g) => g.id),
        ...extraChats.map((d) => d.thread.id),
    ];
    const listing: MessagesListing = { directChatMode, agents: visibleAgents, direct, teamThread, groups, listedThreadIds };
    if (extraChats.length > 0) listing.extraChats = extraChats;
    return listing;
}

function latestTime(latest: ListedDirectThread["latest"]): number {
    return latest ? latest.createdAt.getTime() : 0;
}

/** Just the ids the Messages list shows (see loadMessagesListing). */
export async function listedThreadIdsForUser(viewer: MessagesViewer): Promise<string[]> {
    return (await loadMessagesListing(viewer)).listedThreadIds;
}

/**
 * Unread agent messages per thread for one person, in one query: agent-sent
 * messages after their read cursor (all of them when they never read it).
 * Only threads they are a member of count; a group "reader" row (opened, never
 * joined) stays quiet, as in listGroupsForUser.
 */
export async function unreadCountsForUser(companyId: string, userId: string, threadIds: readonly string[]): Promise<Map<string, number>> {
    if (threadIds.length === 0) return new Map();
    const rows = await db.select({ threadId: threadMessages.threadId, value: count() }).from(threadMessages)
        .innerJoin(threadParticipants, and(
            eq(threadParticipants.threadId, threadMessages.threadId),
            eq(threadParticipants.companyId, threadMessages.companyId),
            eq(threadParticipants.participantType, "human"),
            eq(threadParticipants.participantRef, userId),
            ne(threadParticipants.role, READER_ROLE),
        ))
        .where(and(
            eq(threadMessages.companyId, companyId),
            inArray(threadMessages.threadId, [...threadIds]),
            eq(threadMessages.senderType, "agent"),
            or(isNull(threadParticipants.lastReadAt), gt(threadMessages.createdAt, threadParticipants.lastReadAt)),
        ))
        .groupBy(threadMessages.threadId);
    return new Map(rows.map((row) => [row.threadId, Number(row.value) || 0]));
}

/** Move this person's read cursor to now on the given threads (their own participant rows only). Returns the rows updated. */
export async function markThreadsReadForUser(companyId: string, userId: string, threadIds: readonly string[]): Promise<number> {
    if (threadIds.length === 0) return 0;
    const updated = await db.update(threadParticipants)
        // DB now(), comparable to thread_messages.created_at (see markThreadRead).
        .set({ lastReadAt: sql`now()` })
        .where(and(
            eq(threadParticipants.companyId, companyId),
            inArray(threadParticipants.threadId, [...threadIds]),
            eq(threadParticipants.participantType, "human"),
            eq(threadParticipants.participantRef, userId),
        ))
        .returning({ id: threadParticipants.id });
    return updated.length;
}
