import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken, makeRequest } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

maybe("kill and replace cancel only the selected agent; acknowledgements and late replies respect cancellation", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { provider: "hermes" });
    const sibling = await seedAgent(companyId, { name: "Sibling", provider: "hermes" });
    const { requestAgentControl } = await import("@/lib/agent-control");
    const { updateThreadExecutionState, appendThreadMessage } = await import("@/lib/control-plane");
    const db = await getDb();
    const { threadMessages, companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    // Bind the runtime token: it may never consume a sibling's controls.
    await db.update(companyTokens).set({ agentId: agent.id }).where(eq(companyTokens.companyId, companyId));
    const first = await requestAgentControl(companyId, userId, agent.id, "queue", "first prompt");
    const second = await requestAgentControl(companyId, userId, agent.id, "queue", "follow-up");
    const other = await requestAgentControl(companyId, userId, sibling.id, "queue", "sibling work");
    await updateThreadExecutionState({ companyId, threadId: first.thread.id, actorType: "agent", actorId: agent.id, targetState: "acting", messageId: first.message!.id });
    const replacement = await requestAgentControl(companyId, userId, agent.id, "replace", "new direction");
    const rows = await db.select().from(threadMessages);
    assert.equal(rows.find(m => m.id === first.message!.id)!.deliveryState, "cancelled");
    assert.equal(rows.find(m => m.id === second.message!.id)!.deliveryState, "cancelled");
    assert.equal(rows.find(m => m.id === other.message!.id)!.deliveryState, "queued");
    assert.equal(rows.find(m => m.id === replacement.message!.id)!.deliveryState, "queued");
    // A stale status write must not resurrect cancelled prompts.
    await updateThreadExecutionState({ companyId, threadId: first.thread.id, actorType: "agent", actorId: agent.id, targetState: "acting", messageId: first.message!.id });
    const [cancelled] = await db.select().from(threadMessages).where(eq(threadMessages.id, first.message!.id));
    assert.equal(cancelled.deliveryState, "cancelled");
    const control = await import("@/app/api/mcp/agents/control/route");
    const headers = { authorization: `Bearer ${rawToken}` };
    const polled = await control.GET(makeRequest(`http://localhost/api/mcp/agents/control?agentId=${agent.id}&messageId=${first.message!.id}`, { headers }));
    const payload = await polled.json();
    assert.equal(payload.cancelled, true);
    assert.equal(payload.commands.length, 1);
    const denied = await control.GET(makeRequest(`http://localhost/api/mcp/agents/control?agentId=${sibling.id}`, { headers }));
    assert.equal(denied.status, 403);
    const ack = await control.POST(makeRequest(`http://localhost/api/mcp/agents/control?agentId=${agent.id}`, {
        method: "POST", headers, body: { commandId: payload.commands[0].id },
    }));
    assert.equal(ack.status, 200);
    const empty = await control.GET(makeRequest(`http://localhost/api/mcp/agents/control?agentId=${agent.id}`, { headers }));
    assert.deepEqual((await empty.json()).commands, []);
    const send = await import("@/app/api/mcp/messages/send/route");
    const late = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: { ...headers, "idempotency-key": randomUUID() }, body: {
        agentId: agent.id, thread_id: first.thread.id, replyToMessageId: first.message!.id, text: "stale result",
    } }));
    assert.equal(late.status, 200);
    assert.equal((await late.json()).cancelled, true);
    // A newer reply must not swallow the still-queued replacement.
    await appendThreadMessage({ companyId, threadId: first.thread.id, senderType: "agent", senderId: agent.id, text: "unrelated update" });
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const synced = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?agentId=${agent.id}&since=${encodeURIComponent(new Date(Date.now() + 60000).toISOString())}`, { headers }));
    const inbox = (await synced.json()).messages;
    assert.ok(inbox.some((m: { id: string }) => m.id === replacement.message!.id), "durable queue survives cursor and newer reply");
    assert.ok(!inbox.some((m: { id: string }) => m.id === first.message!.id), "cancelled prompt is not delivered");
    assert.ok(!inbox.some((m: { metadataJson: Record<string, unknown> }) => m.metadataJson.runtimeControl), "commands never become LLM prompts");
    const allowed = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: { ...headers, "idempotency-key": randomUUID() }, body: {
        agentId: agent.id, thread_id: replacement.thread.id, thread_type: "direct", replyToMessageId: replacement.message!.id, text: "new direction completed",
    } }));
    assert.equal(allowed.status, 200);
    assert.ok((await allowed.json()).message_id, "a valid current reply must still be stored without lock contention");
    await requestAgentControl(companyId, userId, agent.id, "kill", "");
    const [last] = await db.select().from(threadMessages).where(eq(threadMessages.id, replacement.message!.id));
    assert.equal(last.deliveryState, "cancelled");
});
