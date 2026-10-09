import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

async function seedScopedToken(companyId: string, scope: "read_only" | "requests") {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_${scope}_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({ companyId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: `${scope} token`, scope });
    return raw;
}

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

async function getLive(token: string, query = "", headers: Record<string, string> = {}) {
    const { clearLiveFeedCache } = await import("@/lib/live-feed");
    clearLiveFeedCache();
    const route = await import("@/app/api/mcp/live/route");
    return route.GET(makeRequest(`http://localhost/api/mcp/live${query}`, { headers: auth(token, headers) }));
}

maybe("a read_only token reads the live feed: agents, activity, tasks, and public messages only", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const readOnly = await seedScopedToken(companyId, "read_only");
    const db = await getDb();
    const { messageThreads, threadParticipants, threadMessages, projects, tasks, agents } = await getSchema();
    const now = Date.now();

    const ada = await seedAgent(companyId, { name: "Ada Researcher", lastSeenAt: new Date(now - 12_000) });
    const bob = await seedAgent(companyId, { name: "Bob Builder", lastSeenAt: new Date(now - 30_000) });
    const old = await seedAgent(companyId, { name: "Zed Retired", deletedAt: new Date() });
    await seedAgent(companyId, { name: "Cy Sleeper" }); // never seen

    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const [group] = await db.insert(messageThreads).values({ companyId, type: "group", title: "Dev" }).returning();
    const [direct] = await db.insert(messageThreads).values({ companyId, type: "direct", title: "Private" }).returning();
    await db.insert(threadParticipants).values([
        { companyId, threadId: team.id, participantType: "agent", participantId: ada.id, typingUntil: new Date(now + 60_000), currentActivity: "**Reading** the Q3 report" },
        { companyId, threadId: direct.id, participantType: "agent", participantId: bob.id, typingUntil: new Date(now + 60_000), currentActivity: "thinking: the user's salary is 90k" },
    ]);
    const [project] = await db.insert(projects).values({ companyId, goal: "Q3", status: "active" }).returning();
    await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "report", state: "in_progress", assignedAgentId: ada.id, inputJson: { title: "Draft Q3 summary" } });

    await db.insert(threadMessages).values([
        { companyId, threadId: team.id, senderType: "agent", senderId: ada.id, text: "## Done\n**Shipped** the [report](emperor://task/x)", createdAt: new Date(now - 40_000) },
        { companyId, threadId: group.id, senderType: "human", senderId: randomUUID(), text: "Great work team", metadataJson: { senderName: "Jose Zun" }, createdAt: new Date(now - 20_000) },
        { companyId, threadId: direct.id, senderType: "human", senderId: randomUUID(), text: "My secret direct message", metadataJson: { senderName: "Jose Zun" }, createdAt: new Date(now - 10_000) },
        { companyId, threadId: team.id, senderType: "agent", senderId: old.id, text: "From a deleted agent", createdAt: new Date(now - 50_000) },
    ]);

    const res = await getLive(readOnly);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(res.headers.get("etag"));
    const raw = await res.text();
    assert.ok(raw.length < 6000, `payload is small (${raw.length} bytes)`);
    const feed = JSON.parse(raw);

    assert.equal(feed.v, 1);
    assert.equal(feed.company.name, "Test Co");
    assert.equal(feed.summary.agents, 3, "deleted agents are excluded");
    assert.equal(feed.summary.tasksInProgress, 1);
    assert.deepEqual(feed.agents.map((a: { short: string }) => a.short).sort(), ["Ada", "Bob", "Cy"]);

    const adaLive = feed.agents.find((a: { id: string }) => a.id === ada.id);
    assert.equal(adaLive.state, "typing");
    assert.equal(adaLive.activity, "Reading the Q3 report");
    assert.deepEqual(adaLive.task, { id: adaLive.task.id, title: "Draft Q3 summary" });
    assert.ok(adaLive.lastSeenSec >= 12 && adaLive.lastSeenSec < 60);
    assert.ok(adaLive.hue >= 0 && adaLive.hue < 360);

    const bobLive = feed.agents.find((a: { id: string }) => a.id === bob.id);
    assert.equal(bobLive.state, "typing");
    assert.equal(bobLive.activity, "Working in a private chat", "direct-thread activity is never shown verbatim");
    assert.equal(bobLive.task, null);

    const cy = feed.agents.find((a: { short: string }) => a.short === "Cy");
    assert.equal(cy.state, "offline");
    assert.equal(cy.lastSeenSec, null);
    assert.equal(cy.activity, null);

    // Only team and group messages, newest first, plain text.
    assert.deepEqual(feed.messages.map((m: { text: string }) => m.text), ["Great work team", "Done Shipped the report", "From a deleted agent"]);
    assert.equal(feed.messages[0].from, "Jose");
    assert.equal(feed.messages[0].agentId, null);
    assert.equal(feed.messages[1].from, "Ada");
    assert.equal(feed.messages[1].agentId, ada.id);
    assert.equal(feed.messages[2].from, "Agent");
    assert.equal(feed.messages[2].agentId, null);
    assert.ok(!raw.includes("secret") && !raw.includes("salary"), "nothing from a direct thread leaks");
    assert.deepEqual(feed.dm, [], "no private chats without the opt-in");

    // ?messages= clamps.
    const one = await (await getLive(readOnly, "?messages=1")).json();
    assert.equal(one.messages.length, 1);
    const none = await (await getLive(readOnly, "?messages=0")).json();
    assert.deepEqual(none.messages, []);

    // Full-scope tokens may read it too.
    assert.equal((await getLive(rawToken)).status, 200);

    // Reading never wrote anything besides lastUsedAt.
    const { eq } = await import("drizzle-orm");
    const [stillAda] = await db.select().from(agents).where(eq(agents.id, ada.id));
    assert.equal(stillAda.name, "Ada Researcher");
});

maybe("an unchanged feed answers 304 to If-None-Match", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const readOnly = await seedScopedToken(companyId, "read_only");
    await seedAgent(companyId, { name: "Ada", lastSeenAt: new Date() });

    const first = await getLive(readOnly);
    const etag = first.headers.get("etag")!;
    assert.ok(etag);

    const second = await getLive(readOnly, "", { "If-None-Match": etag });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get("etag"), etag);
    assert.equal(await second.text(), "");

    // A change produces a new tag and a full body.
    const db = await getDb();
    const { messageThreads, threadMessages } = await getSchema();
    const [team] = await db.insert(messageThreads).values({ companyId, type: "team" }).returning();
    await db.insert(threadMessages).values({ companyId, threadId: team.id, senderType: "human", text: "New message" });
    const third = await getLive(readOnly, "", { "If-None-Match": etag });
    assert.equal(third.status, 200);
    assert.notEqual(third.headers.get("etag"), etag);
});

maybe("a read_only token is refused everywhere else, and a requests token is refused by /live", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const readOnly = await seedScopedToken(companyId, "read_only");
    const requests = await seedScopedToken(companyId, "requests");
    const agent = await seedAgent(companyId, { name: "Viktor" });

    // REST endpoints, reads and writes.
    const tasksRoute = await import("@/app/api/mcp/tasks/route");
    const tasksRes = await tasksRoute.GET(makeRequest("http://localhost/api/mcp/tasks", { headers: auth(readOnly) }));
    assert.equal(tasksRes.status, 403);
    assert.match((await tasksRes.json()).error, /read-only.*GET \/api\/mcp\/live/);

    const agentsRoute = await import("@/app/api/mcp/agents/route");
    assert.equal((await agentsRoute.GET(makeRequest("http://localhost/api/mcp/agents", { headers: auth(readOnly) }))).status, 403);

    const send = await import("@/app/api/mcp/messages/send/route");
    const sent = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: auth(readOnly, { "Idempotency-Key": randomUUID() }), body: { text: "hello", agentId: agent.id },
    }));
    assert.equal(sent.status, 403);

    const status = await import("@/app/api/mcp/chat/status/route");
    assert.equal((await status.POST(makeRequest("http://localhost/api/mcp/chat/status", {
        method: "POST", headers: auth(readOnly), body: { agentId: agent.id, typing: true },
    }))).status, 403);

    const requestsRoute = await import("@/app/api/mcp/requests/route");
    assert.equal((await requestsRoute.GET(makeRequest("http://localhost/api/mcp/requests", { headers: auth(readOnly) }))).status, 403);

    // The MCP protocol server and the websocket upgrade.
    const mcpServer = await import("@/app/mcp/route");
    const mcpRes = await mcpServer.POST(makeRequest("http://localhost/mcp", {
        method: "POST", headers: auth(readOnly, { accept: "application/json, text/event-stream" }),
        body: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    }));
    assert.equal(mcpRes.status, 403);
    const { verifyMcpAuthorizationHeader } = await import("@/lib/mcp");
    assert.equal((await verifyMcpAuthorizationHeader(`Bearer ${readOnly}`)).status, 403, "websocket upgrade path");
    assert.equal((await verifyMcpAuthorizationHeader(`Bearer ${readOnly}`, { allowRequestsScope: true })).status, 403, "requests opt-in does not admit read_only");

    // A requests token can't read the live feed.
    assert.equal((await getLive(requests)).status, 403);
});

async function seedMember(companyId: string, role = "member") {
    const db = await getDb();
    const { users, companyMembers } = await getSchema();
    const [user] = await db.insert(users).values({ email: `member-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values({ companyId, userId: user.id, role });
    return user.id;
}

async function seedScreenToken(companyId: string, createdByUserId: string | null, includePrivateChats: boolean) {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_screen_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: "Screen", scope: "read_only",
        createdByUserId, includePrivateChats,
    });
    return raw;
}

type DmThread = { agentId: string; messages: { id: string; me: boolean; text: string; ageSec: number }[] };

maybe("dm carries only the token creator's own exchanges with each agent", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const creator = await seedMember(companyId, "owner");
    const other = await seedMember(companyId);
    const db = await getDb();
    const { messageThreads, threadParticipants, threadMessages, companyMembers } = await getSchema();
    const now = Date.now();
    const ago = (sec: number) => new Date(now - sec * 1000);

    const ada = await seedAgent(companyId, { name: "Ada", lastSeenAt: new Date() });
    const bob = await seedAgent(companyId, { name: "Bob", lastSeenAt: new Date() });

    // Ada's direct chat, created the way the app does it (shared by every member).
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const adaDirect = await ensureDirectThread(companyId, ada.id);
    const bobDirect = await ensureDirectThread(companyId, bob.id);
    // A newer duplicate direct thread for Ada is not her chat (the app uses the oldest).
    const [dupe] = await db.insert(messageThreads).values({ companyId, type: "direct", title: "Dupe", createdAt: new Date(adaDirect.createdAt.getTime() + 1000) }).returning();
    await db.insert(threadParticipants).values({ companyId, threadId: dupe.id, participantType: "agent", participantId: ada.id });
    // A "direct" thread between two humans (no agent) never matches.
    const [humans] = await db.insert(messageThreads).values({ companyId, type: "direct", title: "Humans" }).returning();
    await db.insert(threadParticipants).values([
        { companyId, threadId: humans.id, participantType: "human", participantId: creator },
        { companyId, threadId: humans.id, participantType: "human", participantId: other },
    ]);
    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();

    const [creatorAsk] = await db.insert(threadMessages).values(
        { companyId, threadId: adaDirect.id, senderType: "human", senderId: creator, text: "**Creator** question", createdAt: ago(80) },
    ).returning();
    await db.insert(threadMessages).values([
        { companyId, threadId: adaDirect.id, senderType: "human", senderId: other, text: "Other member secret", createdAt: ago(100) },
        { companyId, threadId: adaDirect.id, senderType: "agent", senderId: ada.id, text: "Answer for the other member", createdAt: ago(90) },
        { companyId, threadId: adaDirect.id, senderType: "agent", senderId: ada.id, text: "Answer for creator", createdAt: ago(70) },
        { companyId, threadId: adaDirect.id, senderType: "human", senderId: other, text: "Other member second secret", createdAt: ago(60) },
        { companyId, threadId: adaDirect.id, senderType: "agent", senderId: ada.id, text: "Late reply to creator", metadataJson: { replyToMessageId: creatorAsk.id }, createdAt: ago(50) },
        { companyId, threadId: adaDirect.id, senderType: "agent", senderId: ada.id, text: "Reply to other second", createdAt: ago(40) },
        { companyId, threadId: adaDirect.id, senderType: "system", senderId: null, text: "Platform request secret", createdAt: ago(35) },
        { companyId, threadId: adaDirect.id, senderType: "agent", senderId: ada.id, text: "Answer for platform", createdAt: ago(30) },
        { companyId, threadId: adaDirect.id, senderType: "agent", senderId: ada.id, text: "control", metadataJson: { runtimeControl: { a: 1 } }, createdAt: ago(29) },
        { companyId, threadId: bobDirect.id, senderType: "human", senderId: other, text: "Bob, other member only", createdAt: ago(20) },
        { companyId, threadId: bobDirect.id, senderType: "agent", senderId: bob.id, text: "Bob answers other", createdAt: ago(19) },
        { companyId, threadId: dupe.id, senderType: "human", senderId: creator, text: "Creator in duplicate thread", createdAt: ago(15) },
        { companyId, threadId: humans.id, senderType: "human", senderId: creator, text: "Creator to a human", createdAt: ago(14) },
        { companyId, threadId: team.id, senderType: "human", senderId: creator, text: "Creator in team chat", createdAt: ago(13) },
    ]);
    // Ada is typing in her direct chat, answering the platform (not the creator).
    const { and, eq } = await import("drizzle-orm");
    await db.update(threadParticipants).set({ typingUntil: new Date(now + 60_000), currentActivity: "thinking: the creator's launch plan" })
        .where(and(eq(threadParticipants.threadId, adaDirect.id), eq(threadParticipants.participantType, "agent")));
    await db.update(threadParticipants).set({ typingUntil: new Date(now + 60_000), currentActivity: "thinking: other member's salary" })
        .where(and(eq(threadParticipants.threadId, bobDirect.id), eq(threadParticipants.participantType, "agent")));

    const off = await seedScreenToken(companyId, creator, false);
    const on = await seedScreenToken(companyId, creator, true);
    const legacy = await seedScreenToken(companyId, null, true);

    // Flag off (and a legacy token with no recorded creator): dm is [], activity masked.
    for (const token of [off, legacy]) {
        const raw = await (await getLive(token)).text();
        const feed = JSON.parse(raw);
        assert.deepEqual(feed.dm, []);
        assert.ok(!raw.includes("Creator question") && !raw.includes("secret") && !raw.includes("salary"));
        assert.equal(feed.agents.find((a: { id: string }) => a.id === ada.id).activity, "Working in a private chat");
    }

    const res = await getLive(on);
    assert.equal(res.status, 200);
    const raw = await res.text();
    const feed = JSON.parse(raw);
    assert.deepEqual(feed.dm.map((t: DmThread) => t.agentId), [ada.id], "only agents with a creator exchange");
    const adaDm = (feed.dm as DmThread[])[0].messages;
    assert.deepEqual(adaDm.map((m) => [m.me, m.text]), [
        [false, "Late reply to creator"],
        [false, "Answer for creator"],
        [true, "Creator question"],
    ]);
    assert.ok(adaDm[0].ageSec >= 50 && adaDm[0].ageSec < 120);
    for (const leaked of ["secret", "Answer for the other member", "Reply to other second", "Answer for platform", "Bob", "duplicate", "to a human", "salary", "control"]) {
        assert.ok(!JSON.stringify(feed.dm).includes(leaked), `dm must not include "${leaked}"`);
    }
    assert.ok(!raw.includes("secret") && !raw.includes("salary"));
    // Ada is answering the platform, Bob the other member: both stay masked.
    assert.equal(feed.agents.find((a: { id: string }) => a.id === ada.id).activity, "Working in a private chat");
    assert.equal(feed.agents.find((a: { id: string }) => a.id === bob.id).activity, "Working in a private chat");

    // The creator writes again: Ada is now answering them, so the screen shows the real activity.
    const etag = res.headers.get("etag")!;
    await db.insert(threadMessages).values({ companyId, threadId: adaDirect.id, senderType: "human", senderId: creator, text: "One more thing", createdAt: ago(1) });
    const next = await getLive(on, "", { "If-None-Match": etag });
    assert.equal(next.status, 200, "a new private message changes the ETag");
    const nextFeed = JSON.parse(await next.text());
    assert.equal(nextFeed.dm[0].messages[0].text, "One more thing");
    assert.equal(nextFeed.dm[0].messages.length, 4);
    assert.equal(nextFeed.agents.find((a: { id: string }) => a.id === ada.id).activity, "thinking: the creator's launch plan");
    assert.equal(nextFeed.agents.find((a: { id: string }) => a.id === bob.id).activity, "Working in a private chat");
    // Other tokens never unmask it.
    assert.equal(JSON.parse(await (await getLive(off)).text()).agents.find((a: { id: string }) => a.id === ada.id).activity, "Working in a private chat");

    // The creator is demoted below admin: the screen loses dm until restored.
    await db.update(companyMembers).set({ role: "member" }).where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, creator)));
    assert.deepEqual(JSON.parse(await (await getLive(on)).text()).dm, [], "a demoted creator's chats leave the screen");
    await db.update(companyMembers).set({ role: "owner" }).where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, creator)));

    // The creator leaves the company: the screen behaves as if the flag were off.
    await db.delete(companyMembers).where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, creator)));
    const removedRaw = await (await getLive(on)).text();
    const removed = JSON.parse(removedRaw);
    assert.deepEqual(removed.dm, []);
    assert.equal(removed.agents.find((a: { id: string }) => a.id === ada.id).activity, "Working in a private chat");
    assert.ok(!removedRaw.includes("Creator question") && !removedRaw.includes("launch plan"));
});

maybe("a member's screen never shows another member's chats, even with the flag on", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const creator = await seedMember(companyId, "admin");
    const other = await seedMember(companyId, "admin");
    const plain = await seedMember(companyId);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const ada = await seedAgent(companyId, { name: "Ada", lastSeenAt: new Date() });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const direct = await ensureDirectThread(companyId, ada.id);
    await db.insert(threadMessages).values([
        { companyId, threadId: direct.id, senderType: "human", senderId: other, text: "Only mine", createdAt: new Date(Date.now() - 20_000) },
        { companyId, threadId: direct.id, senderType: "agent", senderId: ada.id, text: "Reply to other", createdAt: new Date(Date.now() - 10_000) },
    ]);
    const feed = await (await getLive(await seedScreenToken(companyId, creator, true))).json();
    assert.deepEqual(feed.dm, []);
    const otherFeed = await (await getLive(await seedScreenToken(companyId, other, true))).json();
    assert.deepEqual(otherFeed.dm.map((t: DmThread) => t.messages.map((m) => [m.me, m.text])), [[[false, "Reply to other"], [true, "Only mine"]]]);
    // Only owners and admins can mint tokens; a token attributed to a plain member carries no chats.
    const plainFeed = await (await getLive(await seedScreenToken(companyId, plain, true))).json();
    assert.deepEqual(plainFeed.dm, []);
});
