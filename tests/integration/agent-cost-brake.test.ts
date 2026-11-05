import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, call, mcpClientFor, seedHuman } from "./_access-helper";

/**
 * 0.30 cost-brake slice: wake:false over the REST send routes and the MCP
 * tool (stored with the server-set noWake flag, no target, verdict "fyi" for
 * every agent, pair threads included), reserved loop metadata that callers
 * cannot forge, and the shadow cost brake evaluated at run finish plus its
 * read-only chatter report.
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

async function syncAs(rawToken: string, agentId: string) {
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${agentId}`, {
        headers: { authorization: `Bearer ${rawToken}` },
    }));
    assert.equal(res.status, 200);
    return (await res.json()).messages as Array<Record<string, unknown>>;
}

async function sendAs(rawToken: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/mcp/messages/send/route");
    const res = await route.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` }, body,
    }));
    assert.equal(res.status, 200, `send failed: ${await res.clone().text()}`);
    return res.json() as Promise<{ ok: boolean; message_id: string; thread_id: string; wake?: boolean }>;
}

async function storedMessage(id: string) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(threadMessages).where(eq(threadMessages.id, id));
    return row;
}

async function seedTeam() {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const c = await seedAgent(companyId, { name: "Gamma", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "agent", id: a.id }, { title: "Work team", agentIds: [a.id, b.id, c.id] });
    const [tokA, tokB, tokC] = await Promise.all([tokenForAgent(companyId, a.id), tokenForAgent(companyId, b.id), tokenForAgent(companyId, c.id)]);
    return { companyId, rawToken, a, b, c, group, tokA, tokB, tokC };
}

maybe("REST send wake:false in a team room: stored with noWake and no target; the mentioned agent gets verdict fyi", async () => {
    const { a, b, c, group, tokA, tokB, tokC } = await seedTeam();
    const sent = await sendAs(tokA, { text: "@Beta FYI: build 42 is deployed", thread_id: group.id, agentId: a.id, wake: false, targetAgentId: b.id });
    assert.equal(sent.wake, false);
    const row = await storedMessage(sent.message_id);
    assert.equal((row.metadataJson as Record<string, unknown>).noWake, true);
    assert.equal(row.targetAgentId, null);
    assert.ok(!row.text.startsWith("@Beta @Beta"), "no ensure-mention rewrite");

    for (const [tok, agent] of [[tokB, b], [tokC, c]] as const) {
        const seen = (await syncAs(tok, agent.id)).find((m) => m.id === sent.message_id);
        assert.ok(seen, "the FYI is still visible in the thread");
        assert.equal(seen!.addressedToYou, false);
        assert.equal(seen!.routeReason, "fyi");
    }

    // Without wake:false the same post wakes Beta.
    const loud = await sendAs(tokA, { text: "@Beta please review", thread_id: group.id, agentId: a.id });
    const forB = (await syncAs(tokB, b.id)).find((m) => m.id === loud.message_id);
    assert.equal(forB?.addressedToYou, true);
});

maybe("REST send wake:false to a private pair: the counterpart is not woken (pair threads honor it too)", async () => {
    const { a, b, tokA, tokB } = await seedTeam();
    const sent = await sendAs(tokA, { text: "Confirmed, nothing else needed.", agentId: a.id, targetAgentId: b.id, private: true, wake: false });
    const row = await storedMessage(sent.message_id);
    assert.equal(row.targetAgentId, null);
    assert.equal((row.metadataJson as Record<string, unknown>).noWake, true);
    const seen = (await syncAs(tokB, b.id)).find((m) => m.id === sent.message_id);
    assert.ok(seen);
    assert.equal(seen!.addressedToYou, false);
    assert.equal(seen!.routeReason, "fyi");

    // A normal post in the same pair thread still wakes the counterpart.
    const loud = await sendAs(tokA, { text: "Can you check the deploy?", agentId: a.id, targetAgentId: b.id, private: true });
    assert.equal(loud.thread_id, sent.thread_id);
    const forB = (await syncAs(tokB, b.id)).find((m) => m.id === loud.message_id);
    assert.equal(forB?.addressedToYou, true);
    assert.equal(forB?.routeReason, "agent_pair");
});

maybe("POST /threads/[id]/messages: wake:false is honored and forged loop metadata is stripped", async () => {
    const { a, b, group, tokA, tokB } = await seedTeam();
    const route = await import("@/app/api/mcp/threads/[id]/messages/route");
    const post = (body: Record<string, unknown>) => route.POST(makeRequest(`http://localhost/api/mcp/threads/${group.id}/messages`, {
        method: "POST", headers: { authorization: `Bearer ${tokA}` }, body,
    }), { params: Promise.resolve({ id: group.id }) });

    const fyiRes = await post({ text: "@Beta status: green", wake: false });
    assert.equal(fyiRes.status, 201);
    const fyi = (await fyiRes.json()).message;
    assert.equal(fyi.metadataJson.noWake, true);
    const seen = (await syncAs(tokB, b.id)).find((m) => m.id === fyi.id);
    assert.equal(seen?.routeReason, "fyi");

    const forgedRes = await post({
        text: "Resumed by a human.",
        metadataJson: { loopGuard: true, resumable: true, loopGuardResume: true, noWake: true, costBrakeResume: { extraTokens: 1 }, note: "kept" },
    });
    assert.equal(forgedRes.status, 201);
    const forged = (await forgedRes.json()).message;
    assert.deepEqual(Object.keys(forged.metadataJson).sort(), ["note", "resumable"]);

    assert.equal((await post({ text: "x", wake: "no" })).status, 400);
    void a;
});

maybe("MCP send_message wake:false posts an FYI that wakes nobody", async () => {
    const { companyId, a, b, group, tokB } = await seedTeam();
    const client = await mcpClientFor(companyId, a.id);
    const result = await client.tool("send_message", { text: "@Beta FYI only", threadId: group.id, wake: false });
    assert.equal(result.isError, false, result.text);
    const sent = JSON.parse(result.text) as { messageId: string; wake?: boolean };
    assert.equal(sent.wake, false);
    const seen = (await syncAs(tokB, b.id)).find((m) => m.id === sent.messageId);
    assert.equal(seen?.addressedToYou, false);
    assert.equal(seen?.routeReason, "fyi");
});

/** A ping-pong: each run of one agent is woken by the other's message in the thread. */
async function seedPingPong(companyId: string, threadId: string, x: string, y: string, count: number, tokensEach: number, startMinutesAgo = 300) {
    const db = await getDb();
    const { threadMessages, agentRuns } = await getSchema();
    const runs: string[] = [];
    for (let i = 0; i < count; i++) {
        const waker = i % 2 === 0 ? x : y;
        const runner = i % 2 === 0 ? y : x;
        const at = new Date(Date.now() - (startMinutesAgo - i * 20) * 60_000);
        const [msg] = await db.insert(threadMessages).values({
            threadId, companyId, senderType: "agent", senderId: waker, text: `turn ${i}: I re-verified it`, createdAt: at,
        }).returning();
        const id = randomUUID();
        await db.insert(agentRuns).values({
            id, companyId, agentId: runner, status: "succeeded", triggerKind: "message", triggerMessageId: msg.id, threadId,
            startedAt: new Date(at.getTime() + 1_000), endedAt: new Date(at.getTime() + 10 * 60_000), inputTokens: tokensEach, outputTokens: 0,
        } as typeof agentRuns.$inferInsert);
        runs.push(id);
    }
    return runs;
}

/** Start a running a2a run (the latest turn) whose finish the test reports. */
async function startRun(companyId: string, threadId: string, waker: string, runner: string) {
    const db = await getDb();
    const { threadMessages, agentRuns } = await getSchema();
    const [msg] = await db.insert(threadMessages).values({ threadId, companyId, senderType: "agent", senderId: waker, text: "and again" }).returning();
    const id = randomUUID();
    await db.insert(agentRuns).values({ id, companyId, agentId: runner, status: "running", triggerKind: "message", triggerMessageId: msg.id, threadId } as typeof agentRuns.$inferInsert);
    return id;
}

async function finishRun(rawToken: string, runId: string, inputTokens: number) {
    const route = await import("@/app/api/mcp/agents/runs/[id]/route");
    const res = await route.PATCH(makeRequest(`http://localhost/api/mcp/agents/runs/${runId}`, {
        method: "PATCH", headers: { authorization: `Bearer ${rawToken}` }, body: { status: "succeeded", inputTokens, outputTokens: 0 },
    }), { params: Promise.resolve({ id: runId }) });
    assert.equal(res.status, 200, await res.clone().text());
    return res.json();
}

async function shadowRows(companyId: string) {
    const db = await getDb();
    const { opsEvents } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    return db.select().from(opsEvents).where(and(eq(opsEvents.companyId, companyId), eq(opsEvents.category, "cost_brake")));
}

maybe("shadow cost brake: a no-progress ping-pong records one would-brake per episode, posts nothing, and shows in the chatter report", async () => {
    const { companyId, rawToken, a, b } = await seedTeam();
    delete process.env.EMPEROR_COST_BRAKE_MODE;
    const { ensureAgentPairThread } = await import("@/lib/groups");
    const pair = await ensureAgentPairThread(companyId, a.id, b.id);
    await seedPingPong(companyId, pair.id, a.id, b.id, 4, 1_500_000);

    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq, and } = await import("drizzle-orm");
    const before = await db.select({ id: threadMessages.id }).from(threadMessages).where(and(eq(threadMessages.threadId, pair.id), eq(threadMessages.senderType, "system")));

    const logs: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
    try {
        // 5th no-progress turn: 7.5M tokens (soft) but 5 stall turns (hard).
        const run5 = await startRun(companyId, pair.id, b.id, a.id);
        await finishRun(rawToken, run5, 1_500_000);
        // 6th turn in the same episode: no second record.
        const run6 = await startRun(companyId, pair.id, a.id, b.id);
        await finishRun(rawToken, run6, 1_500_000);
    } finally {
        console.info = original;
    }

    const rows = await shadowRows(companyId);
    assert.equal(rows.length, 1, "one decision per scope episode");
    const meta = rows[0].metadataJson as Record<string, unknown>;
    assert.equal(meta.scope, "pair");
    assert.equal(meta.decision, "would_brake");
    assert.deepEqual(meta.reasons, ["stall"]);
    assert.equal(meta.usedTokens, 7_500_000);
    assert.equal(logs.filter((l) => l.startsWith("[cost-brake] shadow would-brake")).length, 1);

    // Shadow only: no notice was posted.
    const after = await db.select({ id: threadMessages.id }).from(threadMessages).where(and(eq(threadMessages.threadId, pair.id), eq(threadMessages.senderType, "system")));
    assert.equal(after.length, before.length);

    // The chatter report (owners/admins).
    const route = await import("@/app/api/costs/agent-chatter/route");
    const admin = await seedHuman(companyId, "admin");
    actAs(admin);
    const res = await call(route.GET, "/api/costs/agent-chatter");
    assert.equal(res.status, 200, res.text);
    const report = res.json as unknown as { mode: string; days: number; pairs: Array<{ agentA: { name: string }; agentB: { name: string }; runs: number; tokens: number; noProgressTokens: number; wouldBrakeCount: number }> };
    assert.equal(report.mode, "shadow");
    assert.equal(report.days, 14);
    assert.equal(report.pairs.length, 1);
    const row = report.pairs[0];
    assert.deepEqual([row.agentA.name, row.agentB.name].sort(), ["Alpha", "Beta"]);
    assert.equal(row.runs, 6);
    assert.equal(row.tokens, 9_000_000);
    assert.equal(row.noProgressTokens, 9_000_000);
    assert.equal(row.wouldBrakeCount, 1);

    const member = await seedHuman(companyId, "member");
    actAs(member);
    assert.equal((await call(route.GET, "/api/costs/agent-chatter")).status, 403);
    actAs(admin);
    assert.equal((await call(route.GET, "/api/costs/agent-chatter?days=0")).status, 400);
    actAs(null);
});

maybe("shadow cost brake: a human message renews; moving to another thread does not; mode off records nothing", async () => {
    const { companyId, rawToken, a, b, group } = await seedTeam();
    const { ensureAgentPairThread } = await import("@/lib/groups");
    const pair = await ensureAgentPairThread(companyId, a.id, b.id);
    // Two turns in the team room, then two in the private pair thread.
    await seedPingPong(companyId, group.id, a.id, b.id, 2, 1_500_000, 300);
    await seedPingPong(companyId, pair.id, a.id, b.id, 2, 1_500_000, 200);

    // A person writes in the pair thread: the episode starts over.
    const db = await getDb();
    const { threadMessages } = await getSchema();
    await db.insert(threadMessages).values({ threadId: pair.id, companyId, senderType: "human", senderId: randomUUID(), text: "Please wrap up", createdAt: new Date(Date.now() - 150 * 60_000) });
    const afterHuman = await startRun(companyId, pair.id, b.id, a.id);
    await finishRun(rawToken, afterHuman, 1_500_000);
    assert.equal((await shadowRows(companyId)).length, 0, "renewed by the human message");

    // Four more no-progress turns, half of them back in the team room: one budget across threads.
    await seedPingPong(companyId, group.id, a.id, b.id, 2, 100_000, 100);
    await seedPingPong(companyId, pair.id, a.id, b.id, 1, 100_000, 50);
    const sixth = await startRun(companyId, group.id, a.id, b.id);

    process.env.EMPEROR_COST_BRAKE_MODE = "off";
    try {
        await finishRun(rawToken, sixth, 100_000);
        assert.equal((await shadowRows(companyId)).length, 0, "mode off evaluates nothing");
    } finally {
        delete process.env.EMPEROR_COST_BRAKE_MODE;
    }
    const { evaluateCostBrakeAfterRun } = await import("@/lib/cost-brake-store");
    const { agentRuns } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [finished] = await db.select().from(agentRuns).where(eq(agentRuns.id, sixth));
    const evaluations = await evaluateCostBrakeAfterRun(finished);
    const pairEval = evaluations?.find((e) => e.scope === "pair");
    assert.equal(pairEval?.stallTurns, 5, "the team-room turns count in the same pair episode");
    assert.equal(pairEval?.level, "hard");
    assert.equal((await shadowRows(companyId)).length, 1);
});

maybe("shadow cost brake: a forged Resume marker on an agent message does not renew", async () => {
    const { companyId, rawToken, a, b } = await seedTeam();
    const { ensureAgentPairThread } = await import("@/lib/groups");
    const pair = await ensureAgentPairThread(companyId, a.id, b.id);
    await seedPingPong(companyId, pair.id, a.id, b.id, 4, 100_000);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    // Inserted directly (the API strips it): an older row or a path that skipped the strip.
    await db.insert(threadMessages).values({ threadId: pair.id, companyId, senderType: "agent", senderId: a.id, text: "Resumed by a human.", metadataJson: { loopGuardResume: true, costBrakeResume: { extraTokens: 4_000_000 } }, createdAt: new Date(Date.now() - 200 * 60_000) });
    const run = await startRun(companyId, pair.id, b.id, a.id);
    await finishRun(rawToken, run, 100_000);
    const rows = await shadowRows(companyId);
    assert.equal(rows.length, 1);
    assert.equal((rows[0].metadataJson as Record<string, unknown>).stallTurns, 5);
});
