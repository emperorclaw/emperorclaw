import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

/**
 * Runtime controls in private direct-chat mode (0.9.3): a Replace in one person's own direct thread
 * cancels only that thread's queued work and asks the bridge for a thread-scoped replace; Kill and
 * Replace in the shared/Operations thread stay agent-wide; another person's private thread is
 * refused. Multi-chat P1: Kill in a person's own chat is thread-scoped too when the agent's runtime
 * advertises `thread-kill-v1`, and falls back to agent-wide without it.
 */
const maybe = dbAvailable ? test : test.skip;

async function seed(mode: "shared" | "private") {
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
    await db.update(companies).set({ directChatMode: mode }).where(eq(companies.id, companyId));
    const agent = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    return { companyId, userA, userB: b.id, agent };
}

/** Register a runtime for the agent (capabilities as /runtime/register stores them). */
async function registerRuntime(companyId: string, agentId: string, capabilities: string[]) {
    const { registerRuntimeNode } = await import("@/lib/control-plane");
    await registerRuntimeNode({ companyId, runtimeId: `rt-${randomUUID()}`, name: "Hermes on test", agentId, capabilitiesJson: capabilities });
}

const MODERN = ["hermes-agent", "thread-reply", "thread-kill-v1", "max-parallel-turns: 2"];

async function rows() {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    return db.select().from(threadMessages);
}

function stateOf(all: Awaited<ReturnType<typeof rows>>, id: string) {
    return all.find((m) => m.id === id)!.deliveryState;
}

function control(all: Awaited<ReturnType<typeof rows>>) {
    return all.filter((m) => (m.metadataJson as Record<string, unknown>)?.runtimeControl)
        .map((m) => ({ threadId: m.threadId, runtimeControl: (m.metadataJson as Record<string, unknown>).runtimeControl }));
}

maybe("private mode: Replace in my own thread cancels only my thread and is thread-scoped", async () => {
    const { companyId, userA, userB, agent } = await seed("private");
    const { requestAgentControl } = await import("@/lib/agent-control");
    const mine = await requestAgentControl(companyId, userA, agent.id, "queue", "my old work");
    const theirs = await requestAgentControl(companyId, userB, agent.id, "queue", "their work");
    assert.notEqual(mine.thread.id, theirs.thread.id);
    const replaced = await requestAgentControl(companyId, userA, agent.id, "replace", "my new direction");
    assert.equal(replaced.scope, "thread");
    const all = await rows();
    assert.equal(stateOf(all, mine.message!.id), "cancelled");
    assert.equal(stateOf(all, theirs.message!.id), "queued", "another person's queued work is untouched");
    assert.deepEqual(control(all), [{ threadId: mine.thread.id, runtimeControl: { action: "replace", scope: "thread" } }]);
});

maybe("private mode: without thread-kill-v1 Kill falls back to agent-wide", async () => {
    const { companyId, userA, userB, agent } = await seed("private");
    await registerRuntime(companyId, agent.id, ["hermes-agent", "thread-reply"]); // an older bridge
    const { requestAgentControl, chatRuntimeInfo } = await import("@/lib/agent-control");
    const theirs = await requestAgentControl(companyId, userB, agent.id, "queue", "their work");
    const killed = await requestAgentControl(companyId, userA, agent.id, "kill", "");
    assert.equal(killed.scope, "agent");
    const all = await rows();
    assert.equal(stateOf(all, theirs.message!.id), "cancelled");
    assert.deepEqual(control(all)[0].runtimeControl, { action: "kill" });
    assert.deepEqual(await chatRuntimeInfo(companyId, agent.id, killed.thread), { stopScope: "agent", maxParallelTurns: null },
        "the chat can say this Stop stops all of the agent's chats");
});

maybe("private mode: with thread-kill-v1 Kill stops only my chat, not my other chat or other people's", async () => {
    const { companyId, userA, userB, agent } = await seed("private");
    await registerRuntime(companyId, agent.id, MODERN);
    const { requestAgentControl, chatRuntimeInfo } = await import("@/lib/agent-control");
    const { createPrivateChat } = await import("@/lib/private-chats");
    const main = await requestAgentControl(companyId, userA, agent.id, "queue", "main chat work");
    const { thread: second } = await createPrivateChat({ companyId, userId: userA, agentId: agent.id, firstMessage: "side", clientKey: `k-${randomUUID()}` });
    const side = await requestAgentControl(companyId, userA, agent.id, "queue", "side chat work", second.id);
    const theirs = await requestAgentControl(companyId, userB, agent.id, "queue", "their work");
    assert.notEqual(main.thread.id, second.id);

    const killed = await requestAgentControl(companyId, userA, agent.id, "kill", "", second.id);
    assert.equal(killed.scope, "thread");
    const all = await rows();
    assert.equal(stateOf(all, side.message!.id), "cancelled");
    assert.equal(stateOf(all, main.message!.id), "queued", "my other chat keeps its queue");
    assert.equal(stateOf(all, theirs.message!.id), "queued", "another person's queue is untouched");
    assert.deepEqual(control(all), [{ threadId: second.id, runtimeControl: { action: "kill", scope: "thread" } }]);
    assert.deepEqual(await chatRuntimeInfo(companyId, agent.id, second), { stopScope: "thread", maxParallelTurns: 2 });
});

maybe("private mode: an explicit agent-wide Stop stays agent-wide even with thread-kill-v1", async () => {
    const { companyId, userA, userB, agent } = await seed("private");
    await registerRuntime(companyId, agent.id, MODERN);
    const { requestAgentControl } = await import("@/lib/agent-control");
    const theirs = await requestAgentControl(companyId, userB, agent.id, "queue", "their work");
    const killed = await requestAgentControl(companyId, userA, agent.id, "kill", "", null, { agentWide: true });
    assert.equal(killed.scope, "agent");
    const all = await rows();
    assert.equal(stateOf(all, theirs.message!.id), "cancelled");
    assert.deepEqual(control(all)[0].runtimeControl, { action: "kill" });
});

maybe("shared mode: Kill stays agent-wide even with thread-kill-v1", async () => {
    const { companyId, userA, userB, agent } = await seed("shared");
    await registerRuntime(companyId, agent.id, MODERN);
    const { requestAgentControl, chatRuntimeInfo } = await import("@/lib/agent-control");
    const theirs = await requestAgentControl(companyId, userB, agent.id, "queue", "their work");
    const killed = await requestAgentControl(companyId, userA, agent.id, "kill", "");
    assert.equal(killed.scope, "agent");
    assert.equal(stateOf(await rows(), theirs.message!.id), "cancelled");
    assert.deepEqual(await chatRuntimeInfo(companyId, agent.id, killed.thread), { stopScope: "agent", maxParallelTurns: 2 });
});

maybe("shared mode: Replace keeps today's agent-wide behaviour", async () => {
    const { companyId, userA, userB, agent } = await seed("shared");
    const { requestAgentControl } = await import("@/lib/agent-control");
    const theirs = await requestAgentControl(companyId, userB, agent.id, "queue", "their work");
    const replaced = await requestAgentControl(companyId, userA, agent.id, "replace", "new direction");
    assert.equal(replaced.scope, "agent");
    const all = await rows();
    assert.equal(stateOf(all, theirs.message!.id), "cancelled");
    assert.deepEqual(control(all)[0].runtimeControl, { action: "replace" });
});

maybe("private mode: the Operations thread is honoured and stays agent-wide; someone else's thread is refused", async () => {
    const { companyId, userA, userB, agent } = await seed("private");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const { requestAgentControl, DirectThreadNotAllowedError } = await import("@/lib/agent-control");
    const operations = await ensureDirectThread(companyId, agent.id, null);
    const theirs = await requestAgentControl(companyId, userB, agent.id, "queue", "their work");

    const ops = await requestAgentControl(companyId, userA, agent.id, "replace", "ops direction", operations.id);
    assert.equal(ops.thread.id, operations.id, "the command lands in the Operations thread");
    assert.equal(ops.scope, "agent", "Replace in the shared Operations thread stays agent-wide");
    await assert.rejects(requestAgentControl(companyId, userA, agent.id, "replace", "hijack", theirs.thread.id),
        DirectThreadNotAllowedError);
    const all = await rows();
    assert.ok(!all.some((m) => m.threadId === theirs.thread.id && m.text === "hijack"), "nothing written to B's thread");
});
