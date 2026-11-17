import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { eq } from "drizzle-orm";

(dbAvailable ? test : test.skip)("private replies stay anchored to their source and reject conflicting or missing sources", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId);
    const { ensureDirectThread, ensureTeamThread, appendThreadMessage } = await import("@/lib/control-plane");
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    const direct = await ensureDirectThread(companyId, agent.id, userId);
    const team = await ensureTeamThread(companyId);
    const source = await appendThreadMessage({ companyId, threadId: direct.id, senderType: "human", senderId: userId, targetAgentId: agent.id, text: "Private request" });
    const base = { companyId, agentId: agent.id, callerAgentId: agent.id, text: "Private reply", replyToMessageId: source.id };
    await assert.rejects(sendThreadMessageFromMcp({ ...base, replyToMessageId: undefined }), /Choose threadId/);
    const sent = await sendThreadMessageFromMcp(base);
    assert.equal(sent.threadId, direct.id);
    await assert.rejects(sendThreadMessageFromMcp({ ...base, threadId: team.id }), /must stay in the thread/);
    await assert.rejects(sendThreadMessageFromMcp({ ...base, replyToMessageId: randomUUID() }), /Thread not found/);
    await assert.rejects(sendThreadMessageFromMcp({ ...base, threadId: "not-a-thread" }), /Invalid threadId/);
    const db = await getDb(), { threadMessages } = await getSchema();
    const teamMessages = await db.select().from(threadMessages).where(eq(threadMessages.threadId, team.id));
    assert.ok(!teamMessages.some((m) => m.text === base.text));
});
