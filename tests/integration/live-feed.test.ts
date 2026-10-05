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
