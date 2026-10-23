import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

/**
 * Private direct threads (private direct-chat mode) must not leak to anyone but
 * their owner and their own agent: not over realtime (mcp_events), not over the
 * MCP REST routes, not once the owner is gone, not via the delivery inspector,
 * and not via a display token's `dm`.
 */
const maybe = dbAvailable ? test : test.skip;

async function token(companyId: string, agentId: string | null): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, agentId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: `t-${randomUUID()}`, scope: "mcp_full",
    });
    return raw;
}

/** Company in private mode: owner A, member B, agents X and Y, A's private thread with X holding one message. */
async function seedPrivateChat() {
    await resetDb();
    const db = await getDb();
    const { users, companies, companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId, userId: userA } = await seedCompanyWithToken();
    const [b] = await db.insert(users).values({ email: `b-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values([
        { companyId, userId: userA, role: "owner" },
        { companyId, userId: b.id, role: "member" },
    ]);
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    const agentX = await seedAgent(companyId, { name: "Xavier", provider: "hermes" });
    const agentY = await seedAgent(companyId, { name: "Yolanda", provider: "hermes" });
    const { ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, agentX.id, userA);
    const message = await appendThreadMessage({ companyId, threadId: thread.id, senderType: "human", senderId: userA, targetAgentId: agentX.id, text: "secret plan" });
    return {
        companyId, userA, userB: b.id, agentX, agentY, thread, message,
        tokenX: await token(companyId, agentX.id),
        tokenY: await token(companyId, agentY.id),
        tokenUnbound: await token(companyId, null),
    };
}

const auth = (raw: string) => ({ authorization: `Bearer ${raw}` });

maybe("realtime: an event about a private thread reaches only its own agent's socket", async () => {
    const s = await seedPrivateChat();
    const { Client } = await import("pg");
    const listener = new Client({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (msg) => { if (msg.payload) received.push(msg.payload); });
    await listener.query("LISTEN mcp_events");
    try {
        const { broadcastMcpEvent } = await import("@/lib/pubsub");
        const { ensureTeamThread } = await import("@/lib/control-plane");
        await broadcastMcpEvent(s.companyId, { type: "thread_message", thread: s.thread, message: s.message });
        await broadcastMcpEvent(s.companyId, { type: "participant_status", threadId: s.thread.id, participantId: s.userA, typing: true });
        const team = await ensureTeamThread(s.companyId);
        await broadcastMcpEvent(s.companyId, { type: "thread_message", threadId: team.id, message: { id: "m", threadId: team.id } });
        for (let i = 0; i < 50 && received.length < 3; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(received.length, 3);

        const { parseRealtimeNotification, socketReceives } = await import("@/lib/realtime-delivery");
        const [privateMessage, typing, teamMessage] = received.map((raw) => parseRealtimeNotification(raw)!);
        const sockets = {
            x: { companyId: s.companyId, agentId: s.agentX.id },
            y: { companyId: s.companyId, agentId: s.agentY.id },
            unbound: { companyId: s.companyId, agentId: null },
        };
        for (const event of [privateMessage, typing]) {
            assert.equal(socketReceives(event, sockets.x), true, "the thread's own agent gets it");
            assert.equal(socketReceives(event, sockets.y), false, "another agent's bridge does not");
            assert.equal(socketReceives(event, sockets.unbound), false, "a company-wide token does not");
        }
        assert.ok(Object.values(sockets).every((socket) => socketReceives(teamMessage, socket)), "team events still reach everyone");
    } finally {
        await listener.end();
    }
});

maybe("MCP threads: another agent's or an unbound token cannot read, post into or list a private thread", async () => {
    const s = await seedPrivateChat();
    const messagesRoute = await import("@/app/api/mcp/threads/[id]/messages/route");
    const params = { params: Promise.resolve({ id: s.thread.id }) };
    const url = `http://localhost/api/mcp/threads/${s.thread.id}/messages`;

    assert.equal((await messagesRoute.GET(makeRequest(url, { headers: auth(s.tokenY) }), params)).status, 404);
    assert.equal((await messagesRoute.GET(makeRequest(url, { headers: auth(s.tokenUnbound) }), params)).status, 404);
    assert.equal((await messagesRoute.POST(makeRequest(url, { method: "POST", headers: auth(s.tokenY), body: { text: "hi" } }), params)).status, 404);
    assert.equal((await messagesRoute.POST(makeRequest(url, { method: "POST", headers: auth(s.tokenUnbound), body: { text: "hi", senderId: s.agentX.id } }), params)).status, 404);
    const own = await messagesRoute.GET(makeRequest(url, { headers: auth(s.tokenX) }), params);
    assert.equal(own.status, 200, "the thread's own agent still reads it");

    const listRoute = await import("@/app/api/mcp/threads/route");
    const list = async (raw: string, query = "") => {
        const res = await listRoute.GET(makeRequest(`http://localhost/api/mcp/threads?type=direct${query}`, { headers: auth(raw) }));
        return ((await res.json()) as { threads: { id: string }[] }).threads.map((t) => t.id);
    };
    assert.ok(!(await list(s.tokenUnbound)).includes(s.thread.id));
    assert.ok(!(await list(s.tokenUnbound, `&agentId=${s.agentX.id}`)).includes(s.thread.id));
    assert.ok((await list(s.tokenX)).includes(s.thread.id));
});

maybe("MCP send, status, runs, control and sync refuse a private thread to other tokens", async () => {
    const s = await seedPrivateChat();
    const db = await getDb();
    const { threadMessages, threadParticipants } = await getSchema();
    const { and, eq } = await import("drizzle-orm");

    const send = await import("@/app/api/mcp/messages/send/route");
    const viaThread = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: auth(s.tokenY), body: { text: "hello", thread_id: s.thread.id } }));
    assert.equal(viaThread.status, 404);
    const viaReply = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: auth(s.tokenUnbound), body: { text: "hello", agentId: s.agentX.id, replyToMessageId: s.message.id } }));
    assert.equal(viaReply.status, 404);

    const status = await import("@/app/api/mcp/chat/status/route");
    const statusRes = await status.POST(makeRequest("http://localhost/api/mcp/chat/status", { method: "POST", headers: auth(s.tokenY), body: { threadId: s.thread.id, agentId: s.agentY.id, typing: true } }));
    assert.equal(statusRes.status, 404);
    const joined = await db.select().from(threadParticipants).where(and(eq(threadParticipants.threadId, s.thread.id), eq(threadParticipants.participantId, s.agentY.id)));
    assert.equal(joined.length, 0, "agent Y never becomes a participant of the private thread");

    const runs = await import("@/app/api/mcp/agents/runs/route");
    const runRes = await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", { method: "POST", headers: auth(s.tokenY), body: { id: randomUUID(), agentId: s.agentY.id, threadId: s.thread.id } }));
    assert.equal(runRes.status, 404);

    // A scoped /replace prompt from A's private thread is a control command for X.
    await db.insert(threadMessages).values({
        companyId: s.companyId, threadId: s.thread.id, senderType: "system", targetAgentId: s.agentX.id, text: "replace: secret plan",
        deliveryState: "queued", metadataJson: { runtimeControl: { action: "replace", prompt: "secret plan" } },
    });
    const control = await import("@/app/api/mcp/agents/control/route");
    const controlFor = async (raw: string) => {
        const res = await control.GET(makeRequest(`http://localhost/api/mcp/agents/control?agentId=${s.agentX.id}`, { headers: auth(raw) }));
        return ((await res.json()) as { commands: unknown[] }).commands.length;
    };
    assert.equal(await controlFor(s.tokenUnbound), 0, "an unbound token cannot read private control prompts");
    assert.equal(await controlFor(s.tokenX), 1);

    const sync = await import("@/app/api/mcp/messages/sync/route");
    const since = new Date(Date.now() - 60_000).toISOString();
    const syncFor = async (raw: string) => {
        const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?agentId=${s.agentX.id}&since=${encodeURIComponent(since)}`, { headers: auth(raw) }));
        return ((await res.json()) as { messages: { id: string }[] }).messages.map((m) => m.id);
    };
    assert.ok((await syncFor(s.tokenX)).includes(s.message.id), "the bound agent still gets its private messages");
    assert.ok(!(await syncFor(s.tokenUnbound)).includes(s.message.id), "an unbound token naming the agent does not");
});

maybe("orphaned private thread: once the owner is deleted nobody can use it, and leaving archives it", async () => {
    const s = await seedPrivateChat();
    const db = await getDb();
    const { users, messageThreads, notifications } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { canUseDirectThread, ensureDirectThread, appendThreadMessage, archivePrivateThreadsOf } = await import("@/lib/control-plane");

    // B's private thread with X; then B's account is deleted (owner_user_id -> NULL).
    const threadB = await ensureDirectThread(s.companyId, s.agentX.id, s.userB);
    await db.delete(users).where(eq(users.id, s.userB));
    const [orphan] = await db.select().from(messageThreads).where(eq(messageThreads.id, threadB.id));
    assert.equal(orphan.ownerUserId, null);
    assert.equal(orphan.isPrivate, true);
    assert.equal(canUseDirectThread(orphan, s.userA), false, "an ownerless private thread is nobody's");
    const shared = await ensureDirectThread(s.companyId, s.agentX.id, null);
    assert.notEqual(shared.id, threadB.id, "it never becomes the Operations thread");

    await db.update(users).set({ displayName: "Ann" }).where(eq(users.id, s.userA));
    await appendThreadMessage({ companyId: s.companyId, threadId: threadB.id, senderType: "agent", senderId: s.agentX.id, text: "@Ann pick one\n```choices\n- a\n- b\n```" });
    const sent = await db.select().from(notifications).where(eq(notifications.companyId, s.companyId));
    assert.equal(sent.length, 0, "nobody is notified about an orphaned private thread");

    // Leaving the company archives the member's private threads.
    await archivePrivateThreadsOf(s.companyId, s.userA);
    const [archived] = await db.select().from(messageThreads).where(eq(messageThreads.id, s.thread.id));
    assert.ok(archived.archivedAt, "a leaving member's private threads are archived");
});

maybe("delivery inspector: a message in someone else's private thread reads as missing", async () => {
    const s = await seedPrivateChat();
    const { loadMessageDelivery } = await import("@/lib/run-ledger-reads");
    assert.equal(await loadMessageDelivery(s.companyId, s.message.id, s.userB), null);
    assert.ok(await loadMessageDelivery(s.companyId, s.message.id, s.userA), "the owner still sees it");
});

maybe("display dm: private mode shows the creator's own thread, never the Operations one", async () => {
    const s = await seedPrivateChat();
    const { ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    // B is the screen's creator. A's thread with X must not be used; neither is
    // the Operations thread, even when B wrote there.
    const ops = await ensureDirectThread(s.companyId, s.agentX.id, null);
    await appendThreadMessage({ companyId: s.companyId, threadId: ops.id, senderType: "human", senderId: s.userB, targetAgentId: s.agentX.id, text: "ops note from B" });
    const own = await ensureDirectThread(s.companyId, s.agentX.id, s.userB);
    await appendThreadMessage({ companyId: s.companyId, threadId: own.id, senderType: "human", senderId: s.userB, targetAgentId: s.agentX.id, text: "B private" });

    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId: s.companyId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: "screen", scope: "read_only",
        createdByUserId: s.userB, includePrivateChats: true,
    });
    const { companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companyMembers).set({ role: "admin" }).where(eq(companyMembers.userId, s.userB));

    const live = await import("@/app/api/mcp/live/route");
    const res = await live.GET(makeRequest("http://localhost/api/mcp/live", { headers: auth(raw) }));
    assert.equal(res.status, 200);
    const body = JSON.stringify(await res.json());
    assert.ok(body.includes("B private"), "the creator's own private thread is the dm");
    assert.ok(!body.includes("ops note from B"), "not the Operations thread");
    assert.ok(!body.includes("secret plan"), "never another person's private thread");
});

maybe("webhook: private-thread decisions and runtime failures reach the company channel content-free", async () => {
    const s = await seedPrivateChat();
    process.env.EMPEROR_CLAW_MASTER_KEY ??= "test-master-key-for-webhooks";
    const db = await getDb();
    const { companyNotificationWebhooks, users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { encryptSecretPayload } = await import("@/lib/secrets");
    await db.insert(companyNotificationWebhooks).values({
        companyId: s.companyId, encryptedUrl: encryptSecretPayload({ url: "https://hooks.example.test/x" })!.encryptedSecret,
        urlHint: "hooks.example.test", format: "generic", kinds: ["decision", "agent_failed", "mention"],
    });
    await db.update(users).set({ displayName: "Ann" }).where(eq(users.id, s.userA));

    const posted: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
        posted.push(String(init?.body ?? ""));
        return new Response("ok", { status: 200 });
    }) as typeof fetch;
    try {
        const { appendThreadMessage } = await import("@/lib/control-plane");
        await appendThreadMessage({ companyId: s.companyId, threadId: s.thread.id, senderType: "agent", senderId: s.agentX.id, text: "@Ann the secret plan needs a call\n```choices\n- go\n- stop\n```" });
        const { notifyRuntimeFailure } = await import("@/lib/notifications");
        await notifyRuntimeFailure(s.companyId, s.message, s.agentX.id);
    } finally {
        globalThis.fetch = realFetch;
    }
    assert.equal(posted.length, 2, "both events still reach the channel");
    for (const body of posted) {
        assert.ok(!body.includes("secret plan"), `no message text: ${body}`);
        assert.ok(!body.includes(s.thread.id) && !body.includes(s.message.id), "no thread link or ids");
        assert.ok(body.includes("private chat"), "a generic, content-free title");
    }
});

maybe("inbound webhook: other tokens cannot write into a private thread, nor post as someone but its owner", async () => {
    const s = await seedPrivateChat();
    const inbound = await import("@/app/api/webhook/inbound/route");
    const post = (raw: string, from: string) => inbound.POST(makeRequest("http://localhost/api/webhook/inbound", {
        method: "POST", headers: auth(raw),
        body: { event: "message.created", message: { id: randomUUID(), chat_id: "c", thread_id: s.thread.id, from_user_id: from, text: "injected" } },
    }));
    assert.equal((await post(s.tokenY, s.userA)).status, 404, "another agent's token");
    assert.equal((await post(s.tokenUnbound, s.userA)).status, 404, "a company-wide token");
    assert.equal((await post(s.tokenX, s.userB)).status, 403, "spoofing someone other than the owner");
    assert.equal((await post(s.tokenX, s.userA)).status, 200, "the agent's own integration relaying its owner");
});

maybe("realtime: a message stored in a private thread never goes out under another thread's id", async () => {
    const s = await seedPrivateChat();
    const { Client } = await import("pg");
    const listener = new Client({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (msg) => { if (msg.payload) received.push(msg.payload); });
    await listener.query("LISTEN mcp_events");
    try {
        const inbound = await import("@/app/api/webhook/inbound/route");
        const res = await inbound.POST(makeRequest("http://localhost/api/webhook/inbound", {
            method: "POST", headers: auth(s.tokenX),
            body: { event: "message.created", message: { id: randomUUID(), chat_id: "c", thread_id: s.thread.id, from_user_id: s.userA, text: "relay" } },
        }));
        assert.equal(res.status, 200);
        // A payload whose fields disagree: the team thread plus a private message.
        const { broadcastMcpEvent } = await import("@/lib/pubsub");
        const { ensureTeamThread } = await import("@/lib/control-plane");
        await broadcastMcpEvent(s.companyId, { type: "thread_message", thread: await ensureTeamThread(s.companyId), message: s.message });
        for (let i = 0; i < 50 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        assert.equal(received.length, 2);
        const { parseRealtimeNotification, socketReceives } = await import("@/lib/realtime-delivery");
        for (const raw of received) {
            const event = parseRealtimeNotification(raw)!;
            assert.equal(socketReceives(event, { companyId: s.companyId, agentId: s.agentY.id }), false);
            assert.equal(socketReceives(event, { companyId: s.companyId, agentId: null }), false);
            assert.equal(socketReceives(event, { companyId: s.companyId, agentId: s.agentX.id }), true);
        }
    } finally {
        await listener.end();
    }
});

maybe("runs: the trigger message decides the thread, and other tokens cannot point a run or reply at it", async () => {
    const s = await seedPrivateChat();
    const runs = await import("@/app/api/mcp/agents/runs/route");
    const runEvents = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const runRoute = await import("@/app/api/mcp/agents/runs/[id]/route");

    // The events `run` header path runs the same checks as POST /agents/runs.
    const yRun = randomUUID();
    const header = await runEvents.POST(makeRequest(`http://localhost/api/mcp/agents/runs/${yRun}/events`, {
        method: "POST", headers: auth(s.tokenY),
        body: { run: { id: yRun, agentId: s.agentY.id, triggerMessageId: s.message.id }, events: [] },
    }), { params: Promise.resolve({ id: yRun }) });
    assert.equal(header.status, 404);

    // X's run names only its trigger: it is filed under the private thread.
    const xRun = randomUUID();
    const started = await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST", headers: auth(s.tokenX), body: { id: xRun, agentId: s.agentX.id, triggerMessageId: s.message.id, threadId: randomUUID() },
    }));
    assert.equal(started.status, 200);
    assert.equal(((await started.json()) as { run: { threadId: string } }).run.threadId, s.thread.id);

    // An unbound company token cannot append events to that private-thread run.
    const unboundEvents = await runEvents.POST(makeRequest(`http://localhost/api/mcp/agents/runs/${xRun}/events`, {
        method: "POST", headers: auth(s.tokenUnbound),
        body: { events: [{ id: randomUUID(), seq: 1, kind: "turn.started", ts: new Date().toISOString() }] },
    }), { params: Promise.resolve({ id: xRun }) });
    assert.equal(unboundEvents.status, 404);

    // Y finishing its own run cannot claim a reply in X's private thread.
    const ownRun = randomUUID();
    assert.equal((await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST", headers: auth(s.tokenY), body: { id: ownRun, agentId: s.agentY.id },
    }))).status, 200);
    const finish = await runRoute.PATCH(makeRequest(`http://localhost/api/mcp/agents/runs/${ownRun}`, {
        method: "PATCH", headers: auth(s.tokenY), body: { status: "succeeded", replyMessageId: s.message.id },
    }), { params: Promise.resolve({ id: ownRun }) });
    assert.equal(finish.status, 404);
});
