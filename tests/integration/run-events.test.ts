import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

/** Mint an MCP token bound to one agent (a real runtime identity). */
async function tokenForAgent(companyId: string, agentId: string): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId,
        agentId,
        tokenHash: createHash("sha256").update(raw).digest("hex"),
        name: `agent-${agentId}`,
        scope: "mcp_full",
    });
    return raw;
}

async function postEvents(rawToken: string, runId: string, body: unknown) {
    const route = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const res = await route.POST(
        makeRequest(`http://localhost/api/mcp/agents/runs/${runId}/events`, {
            method: "POST",
            headers: { authorization: `Bearer ${rawToken}` },
            body,
        }),
        { params: Promise.resolve({ id: runId }) },
    );
    return { res, json: await res.json() };
}

async function startRun(rawToken: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/mcp/agents/runs/route");
    return route.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}` },
        body,
    }));
}

async function finishRun(rawToken: string, id: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/mcp/agents/runs/[id]/route");
    return route.PATCH(
        makeRequest(`http://localhost/api/mcp/agents/runs/${id}`, {
            method: "PATCH",
            headers: { authorization: `Bearer ${rawToken}` },
            body,
        }),
        { params: Promise.resolve({ id }) },
    );
}

function ev(seq: number, kind: string, extra: Record<string, unknown> = {}) {
    return { id: randomUUID(), seq, ts: new Date().toISOString(), kind, ...extra };
}

async function setup() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Streamer" });
    const token = await tokenForAgent(companyId, agent.id);
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, agent.id);
    return { companyId, agent, token, thread };
}

maybe("events are idempotent by id and (run, seq), and a missing run without header is 409", async () => {
    const { agent, token, thread } = await setup();
    const runId = randomUUID();

    const missing = await postEvents(token, runId, { events: [ev(1, "turn.started")] });
    assert.equal(missing.res.status, 409);
    assert.equal(missing.json.error, "run_not_found");

    const run = { id: runId, agentId: agent.id, runtimeId: "rt-1", runtimeKind: "hermes", bridgeVersion: "0.9.0", triggerKind: "message", threadId: thread.id };
    const batch = [
        ev(1, "turn.started", { data: { queueMs: 12 } }),
        ev(2, "tool.start", { toolName: "terminal", toolCallId: "call_2", status: "running", summary: "npm test", data: { target: "npm test" } }),
    ];
    const first = await postEvents(token, runId, { run, events: batch });
    assert.equal(first.res.status, 200);
    assert.deepEqual(first.json, { accepted: 2, duplicates: 0, dropped: 0, lastSeq: 2, runStatus: "running" });

    // Replay of the same batch (same ids) plus a new id reusing seq 2.
    const replay = await postEvents(token, runId, { run, events: [...batch, ev(2, "tool.end"), ev(3, "tool.end", { toolName: "terminal", status: "ok", durationMs: 2310 })] });
    assert.equal(replay.res.status, 200);
    assert.deepEqual(replay.json, { accepted: 1, duplicates: 3, dropped: 0, lastSeq: 3, runStatus: "running" });

    const db = await getDb();
    const { agentRunEvents, agentRuns, threadParticipants } = await getSchema();
    const { eq, and } = await import("drizzle-orm");
    const rows = await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId));
    assert.deepEqual(rows.map((row) => row.seq).sort(), [1, 2, 3]);
    assert.ok(rows.every((row) => row.threadId === thread.id && row.agentId === agent.id));

    // The header created the run (start POST never landed).
    const [stored] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    assert.equal(stored.status, "running");
    assert.equal(stored.runtimeId, "rt-1");

    // The newest event drove the typing row.
    const [participant] = await db.select().from(threadParticipants).where(and(
        eq(threadParticipants.threadId, thread.id), eq(threadParticipants.participantId, agent.id),
    ));
    assert.equal(participant.currentActivity, "Finished terminal");
    assert.ok(participant.typingUntil && participant.typingUntil.getTime() > Date.now());

    // A terminal event clears it.
    await postEvents(token, runId, { events: [ev(4, "turn.completed", { durationMs: 5000 })] });
    const [cleared] = await db.select().from(threadParticipants).where(and(
        eq(threadParticipants.threadId, thread.id), eq(threadParticipants.participantId, agent.id),
    ));
    assert.equal(cleared.typingUntil, null);
    assert.equal(cleared.currentActivity, null);
});

maybe("events for a finished run are accepted for 10 minutes, then 410; run deletion cascades", async () => {
    const { agent, token, thread } = await setup();
    const runId = randomUUID();
    assert.equal((await startRun(token, { id: runId, agentId: agent.id, threadId: thread.id })).status, 200);
    assert.equal((await finishRun(token, runId, { status: "succeeded" })).status, 200);

    const late = await postEvents(token, runId, { events: [ev(1, "compaction.end", { durationMs: 900 })] });
    assert.equal(late.res.status, 200);
    assert.equal(late.json.runStatus, "succeeded");

    const db = await getDb();
    const { agentRuns, agentRunEvents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agentRuns).set({ endedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(agentRuns.id, runId));
    const gone = await postEvents(token, runId, { events: [ev(2, "usage", { data: { input: 1 } })] });
    assert.equal(gone.res.status, 410);

    await db.delete(agentRuns).where(eq(agentRuns.id, runId));
    assert.equal((await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId))).length, 0);
});

maybe("the per-run cap drops low-value kinds first and counts them on the run", async () => {
    const { companyId, agent, token } = await setup();
    const runId = randomUUID();
    assert.equal((await startRun(token, { id: runId, agentId: agent.id })).status, 200);

    // Pre-fill the run to 1,998 of its 2,000 events.
    const db = await getDb();
    const { agentRuns, agentRunEvents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const now = new Date();
    for (let start = 0; start < 1_998; start += 500) {
        const rows = [];
        for (let seq = start; seq < Math.min(start + 500, 1_998); seq++) {
            rows.push({ id: randomUUID(), companyId, runId, agentId: agent.id, seq, ts: now, kind: "usage" });
        }
        await db.insert(agentRunEvents).values(rows);
    }

    const result = await postEvents(token, runId, {
        events: [
            ev(2_000, "reasoning", { summary: "thinking" }),
            ev(2_001, "tool.start", { toolName: "web" }),
            ev(2_002, "usage", { data: { input: 5 } }),
            ev(2_003, "turn.completed"),
        ],
    });
    assert.equal(result.res.status, 200);
    assert.equal(result.json.accepted, 2);
    assert.equal(result.json.dropped, 2);
    assert.equal(result.json.lastSeq, 2_003);

    // A retried batch of already-stored events is all duplicates, never drops.
    const retried = await postEvents(token, runId, { events: [ev(2_001, "tool.start", { toolName: "web" }), ev(2_003, "turn.completed")] });
    assert.equal(retried.json.duplicates, 2);
    assert.equal(retried.json.dropped, 0);

    const kinds = (await db.select().from(agentRunEvents).where(eq(agentRunEvents.runId, runId)))
        .filter((row) => row.seq >= 2_000).map((row) => row.kind).sort();
    assert.deepEqual(kinds, ["tool.start", "turn.completed"]);

    // The bridge's own spool drops are added on finish.
    assert.equal((await finishRun(token, runId, { status: "succeeded", eventsDropped: 3 })).status, 200);
    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    assert.equal(run.eventsDropped, 5);
});

maybe("events reject other agents' runs, oversize batches and mismatched headers", async () => {
    const { companyId, agent, token } = await setup();
    const other = await seedAgent(companyId, { name: "Other" });
    const otherToken = await tokenForAgent(companyId, other.id);
    const runId = randomUUID();
    assert.equal((await startRun(token, { id: runId, agentId: agent.id })).status, 200);

    assert.equal((await postEvents(otherToken, runId, { events: [ev(1, "turn.started")] })).res.status, 403);
    assert.equal((await postEvents(token, runId, { run: { id: randomUUID(), agentId: agent.id }, events: [] })).res.status, 400);
    const tooMany = Array.from({ length: 201 }, (_, i) => ev(i, "usage"));
    assert.equal((await postEvents(token, runId, { events: tooMany })).res.status, 413);
    assert.equal((await postEvents(token, runId, { events: [ev(1, "message.delta")] })).res.status, 400);
});

maybe("finish stores run-usage v2 fields; a 0.3-style finish still works", async () => {
    const { agent, token } = await setup();
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const { eq } = await import("drizzle-orm");

    const v2 = randomUUID();
    await startRun(token, { id: v2, agentId: agent.id, bridgeVersion: "0.9.0" });
    const res = await finishRun(token, v2, {
        status: "succeeded", inputTokens: 1200, outputTokens: 80, cacheReadTokens: 900, cacheWriteTokens: 10,
        reasoningTokens: 30, apiCalls: 2, model: "deepseek-v4-flash", provider: "deepseek", queueMs: 12,
        firstTokenMs: 1840, compactions: 1, exitReason: "text_response(finish_reason=stop)", futureField: "ignored",
    });
    assert.equal(res.status, 200);
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, v2));
    assert.equal(row.cacheReadTokens, 900);
    assert.equal(row.model, "deepseek-v4-flash");
    assert.equal(row.firstTokenMs, 1840);
    assert.equal(row.compactions, 1);
    assert.equal(row.exitReason, "text_response(finish_reason=stop)");

    const legacy = randomUUID();
    assert.equal((await startRun(token, { id: legacy, agentId: agent.id, runtimeKind: "hermes", bridgeVersion: "0.3.0", triggerKind: "message" })).status, 200);
    assert.equal((await finishRun(token, legacy, { status: "failed", durationMs: 50, toolCalls: 1, error: "boom" })).status, 200);
    const [legacyRow] = await db.select().from(agentRuns).where(eq(agentRuns.id, legacy));
    assert.equal(legacyRow.status, "failed");
    assert.equal(legacyRow.model, null);
});

maybe("a coalesced reply resolves the other queued messages in the same thread", async () => {
    const { companyId, agent, token, thread } = await setup();
    const { appendThreadMessage } = await import("@/lib/control-plane");
    const human = (text: string) => appendThreadMessage({ companyId, threadId: thread.id, senderType: "human", targetAgentId: agent.id, text });
    const m1 = await human("first");
    const m2 = await human("second");
    const m3 = await human("third");

    const send = await import("@/app/api/mcp/messages/send/route");
    const res = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": `emp-${m3.id}` },
        body: { text: "One answer for all three.", thread_id: thread.id, agentId: agent.id, replyToMessageId: m3.id, alsoResolvesMessageIds: [m1.id, m2.id] },
    }));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.message_id);
    assert.deepEqual([...json.resolvedMessageIds].sort(), [m1.id, m2.id].sort());

    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { inArray } = await import("drizzle-orm");
    const rows = await db.select().from(threadMessages).where(inArray(threadMessages.id, [m1.id, m2.id]));
    for (const row of rows) {
        assert.equal(row.deliveryState, "resolved");
        assert.equal((row.metadataJson as Record<string, unknown>).resolvedByMessageId, json.message_id);
    }

    // A 0.3-style reply (no new field) is unchanged.
    const m4 = await human("fourth");
    const plain = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "Idempotency-Key": `emp-${m4.id}` },
        body: { text: "Plain reply.", thread_id: thread.id, agentId: agent.id, replyToMessageId: m4.id },
    }));
    assert.equal(plain.status, 200);
    const plainJson = await plain.json();
    assert.equal(plainJson.resolvedMessageIds, undefined);
});

maybe("loadLiveRuns returns running and just-finished runs of a thread with their steps", async () => {
    const { companyId, agent, token, thread } = await setup();
    const live = randomUUID();
    const old = randomUUID();
    await postEvents(token, live, {
        run: { id: live, agentId: agent.id, threadId: thread.id, triggerKind: "message" },
        events: [
            ev(1, "turn.started"),
            ev(2, "tool.start", { toolName: "terminal", data: { target: "npm test" } }),
            ev(3, "usage", { data: { input: 1000, output: 20, cacheRead: 500, contextUsed: 10_000, contextMax: 100_000 } }),
        ],
    });
    await startRun(token, { id: old, agentId: agent.id, threadId: thread.id });
    await finishRun(token, old, { status: "succeeded" });
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agentRuns).set({ endedAt: new Date(Date.now() - 5 * 60_000) }).where(eq(agentRuns.id, old));

    const { loadLiveRuns, parseEventsSince } = await import("@/lib/run-events");
    const runs = await loadLiveRuns(companyId, thread.id);
    assert.deepEqual(runs.map((run) => run.runId), [live]);
    assert.equal(runs[0].current.summary, "Running terminal · npm test");
    assert.ok(runs[0].current.sinceMs >= 0 && runs[0].current.sinceMs < 60_000, "event time is read in UTC");
    assert.deepEqual(runs[0].steps.map((step) => step.seq), [2]);
    assert.deepEqual(runs[0].usage, { input: 1000, output: 20, cacheRead: 500, contextPercent: 10 });

    const since = await loadLiveRuns(companyId, thread.id, { since: parseEventsSince(`${live}:2`) });
    assert.deepEqual(since[0].steps, []);
});

maybe("typing: a finished run only clears, a newer running run keeps the row, foreign threads are untouched", async () => {
    const { companyId, agent, token, thread } = await setup();
    const db = await getDb();
    const { threadParticipants, messageThreads } = await getSchema();
    const { eq, and } = await import("drizzle-orm");
    const row = async (threadId: string) => (await db.select().from(threadParticipants).where(and(
        eq(threadParticipants.threadId, threadId), eq(threadParticipants.participantId, agent.id),
    )))[0];

    // A late non-terminal event on a finished run must not show typing again.
    const done = randomUUID();
    await startRun(token, { id: done, agentId: agent.id, threadId: thread.id });
    await finishRun(token, done, { status: "succeeded" });
    await db.update(threadParticipants).set({ typingUntil: null, currentActivity: null }).where(eq(threadParticipants.threadId, thread.id));
    assert.equal((await postEvents(token, done, { events: [ev(1, "tool.start", { toolName: "web" })] })).res.status, 200);
    assert.equal((await row(thread.id)).typingUntil, null);

    // Run 1 working, then run 2 starts; run 1's late terminal event must not clear run 2's typing.
    const run1 = randomUUID();
    const run2 = randomUUID();
    await postEvents(token, run1, { run: { id: run1, agentId: agent.id, threadId: thread.id, startedAt: new Date(Date.now() - 5_000).toISOString() }, events: [ev(1, "tool.start", { toolName: "web" })] });
    await postEvents(token, run2, { run: { id: run2, agentId: agent.id, threadId: thread.id }, events: [ev(1, "tool.start", { toolName: "terminal", summary: "ls" })] });
    await postEvents(token, run1, { events: [ev(2, "turn.completed")] });
    const kept = await row(thread.id);
    assert.equal(kept.currentActivity, "Running terminal · ls");
    assert.ok(kept.typingUntil);
    await postEvents(token, run2, { events: [ev(2, "turn.completed")] });
    assert.equal((await row(thread.id)).typingUntil, null);

    // A run claiming a group thread the agent is not in never adds the agent to it.
    const [group] = await db.insert(messageThreads).values({ companyId, type: "group", title: "Private" }).returning();
    const intruder = randomUUID();
    assert.equal((await postEvents(token, intruder, { run: { id: intruder, agentId: agent.id, threadId: group.id }, events: [ev(1, "tool.start", { toolName: "web" })] })).res.status, 200);
    assert.equal(await row(group.id), undefined);
    // Nor a thread id from nowhere.
    const ghost = randomUUID();
    const ghostThread = randomUUID();
    await postEvents(token, ghost, { run: { id: ghost, agentId: agent.id, threadId: ghostThread }, events: [ev(1, "tool.start", { toolName: "web" })] });
    assert.equal(await row(ghostThread), undefined);
});

maybe("a coalesced reply never resolves another agent's targeted message or newer messages", async () => {
    const { companyId, agent, token } = await setup();
    const db = await getDb();
    const { messageThreads, threadParticipants, threadMessages } = await getSchema();
    const { inArray } = await import("drizzle-orm");
    const other = await seedAgent(companyId, { name: "Bee" });
    const [group] = await db.insert(messageThreads).values({ companyId, type: "group", title: "Ops" }).returning();
    await db.insert(threadParticipants).values([
        { companyId, threadId: group.id, participantType: "agent", participantId: agent.id, role: "member" },
        { companyId, threadId: group.id, participantType: "agent", participantId: other.id, role: "member" },
    ]);
    const { appendThreadMessage } = await import("@/lib/control-plane");
    const human = (text: string, targetAgentId: string | null = null) =>
        appendThreadMessage({ companyId, threadId: group.id, senderType: "human", targetAgentId, text });
    const forBee = await human("Bee, please check the invoices", other.id);
    const open = await human("anyone around?");
    const source = await human("Streamer, deploy please", agent.id);
    const later = await human("also after that, restart it");

    const send = await import("@/app/api/mcp/messages/send/route");
    const res = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST",
        headers: { authorization: "Bearer " + token, "Idempotency-Key": "emp-" + source.id },
        body: { text: "Deployed.", thread_id: group.id, agentId: agent.id, replyToMessageId: source.id, alsoResolvesMessageIds: [forBee.id, open.id, later.id] },
    }));
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.deepEqual(json.resolvedMessageIds, [open.id]);

    const rows = await db.select().from(threadMessages).where(inArray(threadMessages.id, [forBee.id, later.id]));
    assert.ok(rows.every((row) => row.deliveryState !== "resolved"));
});
