import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

/** Mint an MCP token bound to one agent (a real runtime identity). */
async function tokenForAgent(companyId: string, agentId: string): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId,
        agentId,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        name: `agent-${agentId}`,
        scope: "mcp_full",
    });
    return raw;
}

/** Poll as a bound agent; returns the messages the server would hand that runtime. */
async function syncAs(rawToken: string, agentId: string, mode: "all" | "human_only" = "all") {
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=${mode}&agentId=${agentId}`, {
        headers: { authorization: `Bearer ${rawToken}` },
    }));
    assert.equal(res.status, 200);
    const json = await res.json();
    return json.messages as Array<Record<string, unknown>>;
}

/** Authenticated agent send through the real MCP route. */
async function sendAs(rawToken: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/mcp/messages/send/route");
    const res = await route.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}` },
        body,
    }));
    assert.equal(res.status, 200, `send failed: ${await res.clone().text()}`);
    return res.json() as Promise<{ ok: boolean; message_id: string; thread_id: string }>;
}

async function seedHuman(companyId: string): Promise<string> {
    const db = await getDb();
    const { users, companyMembers } = await getSchema();
    const [user] = await db.insert(users).values({ email: `member-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values({ companyId, userId: user.id, role: "member" });
    return user.id;
}

async function seedTeam() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const c = await seedAgent(companyId, { name: "Gamma", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "agent", id: a.id }, { title: "Work team", agentIds: [a.id, b.id, c.id] });
    const [tokA, tokB, tokC] = await Promise.all([
        tokenForAgent(companyId, a.id),
        tokenForAgent(companyId, b.id),
        tokenForAgent(companyId, c.id),
    ]);
    return { companyId, a, b, c, group, tokA, tokB, tokC };
}

maybe("agent @mention in a team wakes the mentioned agent and leaves the third unaddressed", async () => {
    const { a, b, c, group, tokA, tokB, tokC } = await seedTeam();
    const sent = await sendAs(tokA, { text: "@Beta please review this", thread_id: group.id, agentId: a.id });
    assert.equal(sent.thread_id, group.id);

    const forB = (await syncAs(tokB, b.id)).find((m) => m.id === sent.message_id);
    assert.ok(forB, "Beta receives the mention");
    assert.equal(forB!.addressedToYou, true);
    assert.equal(forB!.routeReason, "mention");
    assert.equal(forB!.threadId, group.id);

    const forC = (await syncAs(tokC, c.id)).find((m) => m.id === sent.message_id);
    assert.ok(forC, "Gamma receives the group message (it is a member)");
    assert.equal(forC!.addressedToYou, false);
    assert.equal(forC!.routeReason, "not_addressed");
    void c;
});

maybe("a human @mention in a team wakes the mentioned agent", async () => {
    const { companyId, b, group, tokB } = await seedTeam();
    const { appendThreadMessage } = await import("@/lib/control-plane");
    const userId = await seedHuman(companyId);
    const message = await appendThreadMessage({ companyId, threadId: group.id, senderType: "human", senderId: userId, text: "@Beta status?" });

    const forB = (await syncAs(tokB, b.id)).find((m) => m.id === message.id);
    assert.ok(forB, "Beta receives the human mention");
    assert.equal(forB!.addressedToYou, true);
    assert.equal(forB!.routeReason, "mention");
});

maybe("multiword names with Unicode/invisible spaces still wake the agent", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "José Zúñiga", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "agent", id: a.id }, { title: "Team", agentIds: [a.id, b.id] });
    const tokA = await tokenForAgent(companyId, a.id);
    const tokB = await tokenForAgent(companyId, b.id);

    // NBSP + zero-width space inside the mentioned name.
    const sent = await sendAs(tokA, { text: "@José\u00a0Zú\u200bñiga please confirm", thread_id: group.id, agentId: a.id });
    const forB = (await syncAs(tokB, b.id)).find((m) => m.id === sent.message_id);
    assert.ok(forB, "the multiword mention reaches the right agent");
    assert.equal(forB!.addressedToYou, true);
    assert.equal(forB!.routeReason, "mention");
});

maybe("a reply in the mention thread stays in the same team", async () => {
    const { a, b, group, tokA, tokB } = await seedTeam();
    await sendAs(tokA, { text: "@Beta ping", thread_id: group.id, agentId: a.id });
    const reply = await sendAs(tokB, { text: "on it", thread_id: group.id, agentId: b.id });
    assert.equal(reply.thread_id, group.id, "the reply stays in the team");

    const seen = (await syncAs(tokA, a.id)).find((m) => m.id === reply.message_id);
    assert.ok(seen, "Alpha sees Beta's reply in the team");
    assert.equal(seen!.threadId, group.id);
    void b;
});

maybe("a second-turn mention still reaches the agent after it already replied", async () => {
    const { a, b, group, tokA, tokB } = await seedTeam();
    const first = await sendAs(tokA, { text: "@Beta first", thread_id: group.id, agentId: a.id });
    await sendAs(tokB, { text: "replied", thread_id: group.id, agentId: b.id });
    const second = await sendAs(tokA, { text: "@Beta second", thread_id: group.id, agentId: a.id });

    const bMsgs = await syncAs(tokB, b.id);
    assert.equal(bMsgs.find((m) => m.id === first.message_id), undefined, "the already-answered first mention is suppressed");
    const secondSeen = bMsgs.find((m) => m.id === second.message_id);
    assert.ok(secondSeen, "the new mention after the reply is delivered");
    assert.equal(secondSeen!.addressedToYou, true);
    assert.equal(secondSeen!.routeReason, "mention");
});

maybe("human_only polling hides agent mentions; all polling delivers them", async () => {
    const { companyId, a, b, group, tokA, tokB } = await seedTeam();
    const sent = await sendAs(tokA, { text: "@Beta check", thread_id: group.id, agentId: a.id });

    const all = await syncAs(tokB, b.id, "all");
    assert.ok(all.find((m) => m.id === sent.message_id), "mode=all delivers the agent mention");

    // Include a human message so the human_only poll returns immediately (no
    // 25s long-poll) while still proving the agent mention is filtered out.
    const { appendThreadMessage } = await import("@/lib/control-plane");
    const userId = await seedHuman(companyId);
    const human = await appendThreadMessage({ companyId, threadId: group.id, senderType: "human", senderId: userId, text: "human note" });

    const humanOnly = await syncAs(tokB, b.id, "human_only");
    assert.ok(humanOnly.find((m) => m.id === human.id), "human_only delivers the human message");
    assert.equal(humanOnly.find((m) => m.id === sent.message_id), undefined, "mode=human_only filters agent-authored messages");
});

maybe("team-first implicit targeted group send mentions only the recipient", async () => {
    const { companyId, a, b, c, group, tokB, tokC } = await seedTeam();
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    const sent = await sendThreadMessageFromMcp({ companyId, agentId: a.id, targetAgentId: b.id, text: "sync up" });
    assert.equal(sent.threadId, group.id, "the shared team chat is used");

    const forB = (await syncAs(tokB, b.id)).find((m) => m.id === sent.messageId);
    assert.ok(forB, "the recipient receives the team message");
    assert.equal(forB!.addressedToYou, true);
    assert.equal(forB!.routeReason, "mention");
    assert.match(String(forB!.text), /@Beta/);

    const forC = (await syncAs(tokC, c.id)).find((m) => m.id === sent.messageId);
    assert.ok(forC, "the third member receives it but is not addressed");
    assert.equal(forC!.addressedToYou, false);
    assert.equal(forC!.routeReason, "not_addressed");
});
