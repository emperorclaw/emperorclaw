import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

/**
 * 0.9 UI read side (§4.7): chat liveRuns/replyRuns, the run timeline with its
 * privacy redaction, the Right now card's live view and bridge badge, and the
 * delivery inspector's coalesced ids and event counts.
 */

const maybe = dbAvailable ? test : test.skip;

async function setup() {
    await resetDb();
    const db = await getDb();
    const { users, threadParticipants } = await getSchema();
    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Streamer", provider: "hermes" });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, agent.id);
    // The owner takes part in the direct thread; `outsider` does not.
    await db.insert(threadParticipants).values({ companyId, threadId: thread.id, participantType: "human", participantRef: ownerId });
    const [outsider] = await db.insert(users).values({ email: `outsider-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    return { companyId, ownerId, outsiderId: outsider.id, agent, thread };
}

async function seedRun(input: {
    companyId: string; agentId: string; threadId: string; status?: string; endedAt?: Date | null;
    replyMessageId?: string | null; triggerMessageId?: string | null; extra?: Record<string, unknown>;
}) {
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const [run] = await db.insert(agentRuns).values({
        id: randomUUID(),
        companyId: input.companyId,
        agentId: input.agentId,
        threadId: input.threadId,
        runtimeKind: "hermes",
        triggerKind: "message",
        triggerMessageId: input.triggerMessageId ?? null,
        replyMessageId: input.replyMessageId ?? null,
        status: input.status ?? "running",
        startedAt: new Date(Date.now() - 30_000),
        endedAt: input.endedAt ?? null,
        ...(input.extra ?? {}),
    }).returning();
    return run;
}

async function seedEvents(companyId: string, run: { id: string; agentId: string | null; threadId: string | null }, events: Array<Record<string, unknown>>) {
    const db = await getDb();
    const { agentRunEvents } = await getSchema();
    const base = Date.now() - 20_000;
    await db.insert(agentRunEvents).values(events.map((event, i) => ({
        id: randomUUID(),
        companyId,
        runId: run.id,
        agentId: run.agentId,
        threadId: run.threadId,
        seq: i + 1,
        ts: new Date(base + i * 1_000),
        kind: String(event.kind),
        ...event,
    })));
}

const SAMPLE = [
    { kind: "turn.started" },
    { kind: "reasoning", summary: "the salary sheet for Ana" },
    { kind: "tool.start", toolName: "read_file", toolCallId: "c1", status: "running", summary: "salaries.csv" },
    { kind: "tool.end", toolName: "read_file", toolCallId: "c1", status: "ok", durationMs: 67, summary: "salaries.csv" },
    { kind: "notice", summary: "Retrying model call" },
    { kind: "usage", data: { input: 1_000, output: 40, cacheRead: 600, contextUsed: 20, contextMax: 100, costUsd: 0.02 } },
    { kind: "tool.start", toolName: "terminal", toolCallId: "c2", status: "running", summary: "npm test" },
];

maybe("chat gets live runs (eventsSince-aware) and the runs behind agent replies", async () => {
    const { companyId, agent, thread } = await setup();
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const live = await seedRun({ companyId, agentId: agent.id, threadId: thread.id });
    await seedEvents(companyId, live, SAMPLE);
    const [reply] = await db.insert(threadMessages).values({ companyId, threadId: thread.id, senderType: "agent", senderId: agent.id, text: "done" }).returning();
    await seedRun({
        companyId, agentId: agent.id, threadId: thread.id, status: "succeeded",
        endedAt: new Date(Date.now() - 10 * 60_000), replyMessageId: reply.id,
        extra: { durationMs: 42_000, toolCalls: 6, inputTokens: 18_000, outputTokens: 200, model: "deepseek-v4" },
    });

    const { loadChatRunState } = await import("@/lib/run-ledger-reads");
    const state = await loadChatRunState(companyId, thread.id, { replyMessageIds: [reply.id] });
    assert.equal(state.liveRuns.length, 1, "the old finished run is not live");
    const run = state.liveRuns[0];
    assert.equal(run.runId, live.id);
    assert.equal(run.current.summary, "Running terminal · npm test");
    assert.deepEqual(run.steps.map((s) => s.kind), ["reasoning", "tool.start", "tool.end", "notice", "tool.start"]);
    assert.equal(run.usage?.cacheRead, 600);
    assert.equal(run.usage?.contextPercent, 20);

    const { parseEventsSince } = await import("@/lib/run-events");
    const since = await loadChatRunState(companyId, thread.id, { since: parseEventsSince(`${live.id}:5`) });
    assert.deepEqual(since.liveRuns[0].steps.map((s) => s.seq), [7]);

    assert.deepEqual(state.replyRuns[reply.id], {
        runId: state.replyRuns[reply.id].runId, status: "succeeded", durationMs: 42_000, toolCalls: 6,
        inputTokens: 18_000, outputTokens: 200, model: "deepseek-v4", taskId: null,
    });
    // An incremental poll (no reply ids) still gets runs that just finished.
    const fresh = await seedRun({ companyId, agentId: agent.id, threadId: thread.id, status: "succeeded", endedAt: new Date(), replyMessageId: randomUUID() });
    const incremental = await loadChatRunState(companyId, thread.id, {});
    assert.ok(Object.values(incremental.replyRuns).some((r) => r.runId === fresh.id));
    assert.ok(!Object.values(incremental.replyRuns).some((r) => r.status === "succeeded" && r.durationMs === 42_000));
});

maybe("the run timeline is redacted for a viewer outside the private thread", async () => {
    const { companyId, ownerId, outsiderId, agent, thread } = await setup();
    const run = await seedRun({ companyId, agentId: agent.id, threadId: thread.id, status: "failed", endedAt: new Date(), extra: { error: "Ana earns 90k", exitReason: "text_response(finish_reason=stop)", cacheReadTokens: 600, inputTokens: 1_000 } });
    await seedEvents(companyId, run, SAMPLE);
    const { loadRunTimeline } = await import("@/lib/run-ledger-reads");

    const mine = await loadRunTimeline(companyId, run.id, { viewerUserId: ownerId });
    assert.ok(mine);
    assert.equal(mine.redacted, false);
    assert.equal(mine.run.error, "Ana earns 90k");
    assert.equal(mine.run.threadId, thread.id);
    assert.equal(mine.run.exitReason, "text_response(finish_reason=stop)");
    assert.deepEqual(mine.steps.map((s) => s.kind), ["reasoning", "tool.start", "tool.end", "notice", "tool.start"]);
    assert.equal(mine.steps[0].summary, "the salary sheet for Ana");
    assert.equal(mine.usage?.costUsd, 0.02);

    const theirs = await loadRunTimeline(companyId, run.id, { viewerUserId: outsiderId });
    assert.ok(theirs);
    assert.equal(theirs.redacted, true);
    assert.equal(theirs.run.threadId, null);
    assert.equal(theirs.run.error, "Run failed");
    assert.equal(theirs.steps.length, 5);
    assert.ok(theirs.steps.every((s) => s.summary === undefined));
    assert.equal(JSON.stringify(theirs).includes("salar"), false);

    // Member scope and company scope.
    assert.equal(await loadRunTimeline(companyId, run.id, { viewerUserId: ownerId, agentIds: [] }), null);
    assert.equal(await loadRunTimeline(randomUUID(), run.id, { viewerUserId: ownerId }), null);

    // The Runs tab redacts the same way when given a viewer.
    const { loadAgentRunsPage } = await import("@/lib/run-ledger-reads");
    const page = await loadAgentRunsPage(companyId, agent.id, { viewerUserId: outsiderId });
    assert.equal(page.runs[0].error, "Run failed");
    assert.equal(page.runs[0].threadId, null);
});

maybe("the Right now card shows real steps and usage, redacted outside the thread, plus the bridge badge", async () => {
    const { companyId, ownerId, outsiderId, agent, thread } = await setup();
    const db = await getDb();
    const { agents, runtimeNodes } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ lastSeenAt: new Date() }).where(eq(agents.id, agent.id));
    const run = await seedRun({ companyId, agentId: agent.id, threadId: thread.id });
    await seedEvents(companyId, run, SAMPLE);
    await db.insert(runtimeNodes).values({ companyId, runtimeId: "rt-1", name: "pc", agentId: agent.id, bridgeVersion: "0.8.0", gatewayTopology: "shared", deployMode: "remote" });

    const { loadAgentActivity, PRIVATE_ACTIVITY } = await import("@/lib/agent-activity");
    const [mine] = await loadAgentActivity(companyId, { viewerUserId: ownerId });
    assert.equal(mine.run?.live?.current.summary, "Running terminal · npm test");
    assert.deepEqual(mine.run?.live?.steps.map((s) => s.kind), ["tool.end", "notice", "tool.start"]);
    assert.equal(mine.run?.live?.usage?.input, 1_000);
    assert.equal(mine.runtime?.updateState, "unsupported");
    assert.equal(mine.runtime?.gatewayTopology, "shared");

    const [theirs] = await loadAgentActivity(companyId, { viewerUserId: outsiderId });
    assert.equal(theirs.run?.live?.current.summary, PRIVATE_ACTIVITY);
    assert.deepEqual(theirs.run?.live?.steps, []);
    assert.equal(theirs.run?.threadId, null);
    assert.equal(JSON.stringify(theirs).includes("npm test"), false);

    // A 0.3 bridge never reports a version: legacy.
    await db.update(runtimeNodes).set({ bridgeVersion: null }).where(eq(runtimeNodes.runtimeId, "rt-1"));
    const [legacy] = await loadAgentActivity(companyId, { viewerUserId: ownerId });
    assert.equal(legacy.runtime?.updateState, "legacy");
});

maybe("the delivery inspector lists coalesced messages and event counts", async () => {
    const { companyId, ownerId, agent, thread } = await setup();
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const [trigger] = await db.insert(threadMessages).values({ companyId, threadId: thread.id, senderType: "human", senderId: ownerId, text: "first" }).returning();
    const [follow] = await db.insert(threadMessages).values({
        companyId, threadId: thread.id, senderType: "human", senderId: ownerId, text: "also this",
        deliveryState: "resolved", metadataJson: { coalescedIntoMessageId: trigger.id },
    }).returning();
    const run = await seedRun({ companyId, agentId: agent.id, threadId: thread.id, triggerMessageId: trigger.id });
    await seedEvents(companyId, run, SAMPLE);

    const { loadMessageDelivery } = await import("@/lib/run-ledger-reads");
    const view = await loadMessageDelivery(companyId, trigger.id);
    assert.deepEqual(view?.coalescedMessageIds, [follow.id]);
    assert.equal(view?.coalescedInto, null);
    assert.equal(view?.runs[0].eventsCount, SAMPLE.length);
    const other = await loadMessageDelivery(companyId, follow.id);
    assert.equal(other?.coalescedInto, trigger.id);
});
