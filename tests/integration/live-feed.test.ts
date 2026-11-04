import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

/** One shared direct thread per agent (companies created before the setting). */
async function useSharedDirectChats(companyId: string) {
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ directChatMode: "shared" }).where(eq(companies.id, companyId));
}

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

    assert.equal(feed.v, 2);
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

async function seedScreenToken(companyId: string, createdByUserId: string | null, includePrivateChats: boolean, includeAgentThoughts = false) {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_screen_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: "Screen", scope: "read_only",
        createdByUserId, includePrivateChats, includeAgentThoughts,
    });
    return raw;
}

type DmThread = { agentId: string; messages: { id: string; me: boolean; text: string; ageSec: number }[] };

maybe("dm carries only the token creator's own exchanges with each agent", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    // The shared-channel `dm` rule (private mode is covered in private-thread-access.test.ts).
    await useSharedDirectChats(companyId);
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

    // The creator leaves the company: the tokens they minted stop working at all
    // (a removed person's screen must not keep showing company activity).
    await db.delete(companyMembers).where(and(eq(companyMembers.companyId, companyId), eq(companyMembers.userId, creator)));
    const removedRes = await getLive(on);
    assert.equal(removedRes.status, 401);
    const removedRaw = await removedRes.text();
    assert.ok(!removedRaw.includes("Creator question") && !removedRaw.includes("launch plan"));
});

maybe("a member's screen never shows another member's chats, even with the flag on", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    // The shared-channel `dm` rule (private mode is covered in private-thread-access.test.ts).
    await useSharedDirectChats(companyId);
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

maybe("v2: look, act, mood, thought, events and needs, with private threads kept off the screen", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    // The shared-channel `dm` rule (private mode is covered in private-thread-access.test.ts).
    await useSharedDirectChats(companyId);
    const creator = await seedMember(companyId, "owner");
    const other = await seedMember(companyId);
    const db = await getDb();
    const { messageThreads, threadParticipants, threadMessages, threadMessageReasoning, projects, tasks, taskEvents, approvals, approvalTaskLinks, incidents } = await getSchema();
    const now = Date.now();
    const ago = (sec: number) => new Date(now - sec * 1000);

    const appearance = { version: 1, kind: "human", seed: "ada-seed", hue: 205, variant: 2, skin: 1, hair: 3, accessory: "glasses" };
    const ada = await seedAgent(companyId, { name: "Ada Researcher", lastSeenAt: new Date(), avatarAppearance: appearance });
    const bob = await seedAgent(companyId, { name: "Bob Builder", lastSeenAt: new Date() });
    const cy = await seedAgent(companyId, { name: "Cy Ops", lastSeenAt: new Date() });
    const dee = await seedAgent(companyId, { name: "Dee Data", lastSeenAt: new Date() });

    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const bobDirect = await ensureDirectThread(companyId, bob.id);
    const cyDirect = await ensureDirectThread(companyId, cy.id);
    await db.insert(threadParticipants).values({ companyId, threadId: team.id, participantType: "agent", participantId: ada.id, typingUntil: new Date(now + 60_000), currentActivity: "debugging the build" });

    // Ada hands off to Bob in team chat; Bob answers the creator and Cy
    // answers another member in their direct chats.
    const [handoff, adaOld, adaStale] = await db.insert(threadMessages).values([
        { companyId, threadId: team.id, senderType: "agent", senderId: ada.id, text: "@Bob Builder can you take the deploy?", createdAt: ago(30) },
        { companyId, threadId: team.id, senderType: "agent", senderId: ada.id, text: "Earlier note", createdAt: ago(90) },
        { companyId, threadId: team.id, senderType: "agent", senderId: ada.id, text: "Stale note", createdAt: ago(20 * 60) },
    ]).returning();
    const [creatorAsk] = await db.insert(threadMessages).values({ companyId, threadId: bobDirect.id, senderType: "human", senderId: creator, text: "Bob, status?", createdAt: ago(60) }).returning();
    const [bobReply] = await db.insert(threadMessages).values({ companyId, threadId: bobDirect.id, senderType: "agent", senderId: bob.id, text: "On it", metadataJson: { replyToMessageId: creatorAsk.id }, createdAt: ago(50) }).returning();
    await db.insert(threadMessages).values({ companyId, threadId: cyDirect.id, senderType: "human", senderId: other, text: "Cy, private question", createdAt: ago(40) });
    const [cyReply] = await db.insert(threadMessages).values({ companyId, threadId: cyDirect.id, senderType: "agent", senderId: cy.id, text: "Private answer", createdAt: ago(35) }).returning();

    await db.insert(threadMessageReasoning).values([
        { companyId, messageId: handoff.id, reasoning: "Reading the deploy logs with ghp_abcdefghijk123456.\n\nThe build fails at /home/ada/app with key sk-live123456789abc; asking Bob to take the deploy at https://ci.example.com/run/1\n\nok", createdAt: ago(25) },
        { companyId, messageId: adaOld.id, reasoning: "An older thought that should lose to the newer one", createdAt: ago(80) },
        { companyId, messageId: adaStale.id, reasoning: "A stale thought from twenty minutes ago, never shown", createdAt: ago(20 * 60) },
        { companyId, messageId: bobReply.id, reasoning: "The creator wants the launch status for the board", createdAt: ago(45) },
        { companyId, messageId: cyReply.id, reasoning: "The other member asked a sensitive salary question", createdAt: ago(30) },
    ]);

    // Work: Bob finished a task, Cy got blocked, Cy requests approval, Dee holds a stuck task.
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const [done, blocked, gated, stuck] = await db.insert(tasks).values([
        { companyId, projectId: project.id, taskType: "deploy", state: "done", assignedAgentId: bob.id, inputJson: { title: "Ship the landing page" } },
        { companyId, projectId: project.id, taskType: "ops", state: "blocked", assignedAgentId: cy.id, inputJson: { title: "Rotate the certificates" } },
        { companyId, projectId: project.id, taskType: "ops", state: "review", assignedAgentId: cy.id, inputJson: { title: "Publish the release notes" } },
        { companyId, projectId: project.id, taskType: "code", state: "failed", assignedAgentId: dee.id, inputJson: { title: "Migrate the database" } },
    ]).returning();
    await db.insert(taskEvents).values([
        { companyId, taskId: done.id, eventType: "task_done", actorType: "agent", actorId: bob.id, createdAt: ago(20) },
        { companyId, taskId: blocked.id, eventType: "task_blocked", actorType: "agent", actorId: cy.id, createdAt: ago(15) },
        { companyId, taskId: done.id, eventType: "task_done", actorType: "agent", actorId: bob.id, createdAt: ago(30 * 60) },
    ]);
    const [approval] = await db.insert(approvals).values({ companyId, projectId: project.id, requesterAgentId: cy.id, status: "pending", actionType: "task_done", requestedAt: ago(10) }).returning();
    // Two linked tasks: the title comes from the lowest task id, the same on every poll.
    await db.insert(approvalTaskLinks).values([{ companyId, approvalId: approval.id, taskId: gated.id }, { companyId, approvalId: approval.id, taskId: done.id }]);
    const approvalTask = [gated, done].sort((x, y) => (x.id < y.id ? -1 : 1))[0];
    const approvalTitle = `Approve ${(approvalTask.inputJson as { title: string }).title}`;
    await db.insert(incidents).values({ companyId, projectId: project.id, taskId: stuck.id, severity: "high", reasonCode: "max_retries_exceeded", summary: "Task exceeded retries" });

    const off = await seedScreenToken(companyId, creator, false, true);
    const on = await seedScreenToken(companyId, creator, true, true);
    const noThoughts = await seedScreenToken(companyId, creator, true, false);
    const legacyReadOnly = await seedScopedToken(companyId, "read_only");

    // Thoughts are opt-in per token: a screen without the setting (and any
    // older read_only token) gets every other v2 key but never a thought.
    for (const token of [noThoughts, legacyReadOnly]) {
        const plain = JSON.parse(await (await getLive(token)).text());
        assert.equal(plain.v, 2);
        assert.ok(plain.agents.every((a: Record<string, unknown>) => !("thought" in a) && !("thoughtAgeSec" in a)));
        assert.ok(plain.agents.every((a: Record<string, unknown>) => a.look && a.act && a.mood));
        assert.equal(plain.events.length, 4);
    }

    const res = await getLive(off);
    assert.equal(res.status, 200);
    const raw = await res.text();
    const feed = JSON.parse(raw);
    assert.equal(feed.v, 2);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = (list: { id: string }[], id: string) => list.find((a) => a.id === id) as Record<string, any>;

    // look: the same resolver and hair math as the web.
    const { packLook, liveEventId } = await import("@/lib/live-feed-v2");
    const { resolveAppearance } = await import("@/lib/character/model");
    assert.deepEqual(byId(feed.agents, ada.id).look, { k: "h", u: 205, v: 2, s: 1, h: 3, hs: 1, a: "g" });
    assert.deepEqual(byId(feed.agents, bob.id).look, packLook(resolveAppearance({ id: bob.id })));

    // act + mood: the office scene's mapping.
    assert.equal(byId(feed.agents, ada.id).act, "typing");
    assert.equal(byId(feed.agents, ada.id).mood, "focused");
    assert.equal(byId(feed.agents, bob.id).act, "celebrate", "just finished a task");
    assert.equal(byId(feed.agents, bob.id).mood, "happy");
    assert.equal(byId(feed.agents, dee.id).act, "blocked", "a failed task with an open incident is stuck");
    assert.equal(byId(feed.agents, dee.id).mood, "worried");
    assert.equal(byId(feed.agents, cy.id).act, "waiting", "work in review, approval pending");

    // thought: newest substantive, redacted, with an age; nothing private.
    const adaLive = byId(feed.agents, ada.id);
    assert.equal(adaLive.thought, "The build fails at [path] with key [secret]; asking Bob to take the deploy at [link]");
    assert.ok(adaLive.thoughtAgeSec >= 25 && adaLive.thoughtAgeSec < 120);
    assert.equal("thought" in byId(feed.agents, bob.id), false, "a direct-chat thought needs the private-chats opt-in");
    assert.equal("thoughtAgeSec" in byId(feed.agents, bob.id), false);
    assert.equal("thought" in byId(feed.agents, cy.id), false);
    for (const leaked of ["salary", "launch status", "stale thought", "ghp_", "sk-live", "/home/ada", "ci.example"]) {
        assert.ok(!raw.includes(leaked), `"${leaked}" must not reach the screen`);
    }

    // events: newest first; handoff, blocked, done, needs_you; old ones excluded.
    assert.deepEqual(feed.events.map((e: { t: string }) => e.t), ["needs_you", "blocked", "task_done", "handoff"]);
    assert.deepEqual(feed.events[3], { id: liveEventId("handoff", handoff.id), t: "handoff", a: ada.id, b: bob.id, ageSec: feed.events[3].ageSec });
    assert.equal(feed.events[2].a, bob.id);
    assert.equal(feed.events[2].title, "Ship the landing page");
    assert.equal(feed.events[1].a, cy.id);
    assert.equal(feed.events[1].title, "Rotate the certificates");
    assert.equal(feed.events[0].title, approvalTitle);
    assert.deepEqual(feed.needs, [{ agentId: cy.id, title: approvalTitle }]);
    assert.equal(feed.summary.pendingApprovals, 1);

    // The ETag ignores ages: an immediate re-poll is a 304.
    const again = await getLive(off, "", { "If-None-Match": res.headers.get("etag")! });
    assert.equal(again.status, 304);

    // Opted in: the creator's own exchange may show Bob's thought; Cy's chat with another member never does.
    const onRaw = await (await getLive(on)).text();
    const onFeed = JSON.parse(onRaw);
    assert.equal(byId(onFeed.agents, bob.id).thought, "The creator wants the launch status for the board");
    assert.equal("thought" in byId(onFeed.agents, cy.id), false);
    assert.ok(!onRaw.includes("salary"));
});

maybe("thought comes from the live run step, never from a private or empty one", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { messageThreads, agentRuns, agentRunEvents } = await getSchema();
    const now = Date.now();
    const ago = (sec: number) => new Date(now - sec * 1000);
    const creator = await seedMember(companyId, "owner");
    const ada = await seedAgent(companyId, { name: "Ada", lastSeenAt: new Date() });
    const bob = await seedAgent(companyId, { name: "Bob", lastSeenAt: new Date() });
    const cy = await seedAgent(companyId, { name: "Cy", lastSeenAt: new Date() });
    const dee = await seedAgent(companyId, { name: "Dee", lastSeenAt: new Date() });

    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    // Private direct chats (the default): Bob's chat belongs to another member.
    const other = await seedMember(companyId);
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const bobDirect = await ensureDirectThread(companyId, bob.id, other);
    // The agent's shared chat (the Work log in private mode): every member takes part.
    const eve = await seedAgent(companyId, { name: "Eve", lastSeenAt: new Date() });
    const eveWorkLog = await ensureDirectThread(companyId, eve.id);
    const fay = await seedAgent(companyId, { name: "Fay", lastSeenAt: new Date() });
    const fayMine = await ensureDirectThread(companyId, fay.id, creator);

    const run = async (agentId: string, threadId: string | null, events: { kind: string; toolName?: string; summary?: string }[]) => {
        const id = randomUUID();
        await db.insert(agentRuns).values({ id, companyId, agentId, threadId, status: "running", startedAt: ago(60) });
        if (events.length) {
            await db.insert(agentRunEvents).values(events.map((e, i) => ({
                id: randomUUID(), companyId, runId: id, agentId, threadId, seq: i + 1, ts: ago(30 - i), kind: e.kind,
                toolName: e.toolName ?? null, summary: e.summary ?? null,
            })));
        }
    };
    // Ada thinks in team chat; Dee runs a tool for a task; Bob thinks in a
    // direct chat the creator is not part of; Cy has only a bare reasoning beat.
    await run(ada.id, team.id, [{ kind: "reasoning", summary: "Comparing the two supplier quotes before replying" }]);
    await run(dee.id, null, [{ kind: "tool.start", toolName: "terminal", summary: "npm test" }]);
    await run(bob.id, bobDirect.id, [{ kind: "reasoning", summary: "The salary question from the other member" }]);
    await run(cy.id, team.id, [{ kind: "reasoning" }]);
    await run(eve.id, eveWorkLog.id, [{ kind: "reasoning", summary: "Routine wake from another member about payroll" }]);
    await run(fay.id, fayMine.id, [{ kind: "reasoning", summary: "Answering the creator about the launch date" }]);

    const screen = await seedScreenToken(companyId, creator, true, true);
    const noThoughts = await seedScreenToken(companyId, creator, true, false);

    const raw = await (await getLive(screen)).text();
    const feed = JSON.parse(raw);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = (id: string) => feed.agents.find((a: { id: string }) => a.id === id) as Record<string, any>;
    assert.equal(byId(ada.id).thought, "Comparing the two supplier quotes before replying");
    assert.ok(byId(ada.id).thoughtAgeSec >= 29 && byId(ada.id).thoughtAgeSec < 120);
    assert.equal(byId(dee.id).thought, "Running terminal: npm test");
    assert.equal("thought" in byId(bob.id), false, "another member's direct chat stays off the screen");
    assert.equal("thought" in byId(cy.id), false, "a bare Thinking… is not shown as a thought");
    assert.equal("thought" in byId(eve.id), false, "the shared Work log is not the creator's own chat");
    assert.equal(byId(fay.id).thought, "Answering the creator about the launch date");
    assert.ok(!raw.includes("salary"));
    assert.ok(!raw.includes("payroll"));
    assert.ok(feed.agents.every((a: { thought?: string }) => !a.thought?.includes("Thinking")), "no placeholder thoughts");

    const plain = JSON.parse(await (await getLive(noThoughts)).text());
    assert.ok(plain.agents.every((a: Record<string, unknown>) => !("thought" in a)), "thoughts stay opt-in per token");
});

maybe("step: label and text on a readable run, label only on a private one; last for idle agents", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { messageThreads, agentRuns, agentRunEvents, projects, tasks } = await getSchema();
    const now = Date.now();
    const ago = (sec: number) => new Date(now - sec * 1000);
    const creator = await seedMember(companyId, "owner");
    const other = await seedMember(companyId);
    const ada = await seedAgent(companyId, { name: "Ada Lovelace", lastSeenAt: new Date() });
    const bob = await seedAgent(companyId, { name: "Bob Builder", lastSeenAt: new Date() });
    const eve = await seedAgent(companyId, { name: "Eve Work Log", lastSeenAt: new Date() });
    const ivy = await seedAgent(companyId, { name: "Ivy Idle", lastSeenAt: new Date() });
    const sam = await seedAgent(companyId, { name: "Sam Stale", lastSeenAt: new Date() });
    const otto = await seedAgent(companyId, { name: "Otto Offline", lastSeenAt: ago(3600) });

    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const bobDirect = await ensureDirectThread(companyId, bob.id, other);
    const eveWorkLog = await ensureDirectThread(companyId, eve.id);

    const run = async (agentId: string, threadId: string | null, events: { kind: string; toolName?: string; summary?: string }[], eventAgeSec = 30) => {
        const id = randomUUID();
        await db.insert(agentRuns).values({ id, companyId, agentId, threadId, status: "running", startedAt: ago(eventAgeSec + 30) });
        await db.insert(agentRunEvents).values(events.map((e, i) => ({
            id: randomUUID(), companyId, runId: id, agentId, threadId, seq: i + 1, ts: ago(eventAgeSec - i), kind: e.kind,
            toolName: e.toolName ?? null, summary: e.summary ?? null,
        })));
    };
    await run(ada.id, team.id, [{ kind: "tool.start", toolName: "terminal", summary: "npm test" }]);
    await run(bob.id, bobDirect.id, [{ kind: "tool.start", toolName: "terminal", summary: "cat salary.csv" }]);
    await run(eve.id, eveWorkLog.id, [{ kind: "reasoning", summary: "Routine wake about payroll" }]);
    // Left `running` by a crashed bridge: last event 20 minutes ago; and a run of an offline agent.
    await run(sam.id, team.id, [{ kind: "tool.start", toolName: "terminal", summary: "npm run stale" }], 1200);
    await run(otto.id, team.id, [{ kind: "tool.start", toolName: "terminal", summary: "npm run ghost" }]);

    const [project] = await db.insert(projects).values({ companyId, goal: "Ops", status: "active" }).returning();
    const [older, cafe, ancient] = await db.insert(tasks).values([
        // Finished two hours ago, edited a minute ago: the edit does not make it the newest.
        { companyId, projectId: project.id, taskType: "report", state: "done", assignedAgentId: ivy.id, inputJson: { title: "Older report" }, updatedAt: ago(60) },
        { companyId, projectId: project.id, taskType: "report", state: "done", assignedAgentId: ivy.id, inputJson: { title: "Publish the café menu" }, updatedAt: ago(600) },
        { companyId, projectId: project.id, taskType: "report", state: "done", assignedAgentId: ivy.id, inputJson: { title: "Ancient work" }, updatedAt: ago(8 * 24 * 3600) },
        { companyId, projectId: project.id, taskType: "ops", state: "in_progress", assignedAgentId: ada.id, inputJson: { title: "Rotate key sk-abcdefghijklmnopqrstuvwxyz0123456789" } },
    ]).returning();
    const { taskEvents } = await getSchema();
    await db.insert(taskEvents).values([
        { companyId, taskId: older.id, eventType: "task_done", actorType: "agent", actorId: ivy.id, createdAt: ago(7200) },
        { companyId, taskId: older.id, eventType: "task_updated", payloadJson: { title: "Older report" }, actorType: "human", createdAt: ago(60) },
        { companyId, taskId: cafe.id, eventType: "task_updated", payloadJson: { state: "done" }, actorType: "agent", actorId: ivy.id, createdAt: ago(600) },
        { companyId, taskId: ancient.id, eventType: "task_done", actorType: "agent", actorId: ivy.id, createdAt: ago(8 * 24 * 3600) },
    ]);

    const screen = await seedScreenToken(companyId, creator, true, true);
    const raw = await (await getLive(screen)).text();
    const feed = JSON.parse(raw);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = (f: any, id: string) => f.agents.find((a: { id: string }) => a.id === id) as Record<string, any>;
    assert.deepEqual({ ...byId(feed, ada.id).step, sec: 0 }, { label: "Using terminal", text: "npm test", sec: 0 });
    assert.ok(byId(feed, ada.id).step.sec >= 29 && byId(feed, ada.id).step.sec < 120);
    assert.deepEqual(Object.keys(byId(feed, bob.id).step).sort(), ["label", "sec"], "another member's private chat: label only");
    assert.equal(byId(feed, bob.id).step.label, "Working in a private chat", "not even the tool name");
    assert.deepEqual(Object.keys(byId(feed, eve.id).step).sort(), ["label", "sec"], "the shared Work log: label only");
    assert.equal(byId(feed, eve.id).step.label, "Working in a private chat");
    assert.equal("step" in byId(feed, sam.id), false, "a run with no event for 20 minutes is not live work");
    assert.equal("thought" in byId(feed, sam.id), false);
    assert.equal(byId(feed, otto.id).state, "offline");
    assert.equal("step" in byId(feed, otto.id), false, "an offline agent's leftover run is not live work");
    assert.ok(!raw.includes("npm run stale") && !raw.includes("npm run ghost"));
    assert.ok(byId(feed, ada.id).task.title.startsWith("Rotate key"));
    assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), "task titles are redacted");
    assert.equal("step" in byId(feed, ivy.id), false, "no running run, no step");
    assert.ok(!raw.includes("salary") && !raw.includes("payroll"));

    assert.equal(byId(feed, ivy.id).last.title, "Publish the cafe menu", "the newest finished task, ASCII");
    assert.ok(byId(feed, ivy.id).last.ageSec >= 599 && byId(feed, ivy.id).last.ageSec < 700);
    assert.equal(byId(feed, ada.id).name, "Ada Lovelace", "the full name is always sent");
    assert.equal(byId(feed, ada.id).short, "Ada", "short stays the first word for 2.0 firmware");

    // Without thoughts: the generic label still shows, never the text.
    const plainRaw = await (await getLive(await seedScreenToken(companyId, creator, false, false))).text();
    const plain = JSON.parse(plainRaw);
    assert.deepEqual(Object.keys(byId(plain, ada.id).step).sort(), ["label", "sec"]);
    assert.equal(byId(plain, ada.id).step.label, "Using terminal");
    assert.equal(byId(plain, bob.id).step.label, "Working in a private chat", "a direct run on a token without thoughts");
    assert.ok(!plainRaw.includes("salary") && !plainRaw.includes("payroll"));
    assert.ok(!plainRaw.includes("npm test"));
    assert.equal(byId(plain, ivy.id).last.title, "Publish the cafe menu");

    // A member scoped away from Ada: her step goes with her.
    const { scopeLiveFeed } = await import("@/lib/live-feed");
    const scoped = scopeLiveFeed(feed, [ivy.id]);
    assert.ok(!JSON.stringify(scoped).includes("npm test"));
});

maybe("today: cost, runs, tokens and tasks done since midnight, for the screen's agents only", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { agentRuns, projects, tasks, companies, taskEvents, messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    // Midnight in UTC for this company, and "now" well after it.
    await db.update(companies).set({ agentRoutineJson: { timezone: "UTC" } }).where(eq(companies.id, companyId));
    const now = new Date();
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const afterMidnight = (sec: number) => new Date(Math.min(now.getTime() - 1000, midnight.getTime() + sec * 1000));
    const creator = await seedMember(companyId, "owner");
    const ana = await seedAgent(companyId, { name: "Ana Analyst", lastSeenAt: new Date() });
    const ben = await seedAgent(companyId, { name: "Ben Builder", lastSeenAt: new Date() });
    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const other = await seedMember(companyId);
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const othersChat = await ensureDirectThread(companyId, ana.id, other);
    const workLog = await ensureDirectThread(companyId, ana.id);
    const creatorsChat = await ensureDirectThread(companyId, ben.id, creator);
    await db.insert(agentRuns).values([
        { id: randomUUID(), companyId, agentId: ana.id, threadId: team.id, status: "succeeded", startedAt: afterMidnight(1), inputTokens: 1500, outputTokens: 600, costCents: 120 },
        { id: randomUUID(), companyId, agentId: ana.id, status: "succeeded", startedAt: afterMidnight(2), inputTokens: 400, outputTokens: 100, costCents: 35 },
        // A runtime that reports no cost (null or 0) never turns into $0.00.
        { id: randomUUID(), companyId, agentId: ben.id, status: "succeeded", startedAt: afterMidnight(3), inputTokens: 1500, outputTokens: 0, costCents: null },
        { id: randomUUID(), companyId, agentId: ben.id, status: "succeeded", startedAt: afterMidnight(3), inputTokens: 500, outputTokens: 0, costCents: 0 },
        // Another member's private chat and the shared Work log: never on a screen, not even as totals.
        { id: randomUUID(), companyId, agentId: ana.id, threadId: othersChat.id, status: "succeeded", startedAt: afterMidnight(2), inputTokens: 50_000, outputTokens: 0, costCents: 500 },
        { id: randomUUID(), companyId, agentId: ana.id, threadId: workLog.id, status: "succeeded", startedAt: afterMidnight(2), inputTokens: 50_000, outputTokens: 0, costCents: 500 },
        // The screen creator's own private chat: counted only on a screen allowed to show it.
        { id: randomUUID(), companyId, agentId: ben.id, threadId: creatorsChat.id, status: "succeeded", startedAt: afterMidnight(2), inputTokens: 1000, outputTokens: 0, costCents: 7 },
        // Yesterday: not today.
        { id: randomUUID(), companyId, agentId: ana.id, status: "succeeded", startedAt: new Date(midnight.getTime() - 60_000), inputTokens: 9000, outputTokens: 9000, costCents: 999 },
    ]);
    const [project] = await db.insert(projects).values({ companyId, goal: "Ops", status: "active" }).returning();
    const [shipped, old] = await db.insert(tasks).values([
        { companyId, projectId: project.id, taskType: "report", state: "done", assignedAgentId: ben.id, inputJson: { title: "Ship it" }, updatedAt: afterMidnight(4) },
        // Finished yesterday, edited today: not done today.
        { companyId, projectId: project.id, taskType: "report", state: "done", assignedAgentId: ben.id, inputJson: { title: "Old" }, updatedAt: afterMidnight(5) },
    ]).returning();
    await db.insert(taskEvents).values([
        { companyId, taskId: shipped.id, eventType: "task_done", actorType: "agent", actorId: ben.id, createdAt: afterMidnight(4) },
        // A second completion of the same task counts once.
        { companyId, taskId: shipped.id, eventType: "task_updated", payloadJson: { state: "done" }, actorType: "agent", actorId: ben.id, createdAt: afterMidnight(4) },
        { companyId, taskId: old.id, eventType: "task_done", actorType: "agent", actorId: ben.id, createdAt: new Date(midnight.getTime() - 60_000) },
        { companyId, taskId: old.id, eventType: "task_updated", payloadJson: { title: "Old (edited)" }, actorType: "human", createdAt: afterMidnight(5) },
    ]);

    const raw = await (await getLive(await seedScreenToken(companyId, creator, false))).text();
    const feed = JSON.parse(raw);
    assert.deepEqual(feed.today, { cost: 155, runs: 4, tokensK: 5, done: 1, top: [{ agentId: ana.id, cost: 155 }] });
    assert.ok(!raw.includes("\"rows\""), "per-agent rows never reach the device");
    const opted = JSON.parse(await (await getLive(await seedScreenToken(companyId, creator, true, true))).text());
    assert.deepEqual(opted.today, { cost: 162, runs: 5, tokensK: 6, done: 1, top: [{ agentId: ana.id, cost: 155 }, { agentId: ben.id, cost: 7 }] }, "the creator's own chat counts on their opted-in screen");

    // A narrower viewer (member scope / limited agents) sees only its agents' day.
    const { buildLiveFeed, scopeLiveFeed } = await import("@/lib/live-feed");
    const built = await buildLiveFeed(companyId, { now });
    assert.deepEqual(scopeLiveFeed(built, [ben.id]).today, { cost: null, runs: 2, tokensK: 2, done: 1, top: [] }, "Ben's runs reported no cost: null, not 0");
    assert.deepEqual(scopeLiveFeed(built, [ana.id]).today, { cost: 155, runs: 2, tokensK: 3, done: 0, top: [{ agentId: ana.id, cost: 155 }] });
});
