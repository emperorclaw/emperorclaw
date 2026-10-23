import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

/**
 * GET /api/mcp/messages/sync paging (bridge 0.9 review M7): oldest page first after the cursor,
 * `hasMore` + `nextSince`, and a page that is entirely already-answered must not stall the
 * runtime (it used to hold 25 s and return [] with the cursor stuck, so rows 101+ never came).
 */
const maybe = dbAvailable ? test : test.skip;

async function tokenForAgent(companyId: string, agentId: string): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, agentId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: `agent-${agentId}`, scope: "mcp_full",
    });
    return raw;
}

async function sync(token: string, agentId: string, since: string) {
    const route = await import("@/app/api/mcp/messages/sync/route");
    const started = Date.now();
    const res = await route.GET(makeRequest(
        `http://localhost/api/mcp/messages/sync?mode=all&agentId=${agentId}&since=${encodeURIComponent(since)}`,
        { headers: { authorization: `Bearer ${token}` } },
    ));
    assert.equal(res.status, 200);
    const json = await res.json();
    return { ...json, elapsedMs: Date.now() - started } as {
        messages: Array<{ id: string; text: string }>; hasMore?: boolean; nextSince?: string | null; elapsedMs: number;
    };
}

async function seedDirectHistory(answered: number, open: number) {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Pager", provider: "hermes" });
    const token = await tokenForAgent(companyId, agent.id);
    const { ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, agent.id);
    const base = Date.parse("2026-10-22T10:00:00.000Z");
    const ids: string[] = [];
    for (let i = 0; i < answered + open; i++) {
        const m = await appendThreadMessage({
            companyId, threadId: thread.id, senderType: "human", text: `m${i}`, createdAt: new Date(base + 1000 * (i + 1)),
            deliveryState: i < answered ? "resolved" : "queued",
        });
        ids.push(m.id);
    }
    // The agent answered everything up to the last "answered" message (replyToMessageId cutoff).
    await appendThreadMessage({
        companyId, threadId: thread.id, senderType: "agent", senderId: agent.id, text: "done",
        metadataJson: { replyToMessageId: ids[answered - 1] }, createdAt: new Date(base + 1000 * (answered + open + 5)),
        deliveryState: "resolved",
    });
    return { agent, token, ids, since: new Date(base).toISOString() };
}

maybe("an answered first page returns at once with hasMore and a cursor, then the open rows arrive", async () => {
    const { agent, token, ids, since } = await seedDirectHistory(105, 2);
    const first = await sync(token, agent.id, since);
    assert.deepEqual(first.messages, [], "every row on the first page was already answered");
    assert.equal(first.hasMore, true);
    assert.ok(first.nextSince && first.nextSince > since, "the cursor moves to the end of the page");
    assert.ok(first.elapsedMs < 5_000, `answered page must not hold the long poll (${first.elapsedMs} ms)`);

    const second = await sync(token, agent.id, first.nextSince!);
    const got = second.messages.map((m) => m.id);
    assert.ok(got.includes(ids[105]) && got.includes(ids[106]), "rows 106-107 are delivered on the next page");
    assert.equal(second.hasMore, false);
});

maybe("pages are oldest first and flagged hasMore", async () => {
    const { agent, token, ids, since } = await seedDirectHistory(1, 150);
    const page = await sync(token, agent.id, since);
    assert.equal(page.hasMore, true);
    assert.equal(page.messages[0].id, ids[1], "oldest open message first");
    assert.ok(!page.messages.some((m) => m.id === ids[150]), "the newest waits for the next page");
});
