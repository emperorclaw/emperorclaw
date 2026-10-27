/**
 * "Retry message" on a failed delivery (POST /api/chat/messages/:id): a
 * message the runtime gave up on is stored cancelled + runtimeFailure, which
 * is what the inbox shows as "Message failed". Only its sender may retry it;
 * the retry re-queues it fresh and addresses it so the agent's sync returns it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function fixture() {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { companyId } = await seedCompanyWithToken();
    const sender = await seedHuman(companyId, "member");
    const other = await seedHuman(companyId, "member");
    const ada = await seedAgent(companyId, { name: "Ada", lastSeenAt: new Date() });
    const [chat] = await db.insert(s.messageThreads).values({
        companyId, type: "direct", title: "Direct Agent Thread", directAgentId: ada.id, ownerUserId: sender.userId, isPrivate: true,
    }).returning();
    const failure = { agentId: ada.id, at: new Date().toISOString(), attempts: 3, reason: "Error code: 429 - rate limited" };
    const insert = async (values: Record<string, unknown>) => {
        const [row] = await db.insert(s.threadMessages).values({
            companyId, threadId: chat.id, senderType: "human", senderId: sender.userId, text: "Draft the launch post", ...values,
        } as typeof s.threadMessages.$inferInsert).returning();
        return row;
    };
    return { db, s, companyId, sender, other, ada, chat, failure, insert };
}

async function retry(id: string) {
    const route = await import("@/app/api/chat/messages/[id]/route");
    return call(route.POST, `/api/chat/messages/${id}`, { method: "POST", params: { id } });
}

maybe("the sender retries a failed message: queued again, failure cleared", async () => {
    const f = await fixture();
    const failed = await f.insert({
        targetAgentId: f.ada.id, deliveryState: "cancelled",
        metadataJson: { runtimeFailure: f.failure, failedAttempts: 3, lastFailedAt: f.failure.at, keep: "me" },
    });

    actAs(f.sender);
    const res = await retry(failed.id);
    assert.equal(res.status, 200, res.text);

    const { eq } = await import("drizzle-orm");
    const [row] = await f.db.select().from(f.s.threadMessages).where(eq(f.s.threadMessages.id, failed.id));
    assert.equal(row.deliveryState, "queued");
    assert.equal(row.targetAgentId, f.ada.id);
    const metadata = row.metadataJson as Record<string, unknown>;
    assert.equal(metadata.runtimeFailure, undefined, "runtimeFailure must be cleared");
    assert.equal(metadata.failedAttempts, undefined);
    assert.equal(metadata.lastFailedAt, undefined);
    assert.equal(metadata.keep, "me", "other metadata is kept");

    // The inbox no longer lists it as failed.
    const { buildAttention } = await import("@/lib/attention");
    const inbox = await buildAttention(f.companyId, { userId: f.sender.userId, isOwnerOrAdmin: false, canAct: true, scope: null });
    assert.equal(inbox.entries.some((e) => e.id === `message:${failed.id}` && e.failure), false);
    actAs(null);
});

maybe("only the sender may retry, and only a stopped or failed message", async () => {
    const f = await fixture();
    const failed = await f.insert({ targetAgentId: f.ada.id, deliveryState: "cancelled", metadataJson: { runtimeFailure: f.failure } });
    const delivered = await f.insert({ targetAgentId: f.ada.id, deliveryState: "resolved", metadataJson: {} });
    const running = await f.insert({ targetAgentId: f.ada.id, deliveryState: "acting", metadataJson: {} });

    actAs(f.other);
    const stranger = await retry(failed.id);
    assert.equal(stranger.status, 409, "another member retried someone else's message");

    actAs(f.sender);
    assert.equal((await retry(delivered.id)).status, 409, "a delivered message was re-queued");
    assert.equal((await retry(running.id)).status, 409, "a running message was re-queued");

    const { eq } = await import("drizzle-orm");
    const [still] = await f.db.select().from(f.s.threadMessages).where(eq(f.s.threadMessages.id, failed.id));
    assert.equal(still.deliveryState, "cancelled", "a refused retry must not change the message");
    assert.ok((still.metadataJson as Record<string, unknown>).runtimeFailure);
    const [resolved] = await f.db.select().from(f.s.threadMessages).where(eq(f.s.threadMessages.id, delivered.id));
    assert.equal(resolved.deliveryState, "resolved");
    actAs(null);
});

maybe("a failed @mention in a shared room is addressed to the agent that failed it", async () => {
    const f = await fixture();
    const [room] = await f.db.insert(f.s.messageThreads).values({ companyId: f.companyId, type: "group", title: "Launch" }).returning();
    const [mention] = await f.db.insert(f.s.threadMessages).values({
        companyId: f.companyId, threadId: room.id, senderType: "human", senderId: f.sender.userId, text: "@Ada draft it",
        deliveryState: "cancelled", metadataJson: { runtimeFailure: f.failure },
    }).returning();

    actAs(f.sender);
    const res = await retry(mention.id);
    assert.equal(res.status, 200, res.text);
    const message = res.json.message as { deliveryState: string; targetAgentId: string | null };
    assert.equal(message.deliveryState, "queued");
    assert.equal(message.targetAgentId, f.ada.id, "the sync only re-returns open messages targeted at the agent");
    actAs(null);
});
