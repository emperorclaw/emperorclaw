import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

maybe("group chats deliver only to member agents, carry their details, and stay members-only", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const qa = await seedAgent(companyId, { name: "QA", provider: "hermes" });
    const outsider = await seedAgent(companyId, { name: "Outsider", provider: "hermes" });
    const { createGroup, listGroupsForUser, getGroup, addGroupMembers, removeGroupMember } = await import("@/lib/groups");
    const { appendThreadMessage, markThreadRead } = await import("@/lib/control-plane");
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    const db = await getDb();
    const { threadParticipants } = await getSchema();
    const { eq } = await import("drizzle-orm");

    // A human creates the group and is its owner; agents join by id or name.
    const group = await createGroup(companyId, { type: "human", id: userId }, {
        title: "  Development   team ",
        description: "Build and test features",
        agentIds: [dev.id, "QA"],
    });
    assert.equal(group.title, "Development team");
    assert.deepEqual(group.members.filter((m) => m.kind === "agent").map((m) => m.name).sort(), ["Dev", "QA"]);
    assert.equal(group.members.find((m) => m.kind === "human")?.role, "owner");

    // Re-adding a member is a no-op thanks to the unique member index.
    await addGroupMembers(companyId, group.id, { agentIds: [dev.id] });
    const devRows = await db.select().from(threadParticipants).where(eq(threadParticipants.participantId, dev.id));
    assert.equal(devRows.filter((r) => r.threadId === group.id).length, 1);

    // A human message in the group reaches members only, with thread details.
    const posted = await appendThreadMessage({ companyId, threadId: group.id, senderType: "human", senderId: userId, text: "@QA please test the login flow" });
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const headers = { authorization: `Bearer ${rawToken}` };
    const forQa = await (await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${qa.id}`, { headers }))).json();
    const message = forQa.messages.find((m: { id: string }) => m.id === posted.id);
    assert.ok(message, "member agent receives the group message");
    assert.equal(message.threadType, "group");
    assert.equal(message.threadTitle, "Development team");
    assert.equal(forQa.threads[group.id].description, "Build and test features");
    assert.ok(forQa.threads[group.id].members.some((m: { name: string }) => m.name === "Dev"));

    const forOutsider = await (await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${outsider.id}`, { headers: { ...headers }, }))).json().catch(() => ({ messages: [] }));
    assert.ok(!(forOutsider.messages ?? []).some((m: { id: string }) => m.id === posted.id), "non-member agent never receives it");

    // Only members post from MCP; a group message is never targeted at one agent.
    await assert.rejects(
        sendThreadMessageFromMcp({ companyId, threadId: group.id, agentId: outsider.id, text: "hi", threadType: "group" }),
        /not a member/,
    );
    const reply = await sendThreadMessageFromMcp({ companyId, threadId: group.id, agentId: qa.id, text: "On it", threadType: "group" });
    assert.equal(reply.threadId, group.id);

    // Opening a group records a read cursor without making you a member.
    const reader = (await seedCompanyMember(companyId)).userId;
    await markThreadRead(companyId, group.id, reader);
    assert.ok(!(await getGroup(companyId, group.id)).members.some((m) => m.id === reader), "a reader is not a member");
    const sidebar = await listGroupsForUser(companyId, userId);
    assert.equal(sidebar.length, 1);
    assert.equal(sidebar[0].lastMessageText, "On it");

    // Removing an agent stops delivery to it.
    await removeGroupMember(companyId, group.id, { kind: "agent", id: qa.id });
    const later = await appendThreadMessage({ companyId, threadId: group.id, senderType: "human", senderId: userId, text: "@QA still there?" });
    const afterRemoval = await (await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${qa.id}`, { headers }))).json().catch(() => ({ messages: [] }));
    assert.ok(!(afterRemoval.messages ?? []).some((m: { id: string }) => m.id === later.id), "removed agent no longer receives the group");
});

maybe("agents create groups over MCP REST and may only manage groups they belong to", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const lead = await seedAgent(companyId, { name: "Lead", provider: "hermes" });
    const dev = await seedAgent(companyId, { name: "Dev2", provider: "hermes" });
    const other = await seedAgent(companyId, { name: "Other", provider: "hermes" });
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const groups = await import("@/app/api/mcp/groups/route");
    const members = await import("@/app/api/mcp/groups/[id]/members/route");
    const headers = { authorization: `Bearer ${rawToken}` };

    // Bound to Lead: Lead creates a group and joins it automatically.
    await db.update(companyTokens).set({ agentId: lead.id }).where(eq(companyTokens.companyId, companyId));
    const created = await groups.POST(makeRequest("http://localhost/api/mcp/groups", { method: "POST", headers, body: { title: "Launch room", agentIds: [dev.id] } }));
    assert.equal(created.status, 201);
    const { group } = await created.json();
    assert.deepEqual(group.members.map((m: { name: string }) => m.name).sort(), ["Dev2", "Lead"]);

    // Lead lists only its groups.
    const mine = await (await groups.GET(makeRequest("http://localhost/api/mcp/groups?mine=1", { headers }))).json();
    assert.equal(mine.groups.length, 1);

    // Bound to Other: it may not change Lead's group.
    await db.update(companyTokens).set({ agentId: other.id }).where(eq(companyTokens.companyId, companyId));
    const denied = await members.POST(makeRequest(`http://localhost/api/mcp/groups/${group.id}/members`, { method: "POST", headers, body: { agentIds: [other.id] } }), { params: Promise.resolve({ id: group.id }) });
    assert.equal(denied.status, 403);

    // Validation errors are clean 4xx, not 500s.
    const empty = await groups.POST(makeRequest("http://localhost/api/mcp/groups", { method: "POST", headers, body: { title: "   " } }));
    assert.equal(empty.status, 400);
    const unknown = await groups.POST(makeRequest("http://localhost/api/mcp/groups", { method: "POST", headers, body: { title: "X", agentIds: ["Nobody"] } }));
    assert.equal(unknown.status, 404);
});

maybe("the team channel keeps working and now reports its thread type to runtimes", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Solo", provider: "hermes" });
    const { appendThreadMessage, ensureTeamThread } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(companyId);
    const posted = await appendThreadMessage({ companyId, threadId: team.id, senderType: "human", senderId: userId, text: "@Solo hello" });
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const payload = await (await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${agent.id}`, { headers: { authorization: `Bearer ${rawToken}` } }))).json();
    const message = payload.messages.find((m: { id: string }) => m.id === posted.id);
    assert.ok(message);
    assert.equal(message.threadType, "team", "loop and cold-start guards can finally key off the thread type");
    assert.deepEqual(payload.threads, {}, "no group details for the team channel");
});

async function seedCompanyMember(companyId: string) {
    const db = await getDb();
    const { users, companyMembers } = await getSchema();
    const { randomUUID } = await import("node:crypto");
    const [user] = await db.insert(users).values({ email: `reader-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values({ companyId, userId: user.id, role: "member" });
    return { userId: user.id };
}

maybe("the raw thread-messages route enforces group membership too", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const member = await seedAgent(companyId, { name: "Member", provider: "hermes" });
    const stranger = await seedAgent(companyId, { name: "Stranger", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "human", id: userId }, { title: "Core", agentIds: [member.id] });
    const route = await import("@/app/api/mcp/threads/[id]/messages/route");
    const headers = { authorization: `Bearer ${rawToken}` };
    const post = (senderId: string) => route.POST(
        makeRequest(`http://localhost/api/mcp/threads/${group.id}/messages`, { method: "POST", headers, body: { text: "hello", senderType: "agent", senderId } }),
        { params: Promise.resolve({ id: group.id }) },
    );
    assert.equal((await post(stranger.id)).status, 403);
    assert.equal((await post(member.id)).status, 201);
});

maybe("W9: an operator token never lists pair threads, even with mine=1", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { ensureAgentPairThread } = await import("@/lib/groups");
    await ensureAgentPairThread(companyId, a.id, b.id);

    const groups = await import("@/app/api/mcp/groups/route");
    const headers = { authorization: `Bearer ${rawToken}` };
    // The operator token is unbound (no agentId), so `mine=1` must not reveal
    // any pair thread.
    const res = await (await groups.GET(makeRequest("http://localhost/api/mcp/groups?mine=1", { headers }))).json();
    assert.ok(Array.isArray(res.groups), "groups is a list");
    assert.ok(!res.groups.some((g: { isAgentPair: boolean }) => g.isAgentPair), "operator token sees no pair threads");
});
