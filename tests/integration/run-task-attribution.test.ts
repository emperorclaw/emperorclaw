import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken, migrateLegacyMemberScopes } from "./_helper";

/**
 * Run → task attribution (src/lib/run-task-attribution*.ts): a run started by
 * a SYSTEM "New task assigned to you" notice gets that task (an agent's or a
 * person's message never does, whatever its metadata says); a run that
 * finishes with no task gets the task its agent acted on during the run,
 * unless another run of that agent overlaps it; a task id the runtime sends is
 * kept only when valid; nothing is ever attributed across companies, outside
 * the run agent's data scope, or over a task already set. The backfill script
 * applies the same rules (dry run by default). And the Timeline's Projects
 * view / "Where the time went" built from attributed runs respect a restricted
 * member's scope and never include another person's private-chat runs.
 */
const maybe = dbAvailable ? test : test.skip;
const MIN = 60_000;
const DAY = 86_400_000;

async function tokenForAgent(companyId: string, agentId: string): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, agentId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: `agent-${agentId}`, scope: "mcp_full",
    });
    return raw;
}

async function startRun(rawToken: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/mcp/agents/runs/route");
    return route.POST(makeRequest("http://localhost/api/mcp/agents/runs", { method: "POST", headers: { authorization: `Bearer ${rawToken}` }, body }));
}

async function finishRun(rawToken: string, id: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/mcp/agents/runs/[id]/route");
    return route.PATCH(
        makeRequest(`http://localhost/api/mcp/agents/runs/${id}`, { method: "PATCH", headers: { authorization: `Bearer ${rawToken}` }, body }),
        { params: Promise.resolve({ id }) },
    );
}

async function runRow(id: string) {
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, id));
    return row;
}

/** A company with one agent (and its bound token), a team thread, a project and tasks. */
async function seedCompany(name = "Builder") {
    const db = await getDb();
    const s = await getSchema();
    const { companyId, userId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name });
    const token = await tokenForAgent(companyId, agent.id);
    const [thread] = await db.insert(s.messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const [project] = await db.insert(s.projects).values({ companyId, goal: "Stayolo", status: "active" }).returning();
    const task = async (title: string, extra: Record<string, unknown> = {}) => {
        const [row] = await db.insert(s.tasks).values({ companyId, projectId: project.id, taskType: "work", assignedAgentId: agent.id, inputJson: { title }, ...extra }).returning();
        return row;
    };
    return { companyId, userId, agent, token, thread, project, task };
}

async function taskNotice(companyId: string, threadId: string, agentId: string, metadataJson: Record<string, unknown>) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const [message] = await db.insert(threadMessages).values({
        companyId, threadId, senderType: "system", targetAgentId: agentId, text: "New task assigned to you: [Stayolo hotfix](emperor://task/x)", metadataJson,
    }).returning();
    return message;
}

async function agentEvent(companyId: string, taskId: string, agentId: string, at: Date, eventType = "task_note") {
    const db = await getDb();
    const { taskEvents } = await getSchema();
    await db.insert(taskEvents).values({ companyId, taskId, eventType, actorType: "agent", actorId: agentId, payloadJson: { note: "progress" }, createdAt: at });
}

maybe("a run started by a 'New task assigned' notice gets that task", async () => {
    await resetDb();
    const c = await seedCompany();
    const hotfix = await c.task("Stayolo hotfix");
    const message = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [hotfix.id], reason: "assigned" });

    const id = randomUUID();
    const res = await startRun(c.token, { id, agentId: c.agent.id, runtimeKind: "hermes", triggerKind: "message", triggerMessageId: message.id });
    assert.equal(res.status, 200);
    const body = await res.json() as { run: { taskId: string | null } };
    assert.equal(body.run.taskId, hotfix.id);
    assert.equal((await runRow(id)).taskId, hotfix.id);

    // Through the events endpoint's run header too (shares insertRunStart).
    const events = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const id2 = randomUUID();
    const evRes = await events.POST(
        makeRequest(`http://localhost/api/mcp/agents/runs/${id2}/events`, {
            method: "POST",
            headers: { authorization: `Bearer ${c.token}` },
            body: { run: { id: id2, agentId: c.agent.id, triggerKind: "message", triggerMessageId: message.id }, events: [] },
        }),
        { params: Promise.resolve({ id: id2 }) },
    );
    assert.ok(evRes.status < 300, `events header start: ${evRes.status}`);
    assert.equal((await runRow(id2)).taskId, hotfix.id);
});

maybe("a notice about several tasks, a deleted task or a runtime-supplied task never misattributes", async () => {
    await resetDb();
    const c = await seedCompany();
    const a = await c.task("A");
    const b = await c.task("B");
    const gone = await c.task("Gone", { deletedAt: new Date() });

    const several = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [a.id, b.id] });
    const id1 = randomUUID();
    await startRun(c.token, { id: id1, agentId: c.agent.id, triggerKind: "message", triggerMessageId: several.id });
    assert.equal((await runRow(id1)).taskId, null, "ambiguous notice attributes nothing");

    const deleted = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [gone.id] });
    const id2 = randomUUID();
    await startRun(c.token, { id: id2, agentId: c.agent.id, triggerKind: "message", triggerMessageId: deleted.id });
    assert.equal((await runRow(id2)).taskId, null, "a deleted task is not live");

    const single = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [a.id] });
    const id3 = randomUUID();
    await startRun(c.token, { id: id3, agentId: c.agent.id, triggerKind: "message", triggerMessageId: single.id, taskId: b.id });
    assert.equal((await runRow(id3)).taskId, b.id, "the runtime's own task id wins");
});

maybe("a cross-company task id in the trigger metadata is ignored", async () => {
    await resetDb();
    const mine = await seedCompany();
    const theirs = await seedCompany("Foreign");
    const foreignTask = await theirs.task("Their task");
    const message = await taskNotice(mine.companyId, mine.thread.id, mine.agent.id, { taskAssigned: true, taskIds: [foreignTask.id] });

    const id = randomUUID();
    const res = await startRun(mine.token, { id, agentId: mine.agent.id, triggerKind: "message", triggerMessageId: message.id, startedAt: new Date(Date.now() - 10 * MIN).toISOString() });
    assert.equal(res.status, 200);
    assert.equal((await runRow(id)).taskId, null);

    // And the other company's task activity can never be picked at finish either.
    await agentEvent(mine.companyId, foreignTask.id, mine.agent.id, new Date(Date.now() - 5 * MIN));
    await finishRun(mine.token, id, { status: "succeeded" });
    assert.equal((await runRow(id)).taskId, null);
    // Another company's message cannot be used as a trigger at all.
    const foreignMessage = await taskNotice(theirs.companyId, theirs.thread.id, theirs.agent.id, { taskAssigned: true, taskIds: [foreignTask.id] });
    const id2 = randomUUID();
    await startRun(mine.token, { id: id2, agentId: mine.agent.id, triggerKind: "message", triggerMessageId: foreignMessage.id });
    const row2 = await runRow(id2);
    assert.ok(!row2 || row2.taskId === null);
});

async function postAsAgent(rawToken: string, threadId: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/mcp/threads/[id]/messages/route");
    return route.POST(
        makeRequest(`http://localhost/api/mcp/threads/${threadId}/messages`, { method: "POST", headers: { authorization: `Bearer ${rawToken}` }, body }),
        { params: Promise.resolve({ id: threadId }) },
    );
}

/** A company whose agent is restricted to one customer, with a task inside and one outside its scope. */
async function seedScopedCompany() {
    const db = await getDb();
    const s = await getSchema();
    const c = await seedCompany("Scoped");
    const [mineCustomer, otherCustomer] = await db.insert(s.customers).values([
        { companyId: c.companyId, name: "Harbor Dental" },
        { companyId: c.companyId, name: "Other Co" },
    ]).returning();
    const [inProject] = await db.insert(s.projects).values({ companyId: c.companyId, customerId: mineCustomer.id, goal: "Harbor site", status: "active" }).returning();
    const [outProject] = await db.insert(s.projects).values({ companyId: c.companyId, customerId: otherCustomer.id, goal: "Other site", status: "active" }).returning();
    const { eq } = await import("drizzle-orm");
    await db.update(s.agents).set({ scopeJson: { mode: "restricted", customerIds: [mineCustomer.id] } }).where(eq(s.agents.id, c.agent.id));
    const [inTask] = await db.insert(s.tasks).values({ companyId: c.companyId, projectId: inProject.id, taskType: "work", assignedAgentId: c.agent.id, inputJson: { title: "In scope" } }).returning();
    const [outTask] = await db.insert(s.tasks).values({ companyId: c.companyId, projectId: outProject.id, taskType: "work", assignedAgentId: c.agent.id, inputJson: { title: "Out of scope" } }).returning();
    return { ...c, inTask, outTask };
}

maybe("an agent's (or a person's) message naming a task never attributes; only a system notice does", async () => {
    await resetDb();
    const c = await seedCompany();
    const target = await c.task("Target");
    const db = await getDb();
    const { threadMessages } = await getSchema();

    // Through the real MCP post route: the reserved keys are stripped on write.
    const posted = await postAsAgent(c.token, c.thread.id, { text: "working on it", senderType: "agent", metadataJson: { taskId: target.id, taskIds: [target.id], note: "keep-me" } });
    assert.equal(posted.status, 201);
    const stored = (await posted.json() as { message: { id: string; metadataJson: Record<string, unknown> } }).message;
    assert.equal(stored.metadataJson.taskId, undefined, "taskId is stripped from an agent's post");
    assert.equal(stored.metadataJson.taskIds, undefined, "taskIds is stripped from an agent's post");
    assert.equal(stored.metadataJson.note, "keep-me");
    const viaRoute = randomUUID();
    await startRun(c.token, { id: viaRoute, agentId: c.agent.id, triggerKind: "message", triggerMessageId: stored.id });
    assert.equal((await runRow(viaRoute)).taskId, null);

    // Even a row that carries the keys (older data, another writer) is never
    // trusted unless it is a system notice: agent and human senders attribute nothing.
    for (const senderType of ["agent", "human"]) {
        const [forged] = await db.insert(threadMessages).values({
            companyId: c.companyId, threadId: c.thread.id, senderType, senderId: senderType === "agent" ? c.agent.id : c.userId,
            targetAgentId: c.agent.id, text: "New task assigned to you", metadataJson: { taskAssigned: true, taskIds: [target.id] },
        }).returning();
        const id = randomUUID();
        const res = await startRun(c.token, { id, agentId: c.agent.id, triggerKind: "message", triggerMessageId: forged.id });
        assert.equal(res.status, 200);
        assert.equal((await runRow(id)).taskId, null, `a ${senderType} message is never trusted`);
    }

    // The genuine system notice (as task-wake writes it) does attribute.
    const notice = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [target.id], reason: "assigned" });
    const id = randomUUID();
    await startRun(c.token, { id, agentId: c.agent.id, triggerKind: "message", triggerMessageId: notice.id });
    assert.equal((await runRow(id)).taskId, target.id);
});

maybe("the real task-wake notice is a system message carrying the task id, and attributes its run", async () => {
    await resetDb();
    const c = await seedCompany();
    const task = await c.task("Woken");
    const { wakeAgentOnTaskAssignment } = await import("@/lib/task-wake");
    await wakeAgentOnTaskAssignment({ companyId: c.companyId, task, reason: "assigned", assignedByLabel: "Owner" });
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [wake] = await db.select().from(threadMessages).where(and(eq(threadMessages.companyId, c.companyId), eq(threadMessages.targetAgentId, c.agent.id)));
    assert.ok(wake, "the wake was posted");
    assert.equal(wake.senderType, "system");
    assert.deepEqual((wake.metadataJson as { taskIds?: string[] }).taskIds, [task.id]);
    const id = randomUUID();
    await startRun(c.token, { id, agentId: c.agent.id, triggerKind: "message", triggerMessageId: wake.id });
    assert.equal((await runRow(id)).taskId, task.id);
});

maybe("a task outside the run agent's scope is never attributed: not by the notice, the activity, or an explicit id", async () => {
    await resetDb();
    const c = await seedScopedCompany();
    const now = Date.now();

    // (a) a system notice naming the out-of-scope task.
    const outNotice = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [c.outTask.id] });
    const byNotice = randomUUID();
    await startRun(c.token, { id: byNotice, agentId: c.agent.id, triggerKind: "message", triggerMessageId: outNotice.id, startedAt: new Date(now - 60 * MIN).toISOString() });
    assert.equal((await runRow(byNotice)).taskId, null, "rule (a) respects the agent's scope");
    await finishRun(c.token, byNotice, { status: "succeeded", endedAt: new Date(now - 58 * MIN).toISOString() });
    const inNotice = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [c.inTask.id] });
    const byInNotice = randomUUID();
    await startRun(c.token, { id: byInNotice, agentId: c.agent.id, triggerKind: "message", triggerMessageId: inNotice.id, startedAt: new Date(now - 50 * MIN).toISOString() });
    assert.equal((await runRow(byInNotice)).taskId, c.inTask.id, "an in-scope notice still attributes");
    await finishRun(c.token, byInNotice, { status: "succeeded", endedAt: new Date(now - 45 * MIN).toISOString() });

    // (c) the agent acted mostly on the out-of-scope task during the run.
    const byActivity = randomUUID();
    await startRun(c.token, { id: byActivity, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 30 * MIN).toISOString() });
    for (let i = 0; i < 4; i++) await agentEvent(c.companyId, c.outTask.id, c.agent.id, new Date(now - 25 * MIN));
    await agentEvent(c.companyId, c.inTask.id, c.agent.id, new Date(now - 24 * MIN));
    const finished = await finishRun(c.token, byActivity, { status: "succeeded", endedAt: new Date(now - 20 * MIN).toISOString() });
    assert.equal(finished.status, 200);
    assert.equal((await runRow(byActivity)).taskId, c.inTask.id, "rule (c) only counts in-scope tasks");
    const onlyOut = randomUUID();
    await startRun(c.token, { id: onlyOut, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 15 * MIN).toISOString() });
    await agentEvent(c.companyId, c.outTask.id, c.agent.id, new Date(now - 12 * MIN));
    await finishRun(c.token, onlyOut, { status: "succeeded", endedAt: new Date(now - 10 * MIN).toISOString() });
    assert.equal((await runRow(onlyOut)).taskId, null, "only out-of-scope activity attributes nothing");

    // Explicit task id from the runtime: dropped (the start still succeeds), in-scope kept.
    const explicitOut = randomUUID();
    const res = await startRun(c.token, { id: explicitOut, agentId: c.agent.id, triggerKind: "task", taskId: c.outTask.id });
    assert.equal(res.status, 200, "an invalid task id never fails the start");
    assert.equal(((await res.json()) as { run: { taskId: string | null } }).run.taskId, null);
    assert.equal((await runRow(explicitOut)).taskId, null);
    const explicitIn = randomUUID();
    await startRun(c.token, { id: explicitIn, agentId: c.agent.id, triggerKind: "task", taskId: c.inTask.id });
    assert.equal((await runRow(explicitIn)).taskId, c.inTask.id);
    // A deleted task and another company's task are dropped the same way.
    const gone = await c.task("Gone", { deletedAt: new Date() });
    const foreign = await (await seedCompany("Foreign")).task("Theirs");
    for (const taskId of [gone.id, foreign.id]) {
        const id = randomUUID();
        const r = await startRun(c.token, { id, agentId: c.agent.id, triggerKind: "task", taskId });
        assert.equal(r.status, 200);
        assert.equal((await runRow(id)).taskId, null);
    }
    // Through the events endpoint's run header (shares insertRunStart).
    const events = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const viaHeader = randomUUID();
    const evRes = await events.POST(
        makeRequest(`http://localhost/api/mcp/agents/runs/${viaHeader}/events`, {
            method: "POST",
            headers: { authorization: `Bearer ${c.token}` },
            body: { run: { id: viaHeader, agentId: c.agent.id, triggerKind: "task", taskId: c.outTask.id }, events: [] },
        }),
        { params: Promise.resolve({ id: viaHeader }) },
    );
    assert.ok(evRes.status < 300, `events header start: ${evRes.status}`);
    assert.equal((await runRow(viaHeader)).taskId, null);
});

maybe("rule (c) is skipped while another run of the same agent overlaps the window", async () => {
    await resetDb();
    const c = await seedCompany();
    const work = await c.task("Work");
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const now = Date.now();

    // Two concurrent runs of the same agent; the task events fall inside both.
    const first = randomUUID();
    const second = randomUUID();
    await startRun(c.token, { id: first, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 30 * MIN).toISOString() });
    await startRun(c.token, { id: second, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 25 * MIN).toISOString() });
    await agentEvent(c.companyId, work.id, c.agent.id, new Date(now - 22 * MIN));
    await finishRun(c.token, first, { status: "succeeded", endedAt: new Date(now - 20 * MIN).toISOString() });
    await finishRun(c.token, second, { status: "succeeded", endedAt: new Date(now - 15 * MIN).toISOString() });
    assert.equal((await runRow(first)).taskId, null, "overlapping: the events cannot be split between the runs");
    assert.equal((await runRow(second)).taskId, null);

    // Back to back (no overlap) attributes again; so does an overlap with a `lost`
    // run only, or with another agent's run.
    const alone = randomUUID();
    await startRun(c.token, { id: alone, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 15 * MIN).toISOString() });
    await agentEvent(c.companyId, work.id, c.agent.id, new Date(now - 12 * MIN));
    await db.insert(agentRuns).values({ id: randomUUID(), companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", status: "lost", startedAt: new Date(now - 14 * MIN), endedAt: new Date(now - 1 * MIN) });
    const otherAgent = await seedAgent(c.companyId, { name: "Other" });
    await db.insert(agentRuns).values({ id: randomUUID(), companyId: c.companyId, agentId: otherAgent.id, triggerKind: "message", status: "succeeded", startedAt: new Date(now - 14 * MIN), endedAt: new Date(now - 11 * MIN) });
    await finishRun(c.token, alone, { status: "succeeded", endedAt: new Date(now - 10 * MIN).toISOString() });
    assert.equal((await runRow(alone)).taskId, work.id);

    // A still-running run of the same agent overlaps too.
    const open = randomUUID();
    await startRun(c.token, { id: open, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 9 * MIN).toISOString() });
    const during = randomUUID();
    await startRun(c.token, { id: during, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 8 * MIN).toISOString() });
    await agentEvent(c.companyId, work.id, c.agent.id, new Date(now - 7 * MIN));
    await finishRun(c.token, during, { status: "succeeded", endedAt: new Date(now - 6 * MIN).toISOString() });
    assert.equal((await runRow(during)).taskId, null);
});

maybe("the backfill applies the same trust, scope and overlap rules", async () => {
    await resetDb();
    const c = await seedScopedCompany();
    const db = await getDb();
    const { agentRuns, threadMessages } = await getSchema();
    const now = Date.now();
    const [agentSent] = await db.insert(threadMessages).values({
        companyId: c.companyId, threadId: c.thread.id, senderType: "agent", senderId: c.agent.id, targetAgentId: c.agent.id, text: "x", metadataJson: { taskIds: [c.inTask.id] },
    }).returning();
    const outNotice = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [c.outTask.id] });
    const inNotice = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [c.inTask.id] });
    const ids = { agentSent: randomUUID(), outNotice: randomUUID(), inNotice: randomUUID(), outActivity: randomUUID(), overlapA: randomUUID(), overlapB: randomUUID(), inActivity: randomUUID() };
    const at = (m: number) => new Date(now - m * MIN);
    await db.insert(agentRuns).values([
        { id: ids.agentSent, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", triggerMessageId: agentSent.id, status: "succeeded", startedAt: at(200), endedAt: at(199) },
        { id: ids.outNotice, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", triggerMessageId: outNotice.id, status: "succeeded", startedAt: at(190), endedAt: at(189) },
        { id: ids.inNotice, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", triggerMessageId: inNotice.id, status: "succeeded", startedAt: at(180), endedAt: at(179) },
        { id: ids.outActivity, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", status: "succeeded", startedAt: at(170), endedAt: at(160) },
        { id: ids.overlapA, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", status: "succeeded", startedAt: at(150), endedAt: at(140) },
        { id: ids.overlapB, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", status: "succeeded", startedAt: at(145), endedAt: at(135) },
        { id: ids.inActivity, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", status: "succeeded", startedAt: at(120), endedAt: at(110) },
    ]);
    await agentEvent(c.companyId, c.outTask.id, c.agent.id, at(165));
    await agentEvent(c.companyId, c.inTask.id, c.agent.id, at(142));
    await agentEvent(c.companyId, c.inTask.id, c.agent.id, at(115));

    const { backfillRunTasks } = await import("@/lib/run-task-attribution-store");
    const dry = await backfillRunTasks({ execute: false, companyId: c.companyId });
    assert.deepEqual(dry, { scanned: 7, trigger_metadata: 1, task_events: 1, unresolved: 5, written: 0 });
    const wet = await backfillRunTasks({ execute: true, companyId: c.companyId });
    assert.equal(wet.written, 2);
    assert.equal((await runRow(ids.agentSent)).taskId, null, "an agent-sent trigger is never trusted");
    assert.equal((await runRow(ids.outNotice)).taskId, null, "an out-of-scope notice attributes nothing");
    assert.equal((await runRow(ids.inNotice)).taskId, c.inTask.id);
    assert.equal((await runRow(ids.outActivity)).taskId, null, "out-of-scope activity attributes nothing");
    assert.equal((await runRow(ids.overlapA)).taskId, null, "overlapping runs are skipped");
    assert.equal((await runRow(ids.overlapB)).taskId, null);
    assert.equal((await runRow(ids.inActivity)).taskId, c.inTask.id);
});

maybe("a run that finishes with no task gets the task its agent acted on most", async () => {
    await resetDb();
    const c = await seedCompany();
    const main = await c.task("Main");
    const side = await c.task("Side");
    const removed = await c.task("Removed", { deletedAt: new Date() });
    const now = Date.now();

    const id = randomUUID();
    await startRun(c.token, { id, agentId: c.agent.id, triggerKind: "message", startedAt: new Date(now - 10 * MIN).toISOString() });
    assert.equal((await runRow(id)).taskId, null);
    await agentEvent(c.companyId, main.id, c.agent.id, new Date(now - 8 * MIN), "task_claimed");
    await agentEvent(c.companyId, main.id, c.agent.id, new Date(now - 6 * MIN), "task_note");
    await agentEvent(c.companyId, side.id, c.agent.id, new Date(now - 2 * MIN), "task_note");
    for (let i = 0; i < 5; i++) await agentEvent(c.companyId, removed.id, c.agent.id, new Date(now - 4 * MIN));
    // Outside the window, and by someone else: never counted.
    for (let i = 0; i < 5; i++) await agentEvent(c.companyId, side.id, c.agent.id, new Date(now - 60 * MIN));
    const db = await getDb();
    const { taskEvents } = await getSchema();
    for (let i = 0; i < 5; i++) await db.insert(taskEvents).values({ companyId: c.companyId, taskId: side.id, eventType: "task_note", actorType: "human", actorId: c.userId, createdAt: new Date(now - 3 * MIN) });

    const res = await finishRun(c.token, id, { status: "succeeded", endedAt: new Date(now).toISOString() });
    assert.equal(res.status, 200);
    const body = await res.json() as { run: { taskId: string | null } };
    assert.equal(body.run.taskId, main.id);
    assert.equal((await runRow(id)).taskId, main.id);

    // A run that already has a task keeps it.
    const id2 = randomUUID();
    await startRun(c.token, { id: id2, agentId: c.agent.id, triggerKind: "task", taskId: side.id, startedAt: new Date(now - 10 * MIN).toISOString() });
    await finishRun(c.token, id2, { status: "succeeded", endedAt: new Date(now).toISOString() });
    assert.equal((await runRow(id2)).taskId, side.id);
});

maybe("the backfill script dry-runs by default and writes with --execute", async () => {
    await resetDb();
    const c = await seedCompany();
    const other = await seedCompany("Other");
    const hotfix = await c.task("Hotfix");
    const audit = await c.task("Audit");
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const now = Date.now();
    const notice = await taskNotice(c.companyId, c.thread.id, c.agent.id, { taskAssigned: true, taskIds: [hotfix.id] });
    const byNotice = randomUUID();
    const byEvents = randomUUID();
    const nothing = randomUUID();
    const alreadySet = randomUUID();
    const old = randomUUID();
    const foreign = randomUUID();
    await db.insert(agentRuns).values([
        { id: byNotice, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", triggerMessageId: notice.id, status: "succeeded", startedAt: new Date(now - 50 * MIN), endedAt: new Date(now - 45 * MIN) },
        { id: byEvents, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", status: "succeeded", startedAt: new Date(now - 30 * MIN), endedAt: new Date(now - 20 * MIN) },
        { id: nothing, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", status: "succeeded", startedAt: new Date(now - 15 * MIN), endedAt: new Date(now - 14 * MIN) },
        { id: alreadySet, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", triggerMessageId: notice.id, taskId: audit.id, status: "succeeded", startedAt: new Date(now - 12 * MIN), endedAt: new Date(now - 11 * MIN) },
        { id: old, companyId: c.companyId, agentId: c.agent.id, triggerKind: "message", triggerMessageId: notice.id, status: "succeeded", startedAt: new Date(now - 3 * DAY), endedAt: new Date(now - 3 * DAY + MIN) },
        { id: foreign, companyId: other.companyId, agentId: other.agent.id, triggerKind: "message", status: "succeeded", startedAt: new Date(now - 30 * MIN), endedAt: new Date(now - 20 * MIN) },
    ]);
    await agentEvent(c.companyId, audit.id, c.agent.id, new Date(now - 25 * MIN));
    const since = new Date(now - DAY).toISOString();

    const script = (args: string[]) => {
        const result = spawnSync("npx", ["tsx", "scripts/backfill-run-tasks.ts", ...args], {
            env: { ...process.env },
            encoding: "utf8",
            shell: process.platform === "win32",
            timeout: 120_000,
        });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout.slice(result.stdout.indexOf("{"))) as {
            dryRun: boolean; scanned: number; byRule: { trigger_metadata: number; task_events: number }; unresolved: number; written: number;
        };
    };

    const dry = script(["--company", c.companyId, "--since", since]);
    assert.equal(dry.dryRun, true);
    assert.equal(dry.scanned, 3, "only task-less runs of the company since --since");
    assert.deepEqual(dry.byRule, { trigger_metadata: 1, task_events: 1 });
    assert.equal(dry.unresolved, 1);
    assert.equal(dry.written, 0);
    assert.equal((await runRow(byNotice)).taskId, null, "a dry run writes nothing");

    const wet = script(["--company", c.companyId, "--since", since, "--execute"]);
    assert.equal(wet.dryRun, false);
    assert.equal(wet.written, 2);
    assert.equal((await runRow(byNotice)).taskId, hotfix.id);
    assert.equal((await runRow(byEvents)).taskId, audit.id);
    assert.equal((await runRow(nothing)).taskId, null);
    assert.equal((await runRow(alreadySet)).taskId, audit.id, "an already set task is never changed");
    assert.equal((await runRow(old)).taskId, null, "--since is respected");
    assert.equal((await runRow(foreign)).taskId, null, "--company is respected");

    // In-process, with small batches, the same function picks up the older run.
    const { backfillRunTasks } = await import("@/lib/run-task-attribution-store");
    const counts = await backfillRunTasks({ execute: true, companyId: c.companyId, batchSize: 1 });
    assert.equal(counts.scanned, 2, "nothing and old remain task-less");
    assert.equal(counts.trigger_metadata, 1);
    assert.equal((await runRow(old)).taskId, hotfix.id);
});

maybe("the Projects view and time summary respect a restricted member's scope and private chats", async () => {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { eq } = await import("drizzle-orm");
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);
    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    await db.update(s.companies).set({ directChatMode: "private" }).where(eq(s.companies.id, companyId));
    await db.insert(s.companyMembers).values({ companyId, userId: ownerId, role: "owner" });
    const builder = await seedAgent(companyId, { name: "Builder" });
    const token = await tokenForAgent(companyId, builder.id);

    const [harbor, other] = await db.insert(s.customers).values([{ companyId, name: "Harbor Dental" }, { companyId, name: "Other Co" }]).returning();
    const [inScope] = await db.insert(s.projects).values({ companyId, customerId: harbor.id, goal: "Harbor site", status: "active" }).returning();
    const [outScope] = await db.insert(s.projects).values({ companyId, customerId: other.id, goal: "Secret project", status: "active" }).returning();
    const [taskIn] = await db.insert(s.tasks).values({ companyId, projectId: inScope.id, taskType: "work", assignedAgentId: builder.id, inputJson: { title: "Harbor hotfix" } }).returning();
    const [taskOut] = await db.insert(s.tasks).values({ companyId, projectId: outScope.id, taskType: "work", assignedAgentId: builder.id, inputJson: { title: "Secret task" } }).returning();

    const [scopedUser] = await db.insert(s.users).values({ email: `scoped-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Sam" }).returning();
    await db.insert(s.companyMembers).values({ companyId, userId: scopedUser.id, role: "member", scopeJson: { mode: "restricted", agentIds: [builder.id], customerIds: [harbor.id] } });
    await migrateLegacyMemberScopes();
    const [otherUser] = await db.insert(s.users).values({ email: `other-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Olive" }).returning();
    await db.insert(s.companyMembers).values({ companyId, userId: otherUser.id, role: "member" });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const otherThread = await ensureDirectThread(companyId, builder.id, otherUser.id);
    const [team] = await db.insert(s.messageThreads).values({ companyId, type: "team", title: "Team" }).returning();

    // Both task runs are attributed by the real start path (a task-assigned notice each).
    for (const [task, startedMs] of [[taskIn, 50 * MIN], [taskOut, 40 * MIN]] as const) {
        const notice = await taskNotice(companyId, team.id, builder.id, { taskAssigned: true, taskIds: [task.id] });
        const id = randomUUID();
        await startRun(token, { id, agentId: builder.id, triggerKind: "message", triggerMessageId: notice.id, startedAt: ago(startedMs).toISOString() });
        await finishRun(token, id, { status: "succeeded", endedAt: ago(startedMs - 5 * MIN).toISOString(), costCents: 20 });
        assert.equal((await runRow(id)).taskId, task.id);
    }
    // A chat run in the other person's private thread, and one in the team thread.
    const privateChat = randomUUID();
    const teamChat = randomUUID();
    await db.insert(s.agentRuns).values([
        { id: privateChat, companyId, agentId: builder.id, threadId: otherThread.id, triggerKind: "message", status: "succeeded", startedAt: ago(20 * MIN), endedAt: ago(10 * MIN) },
        { id: teamChat, companyId, agentId: builder.id, threadId: team.id, triggerKind: "message", status: "succeeded", startedAt: ago(9 * MIN), endedAt: ago(8 * MIN) },
    ]);

    const { loadTaskViewer } = await import("@/lib/task-story-reads");
    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const { groupTimelineByProject, summarizeTimeSpent, CHAT_ROW_ID } = await import("@/lib/work-timeline");
    const window = { fromMs: now - DAY, toMs: now, nowMs: now };

    const scopedTl = await loadWorkTimeline(companyId, await loadTaskViewer(companyId, scopedUser.id), window);
    const scopedRows = groupTimelineByProject(scopedTl);
    const projectRows = scopedRows.filter((r) => r.kind === "project");
    assert.deepEqual(projectRows.map((r) => r.projectId), [inScope.id], "only the in-scope project");
    assert.equal(projectRows[0].name, "Harbor site");
    assert.equal(projectRows[0].customerName, "Harbor Dental");
    const scopedChat = scopedRows.find((r) => r.id === CHAT_ROW_ID);
    assert.ok(!scopedChat?.spans.some((sp) => sp.id === privateChat), "another person's private chat never appears");
    const scopedSummary = summarizeTimeSpent(scopedTl);
    assert.deepEqual(scopedSummary.tasks.map((t) => t.title), ["Harbor hotfix"]);
    assert.ok(!JSON.stringify({ scopedRows, scopedSummary }).includes("Secret"), "no out-of-scope name leaks");
    assert.ok(!JSON.stringify({ scopedRows, scopedSummary }).includes(privateChat));

    // The owner sees both projects and the team chat, but still not Olive's private chat.
    const ownerTl = await loadWorkTimeline(companyId, await loadTaskViewer(companyId, ownerId), window);
    const ownerRows = groupTimelineByProject(ownerTl);
    assert.deepEqual(new Set(ownerRows.filter((r) => r.kind === "project").map((r) => r.projectId)), new Set([inScope.id, outScope.id]));
    const ownerChat = ownerRows.find((r) => r.id === CHAT_ROW_ID);
    assert.ok(ownerChat, "the chat row is last");
    assert.equal(ownerRows[ownerRows.length - 1].id, CHAT_ROW_ID);
    assert.deepEqual(ownerChat.spans.map((sp) => sp.id), [teamChat]);
    const ownerSummary = summarizeTimeSpent(ownerTl);
    assert.equal(ownerSummary.chat.runs, 1);
    assert.equal(ownerSummary.projects.length, 2);

    // Olive sees her own private chat in the chat row.
    const oliveRows = groupTimelineByProject(await loadWorkTimeline(companyId, await loadTaskViewer(companyId, otherUser.id), window));
    assert.ok(oliveRows.find((r) => r.id === CHAT_ROW_ID)?.spans.some((sp) => sp.id === privateChat));
});
