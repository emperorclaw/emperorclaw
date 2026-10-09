import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

maybe("objectives: starting one posts a private prompt and reports state", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { requestAgentObjective, readAgentObjective } = await import("@/lib/agent-objective");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");

    const started = await requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "Ship the beta build", cadenceMinutes: 60 });
    assert.equal(started.objective.status, "active");
    assert.equal(started.objective.followupCount, 1);

    const thread = await ensureDirectThread(companyId, dev.id, null);
    const prompts = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId),
        eq(threadMessages.threadId, thread.id),
        eq(threadMessages.senderType, "system"),
    ));
    assert.equal(prompts.length, 1, "exactly one start prompt is posted");
    const meta = prompts[0].metadataJson as Record<string, unknown>;
    assert.equal(meta.objectiveId, started.objective.id);
    assert.equal(prompts[0].targetAgentId, dev.id);
    assert.equal(prompts[0].deliveryState, "queued");

    const read = await readAgentObjective(companyId, dev.id);
    assert.equal(read.objective?.objective, "Ship the beta build");
});

maybe("objectives: an agent can only update its own objective", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "mcp" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "mcp" });
    const { requestAgentObjective, updateObjectiveFromAgent } = await import("@/lib/agent-objective");

    const started = await requestAgentObjective(companyId, userId, a.id, { action: "start", objective: "Alpha's goal" });
    await assert.rejects(
        updateObjectiveFromAgent(companyId, b.id, { objectiveId: started.objective.id, action: "complete" }),
        /Access denied/,
    );
    const own = await updateObjectiveFromAgent(companyId, a.id, { objectiveId: started.objective.id, action: "complete", completionSummary: "Done" });
    assert.equal(own.status, "completed");
    assert.equal(own.completionSummary, "Done");
});

maybe("objectives: the objective stays in the owner's private thread and other members see a redacted status", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { requestAgentObjective, readAgentObjective } = await import("@/lib/agent-objective");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const db = await getDb();
    const { companyMembers, users } = await getSchema();
    const { randomUUID } = await import("node:crypto");

    const started = await requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "Private roadmap" });
    const ownerThread = await ensureDirectThread(companyId, dev.id, userId);
    assert.equal(started.objective.id.length > 0, true);
    // The prompt lives in the originating (owner) direct thread.
    const { threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [prompt] = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId),
        eq(threadMessages.threadId, ownerThread.id),
    )).limit(1);
    assert.ok(prompt, "the start prompt is in the owner's thread");

    // An unrelated plain member sees only a redacted status.
    const [member] = await db.insert(users).values({ email: `m-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values({ companyId, userId: member.id, role: "member" });
    const redacted = await readAgentObjective(companyId, dev.id, member.id);
    assert.equal(redacted.restricted, true);
    assert.equal(redacted.objective?.objective, null);
    assert.match((redacted.objective as { message?: string }).message ?? "", /private conversation/);

    // The owner and an admin see the full text.
    const ownerRead = await readAgentObjective(companyId, dev.id, userId);
    assert.equal(ownerRead.restricted, false);
    assert.equal(ownerRead.objective?.objective, "Private roadmap");
    const [admin] = await db.insert(users).values({ email: `a-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values({ companyId, userId: admin.id, role: "admin" });
    const adminRead = await readAgentObjective(companyId, dev.id, admin.id);
    assert.equal(adminRead.restricted, false);
    assert.equal(adminRead.objective?.objective, "Private roadmap");
});

maybe("objectives: a non-owner member cannot manage someone else's objective", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { requestAgentObjective } = await import("@/lib/agent-objective");
    const db = await getDb();
    const { companyMembers, users } = await getSchema();
    const { randomUUID } = await import("node:crypto");

    await requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "Owner's goal" });
    const [other] = await db.insert(users).values({ email: `o-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.insert(companyMembers).values({ companyId, userId: other.id, role: "member" });
    await assert.rejects(
        requestAgentObjective(companyId, other.id, dev.id, { action: "stop" }),
        /Access denied/,
    );
});

maybe("objectives: concurrent starts leave exactly one active objective", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { requestAgentObjective } = await import("@/lib/agent-objective");
    const db = await getDb();
    const { agentObjectives } = await getSchema();
    const { and, eq, inArray } = await import("drizzle-orm");

    const results = await Promise.allSettled([
        requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "First" }),
        requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "Second" }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    assert.equal(fulfilled.length, 1, "exactly one start wins");
    assert.equal(rejected.length, 1, "the loser is rejected");
    assert.match((rejected[0] as PromiseRejectedResult).reason.message, /already running/);

    const active = await db.select().from(agentObjectives).where(and(
        eq(agentObjectives.companyId, companyId),
        inArray(agentObjectives.status, ["active", "blocked", "paused"]),
    ));
    assert.equal(active.length, 1, "only one live objective row");
});

maybe("objectives: pausing cancels a queued prompt and the tick never posts after pause", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { requestAgentObjective, runObjectiveFollowups } = await import("@/lib/agent-objective");
    const db = await getDb();
    const { agentObjectives, threadMessages } = await getSchema();
    const { and, eq, sql } = await import("drizzle-orm");

    const started = await requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "Hold me", cadenceMinutes: 60 });
    await requestAgentObjective(companyId, userId, dev.id, { action: "pause" });

    // The queued start prompt is cancelled, not left to wake the agent later.
    const queued = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId),
        sql`${threadMessages.metadataJson}->>'objectiveId' = ${started.objective.id}`,
    ));
    assert.ok(queued.length >= 1);
    assert.ok(queued.every((m) => m.deliveryState === "cancelled"), "queued prompts are cancelled on pause");

    // Make it due anyway; the tick must not post for a paused objective.
    await db.update(agentObjectives).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(await runObjectiveFollowups(new Date()), 0);
});

maybe("objectives: any provider (mcp) manages its own objective through the bound token", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const other = await seedAgent(companyId, { name: "Other", provider: "mcp" });
    const { requestAgentObjective } = await import("@/lib/agent-objective");
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { makeRequest } = await import("./_helper");

    const started = await requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "Provider neutral" });
    await db.update(companyTokens).set({ agentId: dev.id }).where(eq(companyTokens.companyId, companyId));

    const route = await import("@/app/api/mcp/objectives/route");
    const headers = { authorization: `Bearer ${rawToken}` };
    const list = await route.GET(makeRequest("http://localhost/api/mcp/objectives", { headers }));
    assert.equal(list.status, 200);
    const listJson = await list.json();
    assert.equal(listJson.objective?.objective, "Provider neutral");

    const completed = await route.POST(makeRequest("http://localhost/api/mcp/objectives", {
        method: "POST", headers, body: { objectiveId: started.objective.id, action: "complete", completionSummary: "Shipped" },
    }));
    assert.equal(completed.status, 200);
    assert.equal((await completed.json()).objective.status, "completed");

    // Impersonating another agent is refused by token binding.
    const spoof = await route.GET(makeRequest(`http://localhost/api/mcp/objectives?agentId=${other.id}`, { headers }));
    assert.equal(spoof.status, 403);
});

async function seedObjectivePrompt(companyId: string, userId: string, agentId: string, objective: string) {
    const { requestAgentObjective } = await import("@/lib/agent-objective");
    const started = await requestAgentObjective(companyId, userId, agentId, { action: "start", objective, cadenceMinutes: 60 });
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { and, eq, sql } = await import("drizzle-orm");
    const [prompt] = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId),
        sql`${threadMessages.metadataJson}->>'objectiveId' = ${started.objective.id}`,
    )).limit(1);
    return { started, prompt };
}

maybe("tool-less completion: an agent reply marker completes its objective via /messages/send", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { started, prompt } = await seedObjectivePrompt(companyId, userId, dev.id, "Ship the build");
    const db = await getDb();
    const { companyTokens, threadMessages, chatMessages, agentObjectives } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    await db.update(companyTokens).set({ agentId: dev.id }).where(eq(companyTokens.companyId, companyId));

    const route = await import("@/app/api/mcp/messages/send/route");
    const res = await route.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}` },
        body: {
            agentId: dev.id,
            thread_id: prompt.threadId,
            replyToMessageId: prompt.id,
            text: `Shipped it.\nEMPEROR_OBJECTIVE_STATUS {"objectiveId":"${started.objective.id}","action":"complete","completionSummary":"Build shipped"}`,
        },
    }));
    assert.equal(res.status, 200);

    const [objective] = await db.select().from(agentObjectives).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(objective.status, "completed");
    assert.equal(objective.completionSummary, "Build shipped");

    // The marker is never visible chat text.
    const replies = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId),
        eq(threadMessages.senderType, "agent"),
    ));
    assert.equal(replies.length, 1);
    assert.equal(replies[0].text, "Shipped it.");
    assert.ok(!replies[0].text.includes("EMPEROR_OBJECTIVE_STATUS"));
    // The reserved control block is retained server-side, not as visible text.
    assert.equal((replies[0].metadataJson as Record<string, unknown>).__objectiveStatus instanceof Object, true);

    // The legacy mirror (chatMessages) also carries only sanitized text.
    const legacy = await db.select().from(chatMessages).where(eq(chatMessages.companyId, companyId));
    assert.ok(legacy.length >= 1);
    assert.ok(legacy.every((m) => !m.text.includes("EMPEROR_OBJECTIVE_STATUS")), "legacy mirror has no marker");
});

maybe("tool-less block: an agent reply marker via /threads/:id/messages pauses the objective", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { started, prompt } = await seedObjectivePrompt(companyId, userId, dev.id, "Ship the build");
    const db = await getDb();
    const { companyTokens, agentObjectives } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companyTokens).set({ agentId: dev.id }).where(eq(companyTokens.companyId, companyId));

    const route = await import("@/app/api/mcp/threads/[id]/messages/route");
    const res = await route.POST(makeRequest(`http://localhost/api/mcp/threads/${prompt.threadId}/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}` },
        body: {
            text: `Waiting on legal.\nEMPEROR_OBJECTIVE_STATUS {"objectiveId":"${started.objective.id}","action":"block","blockerReason":"Waiting on legal"}`,
            senderType: "agent",
            senderId: dev.id,
            metadataJson: { replyToMessageId: prompt.id },
        },
    }), { params: Promise.resolve({ id: prompt.threadId }) });
    assert.equal(res.status, 201);
    const json = await res.json();
    assert.ok(!String(json.message.text).includes("EMPEROR_OBJECTIVE_STATUS"));

    const [objective] = await db.select().from(agentObjectives).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(objective.status, "blocked");
    assert.equal(objective.blockerReason, "Waiting on legal");
});

maybe("tool-less markers: a wrong-agent marker, a mismatched thread and a source-less marker change nothing", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "mcp" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "mcp" });
    const { started, prompt } = await seedObjectivePrompt(companyId, userId, a.id, "Alpha's objective");
    const db = await getDb();
    const { companyTokens, agentObjectives, threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    await db.update(companyTokens).set({ agentId: b.id }).where(eq(companyTokens.companyId, companyId));
    const sendRoute = await import("@/app/api/mcp/messages/send/route");

    const marker = (action: string) => `ok\nEMPEROR_OBJECTIVE_STATUS {"objectiveId":"${started.objective.id}","action":"${action}","completionSummary":"nope"}`;

    // Wrong agent: B answers A's objective prompt — never mutates A's objective.
    const wrongAgent = await sendRoute.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` },
        body: { agentId: b.id, thread_id: prompt.threadId, replyToMessageId: prompt.id, text: marker("complete") },
    }));
    assert.equal(wrongAgent.status, 200);
    let [objective] = await db.select().from(agentObjectives).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(objective.status, "active", "a wrong-agent marker never completes another agent's objective");

    // Mismatched thread: B posts the marker into the team thread (not the answer thread).
    const { ensureTeamThread } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(companyId);
    const threadsRoute = await import("@/app/api/mcp/threads/[id]/messages/route");
    const mismatched = await threadsRoute.POST(makeRequest(`http://localhost/api/mcp/threads/${team.id}/messages`, {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` },
        body: { text: marker("complete"), senderType: "agent", senderId: b.id, metadataJson: { replyToMessageId: prompt.id } },
    }), { params: Promise.resolve({ id: team.id }) });
    assert.equal(mismatched.status, 201);
    [objective] = await db.select().from(agentObjectives).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(objective.status, "active", "a marker answered in another thread is ignored");

    // No source: A posts the marker with no replyToMessageId.
    await db.update(companyTokens).set({ agentId: a.id }).where(eq(companyTokens.companyId, companyId));
    const noSource = await sendRoute.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` },
        body: { agentId: a.id, thread_id: prompt.threadId, text: marker("complete") },
    }));
    assert.equal(noSource.status, 200);
    [objective] = await db.select().from(agentObjectives).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(objective.status, "active", "a marker with no source prompt is ignored");

    // Sanitized in every case, even when the marker was never authorized: the
    // control line must not survive in persisted/visible text.
    const agentMessages = await db.select().from(threadMessages).where(and(
        eq(threadMessages.companyId, companyId),
        eq(threadMessages.senderType, "agent"),
    ));
    assert.ok(agentMessages.length >= 3);
    assert.ok(agentMessages.every((m) => !m.text.includes("EMPEROR_OBJECTIVE_STATUS")), "no unauthorized marker is visible");
});

maybe("objectives: the sweep posts followups, dedupes overlaps and respects the budget", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "mcp" });
    const { requestAgentObjective, runObjectiveFollowups, updateObjectiveFromAgent } = await import("@/lib/agent-objective");
    const db = await getDb();
    const { agentObjectives, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");

    const started = await requestAgentObjective(companyId, userId, dev.id, { action: "start", objective: "Keep working", cadenceMinutes: 60 });

    // The start prompt is still queued, so the sweep must not stack another.
    assert.equal(await runObjectiveFollowups(new Date()), 0, "no followup while the start prompt is outstanding");

    // Mark the prompt resolved and make the objective due: the sweep posts once.
    await db.update(threadMessages).set({ deliveryState: "resolved" }).where(eq(threadMessages.companyId, companyId));
    await db.update(agentObjectives).set({ nextRunAt: new Date(Date.now() - 1000) }).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(await runObjectiveFollowups(new Date()), 1, "one due followup is posted");
    // A second immediate run is not due (nextRunAt advanced).
    assert.equal(await runObjectiveFollowups(new Date()), 0, "no duplicate followup on the next tick");

    // Budget exhaustion pauses the objective instead of spamming.
    await updateObjectiveFromAgent(companyId, dev.id, { objectiveId: started.objective.id, action: "pause" });
    await db.update(agentObjectives).set({ status: "active", followupCount: 20, maxFollowups: 20, nextRunAt: new Date(Date.now() - 1000) }).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(await runObjectiveFollowups(new Date()), 0);
    const [after] = await db.select().from(agentObjectives).where(eq(agentObjectives.id, started.objective.id));
    assert.equal(after.status, "paused");
    assert.match(after.blockerReason ?? "", /budget/i);
});
