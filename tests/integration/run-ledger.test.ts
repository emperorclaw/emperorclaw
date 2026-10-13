import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;
const HOUR = 3_600_000;
const DAY = 86_400_000;

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

/** Poll until `check` passes or the timeout elapses (for fire-and-forget writes). */
async function eventually<T>(fn: () => Promise<T>, check: (value: T) => boolean, timeoutMs = 3_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await fn();
        if (check(value) || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function syncAs(rawToken: string, agentId: string, mode: "all" | "human_only" = "all") {
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=${mode}&agentId=${agentId}`, {
        headers: { authorization: `Bearer ${rawToken}` },
    }));
    assert.equal(res.status, 200);
    const json = await res.json();
    return json.messages as Array<Record<string, unknown>>;
}

maybe("a run start is idempotent by id and a finish is idempotent once terminal", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Runner" });
    const token = await tokenForAgent(companyId, agent.id);
    const runId = randomUUID();

    const start = await startRun(token, {
        id: runId,
        agentId: agent.id,
        runtimeId: "rt-1",
        runtimeKind: "hermes",
        bridgeVersion: "1.2.0",
        triggerKind: "message",
    });
    assert.equal(start.status, 200);
    const started = (await start.json()).run;
    assert.equal(started.id, runId);
    assert.equal(started.status, "running");
    assert.equal(started.runtimeId, "rt-1");

    // A repeat start for the same id is a no-op returning the same row.
    const again = await startRun(token, { id: runId, agentId: agent.id, runtimeId: "rt-1" });
    assert.equal(again.status, 200);
    assert.equal((await again.json()).run.status, "running");

    const replyMessageId = randomUUID();
    const finish = await finishRun(token, runId, {
        status: "succeeded",
        durationMs: 1500,
        inputTokens: 10,
        outputTokens: 5,
        toolCalls: 2,
        replyMessageId,
    });
    assert.equal(finish.status, 200);
    const finished = (await finish.json()).run;
    assert.equal(finished.status, "succeeded");
    assert.equal(finished.durationMs, 1500);
    assert.equal(finished.inputTokens, 10);
    assert.equal(finished.replyMessageId, replyMessageId);

    // A second finish never moves a terminal run.
    const second = await finishRun(token, runId, { status: "failed", durationMs: 9999 });
    const secondRun = (await second.json()).run;
    assert.equal(secondRun.status, "succeeded");
    assert.equal(secondRun.durationMs, 1500);
});

maybe("a finish for an unknown id creates the row and a cross-company token cannot touch it", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const { companyId: otherCompanyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Late" });
    const otherAgent = await seedAgent(otherCompanyId, { name: "Other" });
    const token = await tokenForAgent(companyId, agent.id);
    const otherToken = await tokenForAgent(otherCompanyId, otherAgent.id);

    const unknownId = randomUUID();
    const res = await finishRun(token, unknownId, { status: "timeout", durationMs: 250 });
    assert.equal(res.status, 200);
    const run = (await res.json()).run;
    assert.equal(run.id, unknownId);
    assert.equal(run.status, "timeout");
    // A token bound to an agent attributes the recovered run to that agent.
    assert.equal(run.agentId, agent.id);
    assert.equal(run.durationMs, 250);

    // The other company's token gets a conflict, never the row.
    const stolen = await finishRun(otherToken, unknownId, { status: "failed" });
    assert.equal(stolen.status, 409);
});

maybe("retention closes a stale running run as lost", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Stuck" });
    const db = await getDb();
    const { agentRuns } = await getSchema();

    const now = new Date();
    const runId = randomUUID();
    await db.insert(agentRuns).values({
        id: runId,
        companyId,
        agentId: agent.id,
        status: "running",
        startedAt: new Date(now.getTime() - 3 * HOUR),
    });

    const { runScheduledRetention } = await import("@/lib/retention");
    await runScheduledRetention(now);

    const [row] = await db.select().from(agentRuns);
    assert.equal(row.status, "lost");
    assert.ok(row.endedAt, "the closer stamps ended_at");
});

maybe("retention rolls up a finished day before deleting its old runs", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Roller" });
    const db = await getDb();
    const { agentRuns, agentRunDaily } = await getSchema();

    const now = new Date();
    const oldStart = new Date(now.getTime() - 40 * DAY);
    const recentStart = new Date(now.getTime() - 1 * DAY);
    await db.insert(agentRuns).values([
        {
            id: randomUUID(), companyId, agentId: agent.id, status: "succeeded",
            startedAt: oldStart, endedAt: new Date(oldStart.getTime() + 1200), durationMs: 1200,
            inputTokens: 100, outputTokens: 50, costCents: 7, toolCalls: 3,
        },
        {
            id: randomUUID(), companyId, agentId: agent.id, status: "succeeded",
            startedAt: recentStart, endedAt: new Date(recentStart.getTime() + 800), durationMs: 800,
        },
    ]);

    const { runScheduledRetention } = await import("@/lib/retention");
    await runScheduledRetention(now);

    // The old row (past the 30-day TTL) is gone; the recent one survives.
    const runs = await db.select().from(agentRuns);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].startedAt.getTime(), recentStart.getTime());

    // Its day was rolled up first.
    const daily = await db.select().from(agentRunDaily);
    const oldDay = oldStart.toISOString().slice(0, 10);
    const rolled = daily.find((row) => String(row.day) === oldDay);
    assert.ok(rolled, `expected a rollup for ${oldDay}`);
    assert.equal(rolled!.runs, 1);
    assert.equal(rolled!.succeeded, 1);
    assert.equal(rolled!.inputTokens, 100);
    assert.equal(rolled!.costCents, 7);
    assert.equal(rolled!.toolCalls, 3);
});

maybe("syncing stores the interesting verdicts and skips not_addressed", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const c = await seedAgent(companyId, { name: "Gamma", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "agent", id: a.id }, { title: "Work team", agentIds: [a.id, b.id, c.id] });
    const [tokB, tokC] = await Promise.all([tokenForAgent(companyId, b.id), tokenForAgent(companyId, c.id)]);
    const db = await getDb();
    const { threadMessages, messageRoutes } = await getSchema();

    // An agent message targeting Beta in the team thread.
    const [targeted] = await db.insert(threadMessages).values({
        companyId, threadId: group.id, senderType: "agent", senderId: a.id, targetAgentId: b.id, text: "handoff",
    }).returning();
    // A plain agent broadcast nobody is addressed by.
    const [plain] = await db.insert(threadMessages).values({
        companyId, threadId: group.id, senderType: "agent", senderId: a.id, text: "status update, no mentions",
    }).returning();

    await syncAs(tokB, b.id);
    await syncAs(tokC, c.id);

    // Verdicts are written fire-and-forget from the sync hot path, so poll until
    // both agents' decisions have landed before asserting.
    const routes = await eventually(
        () => db.select().from(messageRoutes),
        (rows) => rows.filter((row) => row.messageId === targeted.id).length === 2,
    );
    const targetedRoutes = routes.filter((row) => row.messageId === targeted.id);
    assert.equal(targetedRoutes.length, 2);
    const betaRoute = targetedRoutes.find((row) => row.agentId === b.id);
    const gammaRoute = targetedRoutes.find((row) => row.agentId === c.id);
    assert.ok(betaRoute && gammaRoute);
    assert.equal(betaRoute!.addressed, true);
    assert.equal(betaRoute!.routeReason, "targeted");
    assert.equal(gammaRoute!.addressed, false);
    assert.equal(gammaRoute!.routeReason, "targeted_other");
    // The plain not_addressed message is never stored.
    assert.equal(routes.filter((row) => row.messageId === plain.id).length, 0);
});

maybe("the delivery inspector loader returns verdicts, linked runs and delivery state", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Inspected" });
    const db = await getDb();
    const { messageThreads, threadMessages, messageRoutes, agentRuns } = await getSchema();

    const [thread] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const [message] = await db.insert(threadMessages).values({
        companyId, threadId: thread.id, senderType: "human", text: "@Inspected hello", deliveryState: "queued",
    }).returning();
    await db.insert(messageRoutes).values({
        companyId, messageId: message.id, agentId: agent.id, addressed: true, routeReason: "mention",
        agentStreak: 0, maxTurns: 12,
    });
    const runId = randomUUID();
    await db.insert(agentRuns).values({
        id: runId, companyId, agentId: agent.id, status: "succeeded",
        triggerMessageId: message.id, startedAt: new Date(),
    });

    const { loadMessageDelivery } = await import("@/lib/run-ledger-reads");
    const view = await loadMessageDelivery(companyId, message.id);
    assert.ok(view);
    assert.equal(view!.message.deliveryState, "queued");
    assert.equal(view!.verdicts.length, 1);
    assert.equal(view!.verdicts[0].agentName, "Inspected");
    assert.equal(view!.verdicts[0].routeReason, "mention");
    assert.equal(view!.runs.length, 1);
    assert.equal(view!.runs[0].id, runId);

    // Company scoping: another company sees nothing.
    assert.equal(await loadMessageDelivery(randomUUID(), message.id), null);
});

maybe("the agent runs loader paginates newest-first and windows the daily rollups", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Paged" });
    const db = await getDb();
    const { agentRuns, agentRunDaily } = await getSchema();

    const now = new Date();
    const rows = Array.from({ length: 60 }, (_v, i) => ({
        id: randomUUID(),
        companyId,
        agentId: agent.id,
        status: "succeeded",
        startedAt: new Date(now.getTime() - i * 60_000),
    }));
    await db.insert(agentRuns).values(rows);
    await db.insert(agentRunDaily).values([
        { companyId, agentId: agent.id, day: now.toISOString().slice(0, 10), runs: 5, succeeded: 5 },
        { companyId, agentId: agent.id, day: new Date(now.getTime() - 60 * DAY).toISOString().slice(0, 10), runs: 9 },
    ]);

    const { loadAgentRunsPage } = await import("@/lib/run-ledger-reads");
    const page = await loadAgentRunsPage(companyId, agent.id, { now });
    assert.equal(page.runs.length, 50);
    assert.ok(page.nextCursor);
    assert.ok(page.runs[0].startedAt.getTime() >= page.runs[49].startedAt.getTime());
    // Only the rollup inside the 30-day window is returned.
    assert.equal(page.daily.length, 1);
    assert.equal(Number(page.daily[0].runs), 5);

    const page2 = await loadAgentRunsPage(companyId, agent.id, { cursor: page.nextCursor, now });
    assert.equal(page2.runs.length, 10);
    assert.equal(page2.nextCursor, null);
});

maybe("a partially deleted day is never re-rolled from its surviving rows", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "RollOnce" });
    const db = await getDb();
    const { agentRuns, agentRunDaily } = await getSchema();
    const { inArray } = await import("drizzle-orm");

    const now = new Date();
    const dayStart = new Date(now.getTime() - 40 * DAY);
    dayStart.setUTCHours(0, 0, 0, 0);
    const rows = Array.from({ length: 40 }, (_v, i) => ({
        id: randomUUID(),
        companyId,
        agentId: agent.id,
        status: "succeeded",
        startedAt: new Date(dayStart.getTime() + i * 60_000),
        endedAt: new Date(dayStart.getTime() + i * 60_000 + 500),
        durationMs: 500,
    }));
    await db.insert(agentRuns).values(rows);

    const { rollupFinishedRuns } = await import("@/lib/run-ledger");
    await rollupFinishedRuns(now);

    const day = dayStart.toISOString().slice(0, 10);
    let [rolled] = await db.select().from(agentRunDaily);
    assert.ok(rolled, "the complete day was rolled up");
    assert.equal(String(rolled.day), day);
    assert.equal(rolled.runs, 40);

    // Simulate a budget-limited tick that stops mid-day: half the detail rows go,
    // the rollup stays. The next rollup must NOT recompute from the survivors.
    await db.delete(agentRuns).where(inArray(agentRuns.id, rows.slice(0, 20).map((r) => r.id)));
    await rollupFinishedRuns(now);

    [rolled] = await db.select().from(agentRunDaily);
    assert.equal(rolled.runs, 40, "totals are unchanged after a partial delete");
    assert.equal(rolled.succeeded, 40);
});

maybe("a token bound to an agent cannot finish another agent's run", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha" });
    const b = await seedAgent(companyId, { name: "Beta" });
    const tokenA = await tokenForAgent(companyId, a.id);
    const tokenB = await tokenForAgent(companyId, b.id);
    const db = await getDb();
    const { agentRuns } = await getSchema();

    const runId = randomUUID();
    await db.insert(agentRuns).values({
        id: runId, companyId, agentId: b.id, status: "running",
        startedAt: new Date(Date.now() - 1_000),
    });

    // Alpha's token must not be able to finish Beta's run.
    const forbidden = await finishRun(tokenA, runId, { status: "succeeded" });
    assert.equal(forbidden.status, 403);
    const [untouched] = await db.select().from(agentRuns);
    assert.equal(untouched.status, "running");

    // Beta's own token can.
    const ok = await finishRun(tokenB, runId, { status: "succeeded" });
    assert.equal(ok.status, 200);
    const [done] = await db.select().from(agentRuns);
    assert.equal(done.status, "succeeded");
});

maybe("a company-wide token recovers a lost start with no agent attribution", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const db = await getDb();
    const { agentRuns } = await getSchema();

    const unknownId = randomUUID();
    const res = await finishRun(rawToken, unknownId, { status: "timeout", durationMs: 200 });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).run.agentId, null);

    const [row] = await db.select().from(agentRuns);
    assert.equal(row.agentId, null);
});

maybe("retention prunes an unattributed run once its TTL passes", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { agentRuns } = await getSchema();

    const now = new Date();
    const old = new Date(now.getTime() - 40 * DAY);
    await db.insert(agentRuns).values({
        id: randomUUID(), companyId, agentId: null, status: "timeout",
        startedAt: old, endedAt: new Date(old.getTime() + 100),
    });

    const { runScheduledRetention } = await import("@/lib/retention");
    await runScheduledRetention(now);

    const rows = await db.select().from(agentRuns);
    assert.equal(rows.length, 0, "the null-agent row is pruned by TTL alone");
});

maybe("the lost-run closer leaves a finished run alone", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Finished" });
    const db = await getDb();
    const { agentRuns } = await getSchema();

    const now = new Date();
    const started = new Date(now.getTime() - 3 * HOUR);
    await db.insert(agentRuns).values({
        id: randomUUID(), companyId, agentId: agent.id, status: "succeeded",
        startedAt: started, endedAt: new Date(started.getTime() + 1_000), durationMs: 1_000,
    });

    const { closeLostRuns } = await import("@/lib/run-ledger");
    await closeLostRuns(now);

    const [row] = await db.select().from(agentRuns);
    assert.equal(row.status, "succeeded");
});

maybe("a malformed runs cursor is treated as no cursor", async () => {
    const { parseRunsCursor, encodeRunsCursor } = await import("@/lib/run-ledger-reads");
    assert.equal(parseRunsCursor("not-a-date|not-a-uuid"), null);
    assert.equal(parseRunsCursor(`${new Date().toISOString()}|not-a-uuid`), null);
    assert.equal(parseRunsCursor("|" + randomUUID()), null);
    const valid = parseRunsCursor(encodeRunsCursor({ startedAt: new Date(), id: randomUUID() }));
    assert.ok(valid);
});
