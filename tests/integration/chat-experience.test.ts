import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;
const originalFlag = process.env.EMPEROR_CHAT_STREAMING;
before(() => { process.env.EMPEROR_CHAT_STREAMING = "1"; });
after(() => { actAs(null); if (originalFlag === undefined) delete process.env.EMPEROR_CHAT_STREAMING; else process.env.EMPEROR_CHAT_STREAMING = originalFlag; });

async function fixture() {
    await resetDb();
    const db = await getDb(); const schema = await getSchema();
    const company = await seedCompanyWithToken();
    const owner = await seedHuman(company.companyId, "owner");
    const agent = await seedAgent(company.companyId);
    const [thread] = await db.insert(schema.messageThreads).values({ companyId: company.companyId, type: "direct", directAgentId: agent.id,
        isPrivate: true, ownerUserId: owner.userId, createdByType: "human", createdById: owner.userId }).returning();
    await db.insert(schema.threadParticipants).values({ companyId: company.companyId, threadId: thread.id, participantType: "human", participantRef: owner.userId });
    const [run] = await db.insert(schema.agentRuns).values({ id: randomUUID(), companyId: company.companyId, agentId: agent.id, threadId: thread.id }).returning();
    actAs(owner);
    const body = { responseId: randomUUID(), segmentIndex: 0, revision: 1, text: "A private partial answer", state: "streaming" };
    const post = async (value = body, token = company.rawToken, agentId = agent.id) => {
        const { POST } = await import("@/app/api/mcp/agents/runs/[id]/responses/route");
        return POST(makeRequest(`http://localhost/api/mcp/agents/runs/${run.id}/responses?agentId=${agentId}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: value }), { params: Promise.resolve({ id: run.id }) });
    };
    return { db, schema, company, owner, agent, thread, run, body, post };
}

maybe("private previews are monotonic, bounded and readable only through the authorized chat", async () => {
    const f = await fixture();
    assert.equal((await f.post()).status, 200);
    await f.post({ ...f.body, revision: 3, text: "Newest" });
    await f.post({ ...f.body, revision: 2, text: "Stale" });
    const { GET } = await import("@/app/api/chat/route");
    const read = () => GET(makeRequest(`http://localhost/api/chat?targetAgentId=${f.agent.id}&directThreadId=${f.thread.id}&previews=1`));
    let response = await read(); assert.equal(response.status, 200);
    assert.equal((await response.json()).previews[0].text, "Newest");
    const outsider = await seedHuman(f.company.companyId, "admin"); actAs(outsider);
    response = await read(); assert.equal(response.status, 404);
    const other = await seedCompanyWithToken();
    assert.equal((await f.post(f.body, other.rawToken)).status, 404);
    const otherAgent = await seedAgent(f.company.companyId, { name: "Other" });
    assert.equal((await f.post(f.body, f.company.rawToken, otherAgent.id)).status, 404);
    assert.equal((await f.post({ ...f.body, text: "🦊".repeat(40_000) })).status, 400);
});

maybe("terminal revisions cannot restart a preview and completed durable replies stop ingestion", async () => {
    const f = await fixture();
    await f.post({ ...f.body, revision: 2, state: "completed" });
    await f.post({ ...f.body, revision: 3 });
    let [row] = await f.db.select().from(f.schema.chatResponsePreviews);
    assert.equal(row.state, "completed"); assert.equal(row.revision, 2);
    await f.db.update(f.schema.agentRuns).set({ status: "succeeded" }).where(eq(f.schema.agentRuns.id, f.run.id));
    const response = await f.post({ ...f.body, revision: 4 });
    assert.equal((await response.json()).terminal, true);
    await f.db.update(f.schema.chatResponsePreviews).set({ expiresAt: new Date(0) }).where(eq(f.schema.chatResponsePreviews.responseId, f.body.responseId));
    const { readResponsePreviews } = await import("@/lib/chat/responses");
    assert.deepEqual(await readResponsePreviews(f.company.companyId, f.thread.id), []);
});

maybe("concurrent human sends with the same client id store one message, conflicting retries fail", async () => {
    const f = await fixture();
    const { POST } = await import("@/app/api/chat/route");
    const clientMessageId = randomUUID();
    const send = (text: string) => POST(makeRequest("http://localhost/api/chat", { method: "POST", body: { clientMessageId, text,
        targetAgentId: f.agent.id, directThreadId: f.thread.id } }));
    const responses = await Promise.all([send("hello"), send("hello")]);
    assert.ok(responses.every(response => response.status === 200));
    const ids = await Promise.all(responses.map(async response => (await response.json()).message.id));
    assert.equal(ids[0], ids[1]);
    const [{ count }] = await f.db.select({ count: sql<number>`count(*)::int` }).from(f.schema.threadMessages).where(and(eq(f.schema.threadMessages.threadId, f.thread.id), eq(f.schema.threadMessages.senderType, "human")));
    assert.equal(count, 1);
    assert.equal((await send("different text")).status, 409);
});

maybe("streaming kill switch closes preview writes and reads without changing the durable chat path", async () => {
    const f = await fixture();
    await f.post();
    process.env.EMPEROR_CHAT_STREAMING = "0";
    try {
        assert.equal((await f.post()).status, 404);
        const { GET } = await import("@/app/api/chat/route");
        const response = await GET(makeRequest(`http://localhost/api/chat?targetAgentId=${f.agent.id}&directThreadId=${f.thread.id}&previews=1`));
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.streaming, false); assert.deepEqual(body.previews, []);
    } finally { process.env.EMPEROR_CHAT_STREAMING = "1"; }
});
