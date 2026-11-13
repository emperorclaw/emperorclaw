import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

/**
 * The Messages badge (/api/chat/unread-count) counts exactly the conversations
 * the Messages page lists (lib/messages-listing.ts), and "Mark all as read"
 * (/api/chat/read-all) clears exactly those. An agent's Work log (its shared
 * thread in private mode) is not listed: it keeps its own unread count, shown
 * in the agent's panel.
 */
const maybe = dbAvailable ? test : test.skip;

const LONG_AGO = new Date("2000-01-01T00:00:00Z");

async function setMode(companyId: string, mode: "shared" | "private") {
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ directChatMode: mode }).where(eq(companies.id, companyId));
}

async function agentSays(companyId: string, threadId: string, agentId: string, times: number) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    await db.insert(threadMessages).values(Array.from({ length: times }, (_, i) => ({
        companyId, threadId, senderType: "agent", senderId: agentId, text: `update ${i + 1}`,
    })));
}

/** Read cursors far in the past, so every agent message below counts as unread. */
async function rewindReadCursors(threadIds: string[]) {
    const db = await getDb();
    const { threadParticipants } = await getSchema();
    const { and, eq, inArray } = await import("drizzle-orm");
    await db.update(threadParticipants).set({ lastReadAt: LONG_AGO })
        .where(and(inArray(threadParticipants.threadId, threadIds), eq(threadParticipants.participantType, "human")));
}

async function readCursor(threadId: string, userId: string) {
    const db = await getDb();
    const { threadParticipants } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [row] = await db.select({ lastReadAt: threadParticipants.lastReadAt }).from(threadParticipants).where(and(
        eq(threadParticipants.threadId, threadId),
        eq(threadParticipants.participantType, "human"),
        eq(threadParticipants.participantRef, userId),
    ));
    return row?.lastReadAt ?? null;
}

async function badge(user: { userId: string; sessionId: string }) {
    const { GET } = await import("@/app/api/chat/unread-count/route");
    actAs(user);
    const res = await call(GET, "/api/chat/unread-count");
    assert.equal(res.status, 200, res.text);
    return res.json.count as number;
}

async function readAll(user: { userId: string; sessionId: string }) {
    const { POST } = await import("@/app/api/chat/read-all/route");
    actAs(user);
    return call(POST, "/api/chat/read-all", { method: "POST" });
}

async function seedPrivateCompany() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedHuman(companyId, "owner");
    const b = await seedHuman(companyId, "member");
    await setMode(companyId, "private");
    const agent = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    const { ensureDirectThread, ensureTeamThread } = await import("@/lib/control-plane");
    const { createGroup } = await import("@/lib/groups");
    const privA = await ensureDirectThread(companyId, agent.id, a.userId);
    const privB = await ensureDirectThread(companyId, agent.id, b.userId);
    // System traffic with no person behind it: the agent's Work log.
    const workLog = await ensureDirectThread(companyId, agent.id, null);
    const team = await ensureTeamThread(companyId);
    const group = await createGroup(companyId, { type: "human", id: a.userId }, { title: "Launch crew", agentIds: [agent.id] });

    // A stray participant row for A on B's private thread (the page guards
    // against it too): never listed, never counted, never marked.
    const db = await getDb();
    const { threadParticipants } = await getSchema();
    await db.insert(threadParticipants).values({ threadId: privB.id, companyId, participantType: "human", participantRef: a.userId, role: "member" });

    await rewindReadCursors([privA.id, privB.id, workLog.id, team.id, group.id]);
    await agentSays(companyId, privA.id, agent.id, 2);
    await agentSays(companyId, privB.id, agent.id, 3);
    await agentSays(companyId, workLog.id, agent.id, 5);
    await agentSays(companyId, team.id, agent.id, 1);
    await agentSays(companyId, group.id, agent.id, 4);
    return { companyId, a, b, agent, privA, privB, workLog, team, group };
}

maybe("private mode: the badge counts the listed chats, not the agent's Work log", async () => {
    const { companyId, a, b, privA, privB, workLog, team, group } = await seedPrivateCompany();
    const { loadMessagesListing, unreadCountsForUser } = await import("@/lib/messages-listing");

    const listing = await loadMessagesListing({ companyId, userId: a.userId, role: "owner", scope: null });
    assert.deepEqual(new Set(listing.listedThreadIds), new Set([privA.id, team.id, group.id]), "own private chat, team and group; no Work log, no one else's chat");
    assert.equal(listing.direct.find((d) => d.thread.id === workLog.id)?.kind, "operations", "the Work log still reaches the page (deep links)");

    // The Work log has unread for A, but it is not part of the badge.
    const all = await unreadCountsForUser(companyId, a.userId, [privA.id, privB.id, workLog.id, team.id, group.id]);
    assert.equal(all.get(workLog.id), 5);
    const listedSum = listing.listedThreadIds.reduce((sum, id) => sum + (all.get(id) ?? 0), 0);
    assert.equal(listedSum, 2 + 1 + 4);
    assert.equal(await badge(a), listedSum, "badge = sum of the listed threads' unread");

    // B: own private chat and the team; not a member of the group, so it stays quiet.
    assert.equal(await badge(b), 3 + 1);
});

maybe("private mode: the agent's panel shows the Work log's own unread count", async () => {
    const { a, agent, workLog, privA } = await seedPrivateCompany();
    const { GET } = await import("@/app/api/agents/[id]/route");
    actAs(a);
    const res = await call(GET, `/api/agents/${agent.id}`, { params: { id: agent.id } });
    assert.equal(res.status, 200, res.text);
    const threads = res.json.threads as { id: string; unreadCount: number }[];
    assert.equal(threads.find((t) => t.id === workLog.id)?.unreadCount, 5);
    assert.equal(threads.find((t) => t.id === privA.id)?.unreadCount, 2);
});

maybe("mark all as read clears the listed chats only: not the Work log, other people or other companies", async () => {
    const { companyId, a, b, privB, workLog } = await seedPrivateCompany();

    // Another company with its own unread chat.
    const { companyId: otherCompanyId } = await seedCompanyWithToken();
    const c = await seedHuman(otherCompanyId, "owner");
    const otherAgent = await seedAgent(otherCompanyId, { name: "Other" });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const otherThread = await ensureDirectThread(otherCompanyId, otherAgent.id, c.userId);
    await rewindReadCursors([otherThread.id]);
    await agentSays(otherCompanyId, otherThread.id, otherAgent.id, 2);
    assert.equal(await badge(c), 2);

    const res = await readAll(a);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.threads, 3, "A's private chat, the team and the group");
    assert.equal(await badge(a), 0);

    const { unreadCountsForUser } = await import("@/lib/messages-listing");
    assert.equal((await unreadCountsForUser(companyId, a.userId, [workLog.id])).get(workLog.id), 5, "the Work log keeps its unread");
    assert.equal((await readCursor(privB.id, a.userId))?.getTime(), LONG_AGO.getTime(), "the stray row on B's private chat is untouched");
    assert.equal((await readCursor(privB.id, b.userId))?.getTime(), LONG_AGO.getTime(), "B's own cursor is untouched");
    assert.equal(await badge(b), 3 + 1, "B's badge is unchanged");
    assert.equal(await badge(c), 2, "another company's badge is unchanged");
});

maybe("extra chats: the badge counts every open chat with the agent, and mark all as read clears them all", async () => {
    const { companyId, a, agent, privA, team, group } = await seedPrivateCompany();
    const { createPrivateChat, updatePrivateChat } = await import("@/lib/private-chats");
    const extra = (await createPrivateChat({ companyId, userId: a.userId, agentId: agent.id, firstMessage: "side topic", clientKey: `unread-${Date.now()}-1` })).thread;
    const archived = (await createPrivateChat({ companyId, userId: a.userId, agentId: agent.id, firstMessage: "old topic", clientKey: `unread-${Date.now()}-2` })).thread;
    await rewindReadCursors([extra.id, archived.id]);
    await agentSays(companyId, extra.id, agent.id, 6);
    await agentSays(companyId, archived.id, agent.id, 7);
    await updatePrivateChat(companyId, a.userId, archived.id, { archived: true });

    const { loadMessagesListing } = await import("@/lib/messages-listing");
    const listing = await loadMessagesListing({ companyId, userId: a.userId, role: "owner", scope: null });
    assert.deepEqual(listing.listedThreadIds, [privA.id, team.id, group.id, extra.id], "the open extra chat is listed; the archived one is not");
    assert.equal(listing.direct.filter((d) => d.kind === "primary" && d.agent.id === agent.id).length, 1, "still one sidebar entry for the agent");
    assert.equal(await badge(a), 2 + 1 + 4 + 6);

    const res = await readAll(a);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.threads, 4, "the main chat, the extra chat, the team and the group");
    assert.equal(await badge(a), 0);
    assert.equal((await readCursor(archived.id, a.userId))?.getTime(), LONG_AGO.getTime(), "an archived chat is not listed, so not touched");
});

maybe("read-all needs a signed-in member", async () => {
    await resetDb();
    const { POST } = await import("@/app/api/chat/read-all/route");
    actAs(null);
    const res = await call(POST, "/api/chat/read-all", { method: "POST" });
    assert.equal(res.status, 401);
});

maybe("shared mode: the agent's shared thread is the listed chat and still counts", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedHuman(companyId, "owner");
    await setMode(companyId, "shared");
    const agent = await seedAgent(companyId, { name: "Scout" });
    const { ensureDirectThread, ensureTeamThread } = await import("@/lib/control-plane");
    await ensureTeamThread(companyId);
    const shared = await ensureDirectThread(companyId, agent.id, a.userId);
    assert.equal(shared.ownerUserId, null);
    await rewindReadCursors([shared.id]);
    await agentSays(companyId, shared.id, agent.id, 3);

    const { loadMessagesListing } = await import("@/lib/messages-listing");
    const listing = await loadMessagesListing({ companyId, userId: a.userId, role: "owner", scope: null });
    assert.equal(listing.direct.find((d) => d.thread.id === shared.id)?.kind, "primary");
    assert.equal(await badge(a), 3);

    assert.equal((await readAll(a)).status, 200);
    assert.equal(await badge(a), 0);
});

/**
 * What the Messages page shows as unread, computed the way the page does
 * (app/(app)/messages/page.tsx): listed direct chats and the team thread via
 * unreadCountsForUser, groups via listGroupsForUser's own count.
 */
async function pageUnreadSum(viewer: { companyId: string; userId: string; role: "owner" | "admin" | "member" | "viewer"; scope: import("@/lib/member-scope").MemberScope | null }) {
    const { loadMessagesListing, unreadCountsForUser } = await import("@/lib/messages-listing");
    const listing = await loadMessagesListing(viewer);
    const listedDirect = listing.direct.filter((d) => d.kind !== "operations").map((d) => d.thread.id);
    const unreadBy = await unreadCountsForUser(viewer.companyId, viewer.userId, [...listedDirect, ...(listing.teamThread ? [listing.teamThread.id] : [])]);
    const direct = listedDirect.reduce((sum, id) => sum + (unreadBy.get(id) ?? 0), 0);
    const team = listing.teamThread ? unreadBy.get(listing.teamThread.id) ?? 0 : 0;
    const groups = listing.groups.reduce((sum, g) => sum + g.unreadCount, 0);
    return { total: direct + team + groups, listing };
}

maybe("badge = the page's listed unread: groups (not as reader), team, no deleted agent, a restricted member, no agent limited to others", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    await setMode(companyId, "private");
    const a = await seedHuman(companyId, "owner");
    const m = await seedHuman(companyId, "member");
    const scout = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    const ghost = await seedAgent(companyId, { name: "Ghost", provider: "hermes" });
    const secret = await seedAgent(companyId, { name: "Secret", provider: "hermes" });
    const r = await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [scout.id] } });
    const { ensureDirectThread, ensureTeamThread } = await import("@/lib/control-plane");
    const { createGroup, READER_ROLE } = await import("@/lib/groups");
    const db = await getDb();
    const { threadParticipants, agents, agentAccess } = await getSchema();
    const { eq } = await import("drizzle-orm");

    const team = await ensureTeamThread(companyId);
    const dm = (agentId: string, userId: string) => ensureDirectThread(companyId, agentId, userId);
    const aScout = await dm(scout.id, a.userId);
    const aGhost = await dm(ghost.id, a.userId);
    const aSecret = await dm(secret.id, a.userId);
    const rScout = await dm(scout.id, r.userId);
    const rGhost = await dm(ghost.id, r.userId);
    const mSecret = await dm(secret.id, m.userId);
    // A group A and R belong to (Scout only, so R's scope allows it) and one M only reads.
    const crew = await createGroup(companyId, { type: "human", id: a.userId }, { title: "Crew", agentIds: [scout.id], humanUserIds: [r.userId] });
    const ops = await createGroup(companyId, { type: "human", id: a.userId }, { title: "Ops", agentIds: [ghost.id] });
    // R belongs to Side, but its agent (Secret) is outside R's scope.
    const side = await createGroup(companyId, { type: "human", id: a.userId }, { title: "Side", agentIds: [secret.id], humanUserIds: [r.userId] });
    await db.insert(threadParticipants).values({ threadId: ops.id, companyId, participantType: "human", participantRef: m.userId, role: READER_ROLE });

    const all = [team.id, aScout.id, aGhost.id, aSecret.id, rScout.id, rGhost.id, mSecret.id, crew.id, ops.id, side.id];
    await rewindReadCursors(all);
    await agentSays(companyId, team.id, scout.id, 1);
    await agentSays(companyId, aScout.id, scout.id, 2);
    await agentSays(companyId, aGhost.id, ghost.id, 3);
    await agentSays(companyId, aSecret.id, secret.id, 4);
    await agentSays(companyId, rScout.id, scout.id, 5);
    await agentSays(companyId, rGhost.id, ghost.id, 6);
    await agentSays(companyId, mSecret.id, secret.id, 7);
    await agentSays(companyId, crew.id, scout.id, 8);
    await agentSays(companyId, ops.id, ghost.id, 9);
    await agentSays(companyId, side.id, secret.id, 10);

    // Ghost is deleted; Secret now works only for M (0.20 agent access).
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, ghost.id));
    await db.update(agents).set({ access: "people", ownerUserId: m.userId }).where(eq(agents.id, secret.id));
    await db.insert(agentAccess).values({ agentId: secret.id, userId: m.userId, companyId });

    const { loadMemberScope } = await import("@/lib/member-scope");
    const cases = [
        // team 1 + Scout 2 + Crew 8 + Ops 9 + Side 10 (groups are membership, not agent access); no Ghost DM (deleted), no Secret DM (limited to M).
        { who: a, role: "owner" as const, expected: 1 + 2 + 8 + 9 + 10, excluded: [aGhost.id, aSecret.id] },
        // team 1 + Secret 7; Ops only as reader: listed, never counted.
        { who: m, role: "member" as const, expected: 1 + 7, excluded: [] as string[] },
        // Restricted to Scout: team 1 + Scout 5 + Crew 8; Ghost's chat and Side (Secret's group) are outside.
        // (Ops lists for R once its only agent is deleted, but R is not a member: 0 unread on both sides.)
        { who: r, role: "member" as const, expected: 1 + 5 + 8, excluded: [rGhost.id, side.id] },
    ];
    for (const c of cases) {
        const viewer = { companyId, userId: c.who.userId, role: c.role, scope: await loadMemberScope(c.who.userId, companyId) };
        const page = await pageUnreadSum(viewer);
        for (const id of c.excluded) assert.equal(page.listing.listedThreadIds.includes(id), false, `${id} must not be listed`);
        assert.equal(page.total, c.expected, `page unread for ${c.role} ${c.who.userId}`);
        assert.equal(await badge(c.who), page.total, "badge = sum of the page-listed unread");
    }
    // M's reader row on Ops: the group is listed with 0 unread although Ghost wrote 9 messages.
    const mPage = await pageUnreadSum({ companyId, userId: m.userId, role: "member", scope: null });
    assert.equal(mPage.listing.groups.find((g) => g.id === ops.id)?.unreadCount ?? 0, 0);
});
