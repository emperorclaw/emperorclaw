import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, seedHuman } from "./_access-helper";

/**
 * Multi-chat P1 (docs/design/multi-chat-per-agent.md §7): the runtime's real parallel-turn limit and
 * thread-kill support travel from /runtime/register to the chat (GET /api/chat `runtime`), and the
 * message sync never hands a runtime the open messages of an archived chat.
 */
const maybe = dbAvailable ? test : test.skip;

async function seed() {
    await resetDb();
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId, rawToken } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    const agent = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    return { companyId, rawToken, owner, agent };
}

async function register(rawToken: string, agentId: string, capabilitiesJson: string[]) {
    const { POST } = await import("@/app/api/mcp/runtime/register/route");
    const res = await call(POST, "/api/mcp/runtime/register", {
        method: "POST", headers: bearer(rawToken),
        body: { runtimeId: `rt-${randomUUID()}`, name: "Hermes on test", agentId, capabilitiesJson },
    });
    assert.equal(res.status, 200, res.text);
}

async function syncedIds(rawToken: string, agentId: string) {
    const { GET } = await import("@/app/api/mcp/messages/sync/route");
    const res = await call(GET, `/api/mcp/messages/sync?agentId=${agentId}&since=${encodeURIComponent(new Date(0).toISOString())}`,
        { headers: bearer(rawToken) });
    assert.equal(res.status, 200, res.text);
    return ((res.json.messages ?? []) as { id: string }[]).map((m) => m.id);
}

maybe("GET /api/chat tells the chat what Stop does and the runtime's real parallel limit", async () => {
    const { rawToken, owner, agent } = await seed();
    const { GET } = await import("@/app/api/chat/route");
    actAs(owner);
    const unknown = await call(GET, `/api/chat?targetAgentId=${agent.id}`);
    assert.equal(unknown.status, 200, unknown.text);
    assert.deepEqual(unknown.json.runtime, { stopScope: "agent", maxParallelTurns: null, canStopAll: true }, "no runtime yet: agent-wide, limit unknown");

    await register(rawToken, agent.id, ["hermes-agent", "thread-kill-v1", "max-parallel-turns: 3"]);
    actAs(owner);
    const modern = await call(GET, `/api/chat?targetAgentId=${agent.id}`);
    assert.deepEqual(modern.json.runtime, { stopScope: "thread", maxParallelTurns: 3, canStopAll: true });

    const { GET: team } = await import("@/app/api/chat/route");
    actAs(owner);
    const channel = await call(team, "/api/chat");
    assert.equal(channel.json.runtime, undefined, "only direct chats carry runtime info");
});

maybe("the control route accepts scope: agent and refuses any other scope", async () => {
    const { owner, agent } = await seed();
    const { POST } = await import("@/app/api/agents/[id]/control/route");
    actAs(owner);
    const bad = await call(POST, `/api/agents/${agent.id}/control`, { method: "POST", body: { action: "kill", scope: "thread" }, params: { id: agent.id } });
    assert.equal(bad.status, 400);
    actAs(owner);
    const wide = await call(POST, `/api/agents/${agent.id}/control`, { method: "POST", body: { action: "kill", scope: "agent" }, params: { id: agent.id } });
    assert.equal(wide.status, 200, wide.text);
    assert.equal(wide.json.scope, "agent");
});

maybe("message sync skips the open messages of an archived chat and keeps live chats unchanged", async () => {
    const { companyId, rawToken, owner, agent } = await seed();
    const { POST } = await import("@/app/api/chat/route");
    actAs(owner);
    const main = await call(POST, "/api/chat", { method: "POST", body: { text: "main question", targetAgentId: agent.id } });
    assert.equal(main.status, 200, main.text);
    actAs(owner);
    const side = await call(POST, "/api/chat", { method: "POST", body: { text: "side question", targetAgentId: agent.id, newChat: { clientKey: `key-${randomUUID()}` } } });
    assert.equal(side.status, 200, side.text);
    const mainId = (main.json.message as { id: string }).id;
    const sideId = (side.json.message as { id: string }).id;
    const sideThreadId = (side.json.thread as { id: string }).id;

    const before = await syncedIds(rawToken, agent.id);
    assert.ok(before.includes(mainId) && before.includes(sideId), "both live chats are delivered");

    const { updatePrivateChat } = await import("@/lib/private-chats");
    await updatePrivateChat(companyId, owner.userId, sideThreadId, { archived: true });
    const after = await syncedIds(rawToken, agent.id);
    assert.ok(after.includes(mainId), "the live chat is still delivered");
    assert.ok(!after.includes(sideId), "the archived chat's queued message is not delivered");
});

/* ---------- P2: who may stop the agent in every chat ---------- */

maybe("scope: agent is for owners, admins and the agent's own owner; other members get 403", async () => {
    const { companyId, owner, agent } = await seed();
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const agentOwner = await seedHuman(companyId, "member");
    const { POST } = await import("@/app/api/agents/[id]/control/route");
    const stopAll = (person: { userId: string; sessionId: string }) => {
        actAs(person);
        return call(POST, `/api/agents/${agent.id}/control`, { method: "POST", body: { action: "kill", scope: "agent" }, params: { id: agent.id } });
    };

    const refused = await stopAll(member);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.json.code, "agent_scope_forbidden");
    actAs(member);
    const ownChat = await call(POST, `/api/agents/${agent.id}/control`, { method: "POST", body: { action: "kill" }, params: { id: agent.id } });
    assert.equal(ownChat.status, 200, "a member still stops their own chat");

    assert.equal((await stopAll(admin)).status, 200);
    assert.equal((await stopAll(owner)).status, 200);

    assert.equal((await stopAll(agentOwner)).status, 403, "not yet the agent's owner");
    await db.update(agents).set({ ownerUserId: agentOwner.userId }).where(eq(agents.id, agent.id));
    const asAgentOwner = await stopAll(agentOwner);
    assert.equal(asAgentOwner.status, 200, asAgentOwner.text);
    assert.equal(asAgentOwner.json.scope, "agent");

    const { GET } = await import("@/app/api/chat/route");
    actAs(member);
    const memberView = await call(GET, `/api/chat?targetAgentId=${agent.id}`);
    assert.equal(memberView.json.runtime.canStopAll, false, "the chat hides Stop all chats for a plain member");
});

/* ---------- P2: archiving a chat stops its work ---------- */

async function chatsWithWork(s: Awaited<ReturnType<typeof seed>>) {
    const { POST } = await import("@/app/api/chat/route");
    actAs(s.owner);
    const main = await call(POST, "/api/chat", { method: "POST", body: { text: "main question", targetAgentId: s.agent.id } });
    actAs(s.owner);
    const side = await call(POST, "/api/chat", { method: "POST", body: { text: "side question", targetAgentId: s.agent.id, newChat: { clientKey: `key-${randomUUID()}` } } });
    assert.equal(side.status, 200, side.text);
    actAs(s.owner);
    const followUp = await call(POST, "/api/chat", { method: "POST", body: { text: "and another", targetAgentId: s.agent.id, directThreadId: side.json.thread.id } });
    assert.equal(followUp.status, 200, followUp.text);
    return {
        mainMessageId: main.json.message.id as string,
        sideThreadId: side.json.thread.id as string,
        sideFirstId: side.json.message.id as string,
        sideSecondId: followUp.json.message.id as string,
    };
}

async function messagesIn(threadId: string) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    return db.select().from(threadMessages).where(eq(threadMessages.threadId, threadId));
}

maybe("archiving a busy chat cancels its open prompts and sends a thread-scoped Stop the runtime receives", async () => {
    const s = await seed();
    await register(s.rawToken, s.agent.id, ["hermes-agent", "thread-kill-v1", "max-parallel-turns: 3"]);
    const work = await chatsWithWork(s);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    // The agent picked up the first prompt of the side chat.
    await db.update(threadMessages).set({ deliveryState: "acting" }).where(eq(threadMessages.id, work.sideFirstId));

    const { updatePrivateChat } = await import("@/lib/private-chats");
    await updatePrivateChat(s.companyId, s.owner.userId, work.sideThreadId, { archived: true });

    const side = await messagesIn(work.sideThreadId);
    assert.equal(side.find((m) => m.id === work.sideFirstId)!.deliveryState, "cancelled");
    assert.equal(side.find((m) => m.id === work.sideSecondId)!.deliveryState, "cancelled");
    const kills = side.filter((m) => (m.metadataJson as Record<string, unknown>)?.runtimeControl);
    assert.equal(kills.length, 1);
    assert.deepEqual((kills[0].metadataJson as Record<string, unknown>).runtimeControl, { action: "kill", scope: "thread" });

    const all = await db.select().from(threadMessages);
    assert.equal(all.find((m) => m.id === work.mainMessageId)!.deliveryState, "queued", "the main chat's work is untouched");
    assert.equal(all.filter((m) => m.threadId !== work.sideThreadId && (m.metadataJson as Record<string, unknown>)?.runtimeControl).length, 0);

    const { GET: controls } = await import("@/app/api/mcp/agents/control/route");
    const polled = await call(controls, `/api/mcp/agents/control?agentId=${s.agent.id}`, { headers: bearer(s.rawToken) });
    assert.equal(polled.status, 200, polled.text);
    assert.deepEqual((polled.json.commands as { id: string }[]).map((c) => c.id), [kills[0].id], "the archived chat's Stop reaches the runtime");
    assert.ok(!(await syncedIds(s.rawToken, s.agent.id)).includes(work.sideSecondId), "its cancelled prompts do not");
});

maybe("archiving: an idle chat only loses its queue, and an older runtime gets no agent-wide Stop", async () => {
    const idle = await seed();
    await register(idle.rawToken, idle.agent.id, ["hermes-agent", "thread-kill-v1"]);
    const idleWork = await chatsWithWork(idle);
    const { updatePrivateChat } = await import("@/lib/private-chats");
    await updatePrivateChat(idle.companyId, idle.owner.userId, idleWork.sideThreadId, { archived: true });
    const idleSide = await messagesIn(idleWork.sideThreadId);
    assert.ok(idleSide.filter((m) => m.senderType === "human").every((m) => m.deliveryState === "cancelled"));
    assert.equal(idleSide.filter((m) => (m.metadataJson as Record<string, unknown>)?.runtimeControl).length, 0, "nothing running: no Stop");

    const old = await seed();
    await register(old.rawToken, old.agent.id, ["hermes-agent"]); // no thread-kill-v1
    const oldWork = await chatsWithWork(old);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(threadMessages).set({ deliveryState: "acting" }).where(eq(threadMessages.id, oldWork.sideFirstId));
    await updatePrivateChat(old.companyId, old.owner.userId, oldWork.sideThreadId, { archived: true });
    const all = await db.select().from(threadMessages);
    assert.equal(all.filter((m) => (m.metadataJson as Record<string, unknown>)?.runtimeControl).length, 0, "never an agent-wide Stop");
    assert.equal(all.find((m) => m.id === oldWork.sideFirstId)!.deliveryState, "cancelled");
    assert.equal(all.find((m) => m.id === oldWork.mainMessageId)!.deliveryState, "queued");
});

/* ---------- A pending Stop in one chat never swallows another chat's reply ---------- */

maybe("a pending thread-scoped Stop in chat A drops A's reply only; chat B's reply is delivered", async () => {
    const s = await seed();
    await register(s.rawToken, s.agent.id, ["hermes-agent", "thread-kill-v1", "max-parallel-turns: 3"]);
    const { POST } = await import("@/app/api/chat/route");
    actAs(s.owner);
    const inB = await call(POST, "/api/chat", { method: "POST", body: { text: "question in main", targetAgentId: s.agent.id } });
    assert.equal(inB.status, 200, inB.text);
    actAs(s.owner);
    const chatA = await call(POST, "/api/chat", { method: "POST", body: { text: "side question", targetAgentId: s.agent.id, newChat: { clientKey: `key-${randomUUID()}` } } });
    assert.equal(chatA.status, 200, chatA.text);
    const threadA = chatA.json.thread.id as string;

    const { requestAgentControl } = await import("@/lib/agent-control");
    const stop = await requestAgentControl(s.companyId, s.owner.userId, s.agent.id, "kill", "", threadA);
    assert.equal(stop.scope, "thread");
    // A prompt that arrived in A after the Stop (still queued, not cancelled).
    actAs(s.owner);
    const laterInA = await call(POST, "/api/chat", { method: "POST", body: { text: "after the stop", targetAgentId: s.agent.id, directThreadId: threadA } });
    assert.equal(laterInA.status, 200, laterInA.text);

    const { POST: send } = await import("@/app/api/mcp/messages/send/route");
    const reply = (threadId: string, replyToMessageId: string, text: string) => call(send, "/api/mcp/messages/send", {
        method: "POST", headers: { ...bearer(s.rawToken), "idempotency-key": randomUUID() },
        body: { agentId: s.agent.id, thread_id: threadId, thread_type: "direct", replyToMessageId, text },
    });

    const inMain = await reply(inB.json.thread.id, inB.json.message.id, "answer in main");
    assert.equal(inMain.status, 200, inMain.text);
    assert.ok(inMain.json.message_id, "the other chat's reply is stored");
    assert.notEqual(inMain.json.cancelled, true);

    const inA = await reply(threadA, laterInA.json.message.id, "answer in A");
    assert.equal(inA.status, 200, inA.text);
    assert.equal(inA.json.cancelled, true, "the stopped chat's reply is dropped while its Stop is pending");
    assert.equal(inA.json.message_id, null);
});
