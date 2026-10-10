import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

async function seedProject(companyId: string, leadAgentId?: string | null) {
    const db = await getDb();
    const { projects } = await getSchema();
    const [project] = await db.insert(projects).values({ companyId, goal: "Team Launch", status: "active", leadAgentId: leadAgentId ?? null }).returning();
    return project;
}

async function syncFor(companyId: string, rawToken: string, agentId: string) {
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${agentId}`, { headers: { authorization: `Bearer ${rawToken}` } }));
    const json = await res.json();
    return json.messages ?? [];
}

/** Force a future assignment to flush immediately (coalescing sees an old wake). */
async function backdateWake(companyId: string, agentId: string) {
    const db = await getDb();
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`UPDATE agents SET metadata_json = COALESCE(metadata_json, '{}'::jsonb) || '{"agentWake": {"lastWakeAt": 0, "pending": []}}'::jsonb WHERE id = ${agentId} AND company_id = ${companyId}`);
}

maybe("wake-on-assignment: PM assigns Dev and QA; each sees a task_assigned wake", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const pm = await seedAgent(companyId, { name: "PM", provider: "hermes" });
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const qa = await seedAgent(companyId, { name: "QA", provider: "hermes" });
    const project = await seedProject(companyId, pm.id);

    const { createTaskForProject } = await import("@/lib/openclaw/tasks");
    const { task: devTask } = await createTaskForProject({
        companyId, projectId: project.id, taskType: "build",
        inputJson: { title: "Build login", acceptanceCriteria: "Sign-in works" },
        assignee: { type: "agent", id: dev.id },
        actorType: "agent", actorId: pm.id, source: "test",
    });
    assert.equal(devTask.assignedAgentId, dev.id);

    const devWakes = await syncFor(companyId, rawToken, dev.id);
    const devWake = devWakes.find((m) => m.routeReason === "task_assigned");
    assert.ok(devWake, "Dev should see a task_assigned wake");
    assert.equal(devWake.targetAgentId, dev.id);
    assert.equal(devWake.addressedToYou, true);
    assert.match(devWake.text, /Build login/);

    // Dev hands off to QA by creating + assigning a review task.
    const { task: qaTask } = await createTaskForProject({
        companyId, projectId: project.id, taskType: "review",
        inputJson: { title: "Review login", acceptanceCriteria: "Login passes QA" },
        assignee: { type: "agent", id: qa.id },
        actorType: "agent", actorId: dev.id, source: "test",
    });
    assert.equal(qaTask.assignedAgentId, qa.id);
    const qaWakes = await syncFor(companyId, rawToken, qa.id);
    const qaWake = qaWakes.find((m) => m.routeReason === "task_assigned" && m.text.includes("Review login"));
    assert.ok(qaWake, "QA should see its wake");
    assert.equal(qaWake.addressedToYou, true);
    assert.ok(qaWakes.every((m) => m.targetAgentId !== dev.id), "QA sees only its own wake");
});

maybe("reassignment to a DIFFERENT agent wakes it with reason reassigned", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const pm = await seedAgent(companyId, { name: "PM", provider: "hermes" });
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const qa = await seedAgent(companyId, { name: "QA", provider: "hermes" });
    const project = await seedProject(companyId, pm.id);

    const { createTaskForProject, updateTaskForCompany } = await import("@/lib/openclaw/tasks");
    const { task: devTask } = await createTaskForProject({
        companyId, projectId: project.id, taskType: "build", inputJson: { title: "Build login" },
        assignee: { type: "agent", id: dev.id }, actorType: "agent", actorId: pm.id, source: "test",
    });
    const { task: qaTask } = await createTaskForProject({
        companyId, projectId: project.id, taskType: "review", inputJson: { title: "Review login" },
        assignee: { type: "agent", id: qa.id }, actorType: "agent", actorId: dev.id, source: "test",
    });

    // Backdate QA's last wake so the reassignment flushes immediately (not
    // coalesced into the earlier review-task wake).
    await backdateWake(companyId, qa.id);
    const updated = await updateTaskForCompany({
        companyId, taskId: devTask.id, assignee: { type: "agent", id: qa.id },
        actorType: "agent", actorId: dev.id,
    });
    assert.equal(updated.status, 200);
    assert.equal((updated as { task?: { assignedAgentId: string | null } }).task?.assignedAgentId, qa.id);

    const qaWakes = await syncFor(companyId, rawToken, qa.id);
    const reassigned = qaWakes.find((m) => m.routeReason === "task_assigned" && (m.metadataJson as Record<string, unknown> | undefined)?.reason === "reassigned");
    assert.ok(reassigned, "QA sees the reassignment wake for the handoff");
    assert.equal(reassigned.addressedToYou, true);
    void qaTask;
});

maybe("no self-wake when an agent assigns a task to itself", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const project = await seedProject(companyId, null);

    const { createTaskForProject } = await import("@/lib/openclaw/tasks");
    await createTaskForProject({
        companyId, projectId: project.id, taskType: "build",
        inputJson: { title: "Self-assigned" },
        assignee: { type: "agent", id: dev.id },
        actorType: "agent", actorId: dev.id, source: "test",
    });

    const messages = await syncFor(companyId, rawToken, dev.id);
    assert.equal(messages.find((m) => m.routeReason === "task_assigned"), undefined, "no wake when assigning to yourself");
});

maybe("agent↔agent targeted messages land in a pair thread and replies reach the sender", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");

    const sent = await sendThreadMessageFromMcp({ companyId, text: "Can you review this?", agentId: a.id, targetAgentId: b.id });
    assert.ok(sent.ok);
    const pairThreadId = sent.threadId;

    const bMessages = await syncFor(companyId, rawToken, b.id);
    const forBeta = bMessages.find((m) => m.threadId === pairThreadId);
    assert.ok(forBeta, "Beta receives the pair message");
    assert.equal(forBeta.addressedToYou, true);
    // The old-runtime handoff keeps targetAgentId set (C8), not nulled.
    assert.equal(forBeta.targetAgentId, b.id);

    await sendThreadMessageFromMcp({ companyId, text: "Looks good to me", threadId: pairThreadId, agentId: b.id });
    const aMessages = await syncFor(companyId, rawToken, a.id);
    const reply = aMessages.find((m) => m.threadId === pairThreadId && m.text === "Looks good to me");
    assert.ok(reply, "Alpha receives Beta's reply in the same pair thread");
    assert.equal(reply.addressedToYou, true);
    assert.equal(reply.routeReason, "agent_pair");
});

maybe("multi-turn pair conversation stays in the pair thread and never leaks to an operator DM", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    const { ensureDirectThread } = await import("@/lib/control-plane");

    const first = await sendThreadMessageFromMcp({ companyId, text: "Alpha asks", agentId: a.id, targetAgentId: b.id });
    const pairThreadId = first.threadId;

    // Simulate a runtime that only echoes the message it is answering
    // (replyToMessageId) and does not repeat threadId/threadType/target. This is
    // the path that used to default an agent's reply to its own operator DM.
    const second = await sendThreadMessageFromMcp({ companyId, agentId: b.id, text: "Beta answers", replyToMessageId: first.messageId });
    assert.equal(second.threadId, pairThreadId, "the first reply is anchored to the pair thread");

    const third = await sendThreadMessageFromMcp({ companyId, agentId: a.id, text: "Alpha follows up", replyToMessageId: second.messageId });
    assert.equal(third.threadId, pairThreadId, "the second reply stays in the pair thread");

    // Check Beta's sync BEFORE Beta answers: once Beta has replied, the server
    // correctly suppresses Alpha's follow-up as already answered, so asserting
    // after the fourth reply would be checking the wrong thing.
    const bMessages = await syncFor(companyId, rawToken, b.id);
    const followUp = bMessages.find((m) => m.id === third.messageId);
    assert.ok(followUp, "Beta receives Alpha's follow-up in the pair thread");
    assert.equal(followUp.routeReason, "agent_pair");
    assert.equal(followUp.addressedToYou, true);

    const fourth = await sendThreadMessageFromMcp({ companyId, agentId: b.id, text: "Beta confirms", replyToMessageId: third.messageId });
    assert.equal(fourth.threadId, pairThreadId, "every subsequent turn stays in the pair thread");

    // Neither agent's private/operator DM received any agent-authored message.
    const aDm = await ensureDirectThread(companyId, a.id, null);
    const bDm = await ensureDirectThread(companyId, b.id, null);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { and, eq, inArray } = await import("drizzle-orm");
    const leaked = await db.select().from(threadMessages).where(and(
        inArray(threadMessages.threadId, [aDm.id, bDm.id]),
        eq(threadMessages.senderType, "agent"),
    ));
    assert.equal(leaked.length, 0, "no agent replies leaked into an operator DM");
});

maybe("an agent direct reply with no thread or target is refused, not defaulted to its own DM", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    await assert.rejects(
        sendThreadMessageFromMcp({ companyId, agentId: a.id, text: "into the void", threadType: "direct" }),
        /targetAgentId or threadId/,
    );
});

maybe("team-first peer send: a shared team is used, only the recipient is woken", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const c = await seedAgent(companyId, { name: "Gamma", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "agent", id: a.id }, { title: "Dev team", agentIds: [a.id, b.id, c.id] });
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");

    const sent = await sendThreadMessageFromMcp({ companyId, agentId: a.id, targetAgentId: b.id, text: "Please review the spec" });
    assert.equal(sent.threadId, group.id, "the shared team chat is used, not a private pair");

    const bMessages = await syncFor(companyId, rawToken, b.id);
    const forB = bMessages.find((m) => m.id === sent.messageId);
    assert.ok(forB, "Beta receives the team message");
    assert.equal(forB.addressedToYou, true);
    assert.equal(forB.routeReason, "mention", "the recipient is addressed by mention");
    assert.match(forB.text, /@Beta/, "the recipient is named in the team message");

    // The extra team member sees the message but is not addressed (not woken).
    const cMessages = await syncFor(companyId, rawToken, c.id);
    const forC = cMessages.find((m) => m.id === sent.messageId);
    assert.ok(forC, "Gamma receives the team message");
    assert.equal(forC.addressedToYou, false);
    assert.equal(forC.routeReason, "not_addressed");
});

maybe("team-first peer send: no shared team falls back to a private pair", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    const { isAgentPairThread } = await import("@/lib/groups");
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");

    const sent = await sendThreadMessageFromMcp({ companyId, agentId: a.id, targetAgentId: b.id, text: "hi" });
    const [thread] = await db.select().from(messageThreads).where(eq(messageThreads.id, sent.threadId));
    assert.ok(isAgentPairThread(thread), "with no shared team it stays a private pair");
});

maybe("team-first peer send: ambiguous teams require a choice or explicit private", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    await createGroup(companyId, { type: "agent", id: a.id }, { title: "Team One", agentIds: [a.id, b.id] });
    await createGroup(companyId, { type: "agent", id: a.id }, { title: "Team Two", agentIds: [a.id, b.id] });

    await assert.rejects(
        sendThreadMessageFromMcp({ companyId, agentId: a.id, targetAgentId: b.id, text: "quick q" }),
        /more than one team chat/,
        "an arbitrary team is never picked",
    );
    // Explicit private is always safe.
    const priv = await sendThreadMessageFromMcp({ companyId, agentId: a.id, targetAgentId: b.id, text: "quick q", private: true });
    const { isAgentPairThread } = await import("@/lib/groups");
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [thread] = await db.select().from(messageThreads).where(eq(messageThreads.id, priv.threadId));
    assert.ok(isAgentPairThread(thread), "private: true forces the pair thread");
});

maybe("team-first peer send: explicit private and explicit pair replies stay private", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { createGroup, isAgentPairThread } = await import("@/lib/groups");
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const group = await createGroup(companyId, { type: "agent", id: a.id }, { title: "Dev team", agentIds: [a.id, b.id] });

    const priv = await sendThreadMessageFromMcp({ companyId, agentId: a.id, targetAgentId: b.id, text: "private note", private: true });
    assert.notEqual(priv.threadId, group.id);
    const [pairThread] = await db.select().from(messageThreads).where(eq(messageThreads.id, priv.threadId));
    assert.ok(isAgentPairThread(pairThread), "explicit private uses the pair thread");

    // A reply with the pair thread id stays in the pair thread.
    const reply = await sendThreadMessageFromMcp({ companyId, agentId: b.id, threadId: priv.threadId, text: "acknowledged" });
    assert.equal(reply.threadId, priv.threadId, "an explicit pair reply stays pair");
});

maybe("team-first peer send: posting to a team you are not a member of is denied", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const c = await seedAgent(companyId, { name: "Gamma", provider: "hermes" });
    const { createGroup } = await import("@/lib/groups");
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    const group = await createGroup(companyId, { type: "agent", id: b.id }, { title: "Others", agentIds: [b.id, c.id] });

    await assert.rejects(
        sendThreadMessageFromMcp({ companyId, agentId: a.id, threadId: group.id, text: "let me in" }),
        /not a member/,
    );
    // A member sender still cannot address a recipient who is not in the group.
    const shared = await createGroup(companyId, { type: "agent", id: a.id }, { title: "Shared", agentIds: [a.id, c.id] });
    await assert.rejects(
        sendThreadMessageFromMcp({ companyId, agentId: a.id, threadId: shared.id, targetAgentId: b.id, text: "hey B" }),
        /recipient is not a member/,
    );
});

maybe("loop guard trips on agent ping-pong in a pair thread", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");

    // A pair thread uses the pair cap (EMPEROR_AGENT_PAIR_LOOP_MAX_TURNS), not the room cap.
    const oldCap = process.env.EMPEROR_AGENT_PAIR_LOOP_MAX_TURNS;
    process.env.EMPEROR_AGENT_PAIR_LOOP_MAX_TURNS = "2";
    try {
        const sent = await sendThreadMessageFromMcp({ companyId, text: "ping", agentId: b.id, targetAgentId: a.id });
        const threadId = sent.threadId;
        await sendThreadMessageFromMcp({ companyId, text: "ping 2", threadId, agentId: b.id });
        await sendThreadMessageFromMcp({ companyId, text: "ping 3", threadId, agentId: b.id });

        const messages = await syncFor(companyId, rawToken, a.id);
        const inThread = messages.filter((m) => m.threadId === threadId);
        // Pick the third agent ping itself: tripping the guard also posts a
        // system "Paused" notice, which is the newest message in the thread.
        const third = inThread.find((m) => m.text === "ping 3");
        assert.ok(third, "Alpha sees the third ping");
        assert.equal(third.routeReason, "loop_paused", "the third consecutive agent message is loop-paused");
        assert.equal(third.addressedToYou, false);
        assert.ok(inThread.some((m) => m.senderType === "system" && /^Paused:/.test(m.text)), "one pause notice is posted");
    } finally {
        if (oldCap === undefined) delete process.env.EMPEROR_AGENT_PAIR_LOOP_MAX_TURNS;
        else process.env.EMPEROR_AGENT_PAIR_LOOP_MAX_TURNS = oldCap;
    }
});

maybe("forged taskAssigned metadata is stripped and never bypasses the loop guard", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { ensureDirectThread } = await import("@/lib/control-plane");

    const thread = await ensureDirectThread(companyId, b.id, null);
    const route = await import("@/app/api/mcp/threads/[id]/messages/route");

    // An agent posting with taskAssigned metadata targeting another agent.
    const res = await route.POST(
        makeRequest(`http://localhost/api/mcp/threads/${thread.id}/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${rawToken}` },
            body: { text: "you have work", senderType: "agent", senderId: a.id, targetAgentId: b.id, metadataJson: { taskAssigned: true, note: "keep-me" } },
        }),
        { params: Promise.resolve({ id: thread.id }) },
    );
    assert.equal(res.status, 201);
    const json = await res.json();
    const stored = json.message.metadataJson as Record<string, unknown>;
    assert.equal(stored.taskAssigned, undefined, "reserved taskAssigned flag is stripped");
    assert.equal(stored.note, "keep-me", "non-reserved metadata is preserved");

    const bMessages = await syncFor(companyId, rawToken, b.id);
    const forged = bMessages.find((m) => m.id === json.message.id);
    assert.ok(forged, "Beta sees the message");
    assert.notEqual(forged.routeReason, "task_assigned", "a forged flag never yields a task_assigned verdict");

    // A system sender is reserved for server code: MCP callers are rejected.
    const sysRes = await route.POST(
        makeRequest(`http://localhost/api/mcp/threads/${thread.id}/messages`, {
            method: "POST",
            headers: { authorization: `Bearer ${rawToken}` },
            body: { text: "fake system", senderType: "system", senderId: a.id, targetAgentId: b.id },
        }),
        { params: Promise.resolve({ id: thread.id }) },
    );
    assert.equal(sysRes.status, 403);
});

maybe("forged pair markers are rejected and never reused as a pair thread", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });

    const { createGroup, GroupError, ensureAgentPairThread } = await import("@/lib/groups");
    // A user/agent cannot stamp the reserved marker onto an ordinary group.
    await assert.rejects(
        createGroup(companyId, { type: "agent", id: a.id }, { title: "Sneaky", description: "agent-pair", agentIds: [a.id, b.id] }),
        (err: unknown) => err instanceof GroupError && err.status === 400,
        "the reserved description is rejected",
    );

    // Even a group that somehow carries the marker but was NOT created by the
    // system is not treated as a pair thread.
    const db = await getDb();
    const { messageThreads, threadParticipants } = await getSchema();
    const [forged] = await db.insert(messageThreads).values({
        companyId, type: "group", title: "forged", description: "agent-pair", createdByType: "agent",
    }).returning();
    await db.insert(threadParticipants).values([
        { threadId: forged.id, companyId, participantType: "agent", participantId: a.id, role: "member" },
        { threadId: forged.id, companyId, participantType: "agent", participantId: b.id, role: "member" },
    ]);

    const real = await ensureAgentPairThread(companyId, a.id, b.id);
    assert.notEqual(real.id, forged.id, "a non-system-created marker group is never reused");
    assert.equal(real.createdByType, "system");
});

maybe("stall sweep nudges a stale task once and does not spam", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const project = await seedProject(companyId, null);
    const db = await getDb();
    const { tasks, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");

    const old = new Date(Date.now() - 10 * 3600_000);
    const [task] = await db.insert(tasks).values({
        companyId, projectId: project.id, taskType: "work", state: "in_progress",
        assignedAgentId: dev.id, inputJson: { title: "Stale work" }, updatedAt: old,
    }).returning();

    const { runStallSweep } = await import("@/lib/stall-sweep");
    assert.equal(await runStallSweep(), 1);

    const nudges = await db.select().from(threadMessages).where(eq(threadMessages.targetAgentId, dev.id));
    assert.equal(nudges.length, 1);
    assert.equal((nudges[0].metadataJson as Record<string, unknown>).stallNudge, true);

    // A second sweep right away does nothing (deduped).
    assert.equal(await runStallSweep(), 0);
    void task;
});

maybe("stall sweep coalesces many stale tasks and ignores abandoned backlog", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const project = await seedProject(companyId, null);
    const db = await getDb();
    const { tasks, threadMessages } = await getSchema();

    const recentStale = new Date(Date.now() - 10 * 3600_000);
    const abandoned = new Date(Date.now() - 30 * 24 * 3600_000);
    await db.insert(tasks).values([
        { companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: dev.id, inputJson: { title: "Stale 1" }, updatedAt: recentStale },
        { companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: dev.id, inputJson: { title: "Stale 2" }, updatedAt: recentStale },
        { companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: dev.id, inputJson: { title: "Abandoned" }, updatedAt: abandoned },
    ]);

    const { eq } = await import("drizzle-orm");
    const { runStallSweep } = await import("@/lib/stall-sweep");
    assert.equal(await runStallSweep(), 1, "two stale tasks coalesce into one nudge");

    const nudges = await db.select().from(threadMessages).where(eq(threadMessages.targetAgentId, dev.id));
    assert.equal(nudges.length, 1, "ONE message per agent per sweep");
    const meta = nudges[0].metadataJson as Record<string, unknown>;
    assert.equal(meta.stallNudge, true);
    assert.equal((meta.taskIds as string[]).length, 2, "the abandoned backlog task is never nudged");
});

maybe("blocked tasks keep their reason, are not nudged, and unblocking restarts the clock", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const project = await seedProject(companyId, null);
    const db = await getDb();
    const { tasks, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { updateTaskForCompany } = await import("@/lib/openclaw/tasks");
    const { runStallSweep } = await import("@/lib/stall-sweep");

    const old = new Date(Date.now() - 10 * 3600_000);
    const [task] = await db.insert(tasks).values({
        companyId, projectId: project.id, taskType: "work", state: "in_progress",
        assignedAgentId: dev.id, inputJson: { title: "Held work" }, updatedAt: old,
    }).returning();

    // Blocking without a reason is rejected.
    const missing = await updateTaskForCompany({ companyId, taskId: task.id, state: "blocked" });
    assert.equal(missing.status, 400);

    const blocked = await updateTaskForCompany({
        companyId, taskId: task.id, state: "blocked", blockedReason: "Waiting on legal sign-off",
        actorType: "human",
    });
    assert.equal(blocked.status, 200);
    const blockedTask = (blocked as { task: { state: string; inputJson: Record<string, unknown> } }).task;
    assert.equal(blockedTask.state, "blocked");
    assert.equal(blockedTask.inputJson.blockedReason, "Waiting on legal sign-off");

    // A blocked task is not treated as stalled work.
    assert.equal(await runStallSweep(), 0, "blocked tasks receive no stall nudge");
    const nudges = await db.select().from(threadMessages).where(eq(threadMessages.targetAgentId, dev.id));
    assert.equal(nudges.length, 0);

    // Unblocking clears the reason and restarts the progress clock (updatedAt=now),
    // so the stale-10h task is not immediately eligible for a nudge again.
    const unblockedAt = Date.now();
    const unblocked = await updateTaskForCompany({
        companyId, taskId: task.id, state: "in_progress", actorType: "human",
    });
    assert.equal(unblocked.status, 200);
    const unblockedTask = (unblocked as { task: { state: string; inputJson: Record<string, unknown>; updatedAt: Date | string } }).task;
    assert.equal(unblockedTask.state, "in_progress");
    assert.equal(unblockedTask.inputJson.blockedReason, undefined, "the blocker reason is cleared on unblock");
    assert.ok(new Date(unblockedTask.updatedAt).getTime() >= unblockedAt - 1000, "unblocking restarts updatedAt");
    assert.equal(await runStallSweep(), 0, "a freshly unblocked task is not stale");
});

maybe("PM→Dev→QA: the full handoff closes with both tasks done", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const pm = await seedAgent(companyId, { name: "PM", provider: "hermes" });
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const qa = await seedAgent(companyId, { name: "QA", provider: "hermes" });
    const project = await seedProject(companyId, pm.id);

    const { createTaskForProject, finalizeTaskForAgent } = await import("@/lib/openclaw/tasks");
    const { task: devTask } = await createTaskForProject({
        companyId, projectId: project.id, taskType: "build", inputJson: { title: "Ship feature" },
        assignee: { type: "agent", id: dev.id }, actorType: "agent", actorId: pm.id, source: "test",
    });
    const { task: qaTask } = await createTaskForProject({
        companyId, projectId: project.id, taskType: "review", inputJson: { title: "Verify feature" },
        assignee: { type: "agent", id: qa.id }, actorType: "agent", actorId: dev.id, source: "test",
    });

    await finalizeTaskForAgent({ companyId, taskId: devTask.id, agentId: dev.id, state: "done", comment: "Shipped, see the artifact" });
    await finalizeTaskForAgent({ companyId, taskId: qaTask.id, agentId: qa.id, state: "done", comment: "Verified" });

    const db = await getDb();
    const { tasks } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [d] = await db.select().from(tasks).where(eq(tasks.id, devTask.id));
    const [q] = await db.select().from(tasks).where(eq(tasks.id, qaTask.id));
    assert.equal(d.state, "done");
    assert.equal(q.state, "done");
});

maybe("W1/W2: legacy companies get the new doctrine; fresh companies get no suggestion", async () => {
    await resetDb();
    const { seedStarterKnowledge, upgradeStarterDoctrine, renderLegacyStarterNote } = await import("@/lib/starter-knowledge");

    // Legacy company: only the old HEAD agent-operating-rules note exists, with
    // no stored doctrine version.
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { scopedResources } = await getSchema();
    await db.insert(scopedResources).values({
        companyId, scopeType: "company", provider: "knowledge", resourceType: "knowledge_base",
        name: "agent-operating-rules", displayName: "Agent Operating Rules", path: "Agents",
        configText: renderLegacyStarterNote("agent-operating-rules", 3, "Test Co")!,
        status: "active", ownership: "managed", isShared: true,
    });
    const result = await upgradeStarterDoctrine({ companyId, companyName: "Test Co" });
    assert.ok(result.updated >= 1, "the unedited legacy note is updated to the new doctrine");
    assert.equal(result.suggestions, 0, "no edited notes, no suggestion");

    // Fresh company: seeding marks it current, so the upgrade is a no-op.
    const { companyId: freshId } = await seedCompanyWithToken();
    await seedStarterKnowledge({ companyId: freshId, companyName: "Fresh Co" });
    const fresh = await upgradeStarterDoctrine({ companyId: freshId, companyName: "Fresh Co" });
    assert.equal(fresh.suggestions, 0, "fresh company never sees a bogus doctrine suggestion");
});

maybe("W3-seed: re-saving a legacy company's onboarding profile still upgrades its notes", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { scopedResources } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { renderLegacyStarterNote, renderStarterNote, seedStarterKnowledge, upgradeStarterDoctrine } = await import("@/lib/starter-knowledge");

    // A legacy company that still has the old HEAD agent-operating-rules note.
    await db.insert(scopedResources).values({
        companyId, scopeType: "company", provider: "knowledge", resourceType: "knowledge_base",
        name: "agent-operating-rules", displayName: "Agent Operating Rules", path: "Agents",
        configText: renderLegacyStarterNote("agent-operating-rules", 3, "Test Co")!,
        status: "active", ownership: "managed", isShared: true,
    });

    // Re-saving the profile must NOT stamp the legacy note as doctrine-current:
    // it must run the upgrade, so the old note is replaced by the current text.
    await seedStarterKnowledge({ companyId, companyName: "Test Co" });

    const [rule] = await db.select().from(scopedResources)
        .where(eq(scopedResources.name, "agent-operating-rules")).limit(1);
    assert.equal(rule.configText, renderStarterNote("agent-operating-rules", "Test Co"));

    // And the subsequent upgrade sweep is a no-op (already current).
    const again = await upgradeStarterDoctrine({ companyId, companyName: "Test Co" });
    assert.equal(again.suggestions, 0);
});

maybe("W3: addTaskNote enforces project scope and caps the note at 4000 chars", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const dev = await seedAgent(companyId, { name: "Dev", provider: "hermes" });
    const project = await seedProject(companyId, null);
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { createTaskForProject, addTaskNote, TASK_NOTE_MAX_CHARS } = await import("@/lib/openclaw/tasks");

    const { task } = await createTaskForProject({
        companyId, projectId: project.id, taskType: "build", inputJson: { title: "Scoped note" }, actorType: "system",
    });

    // A restricted agent scoped elsewhere cannot annotate this task.
    await db.update(agents).set({ scopeJson: { mode: "restricted", projectIds: ["00000000-0000-0000-0000-000000000000"] } }).where(eq(agents.id, dev.id));
    await assert.rejects(
        addTaskNote({ companyId, taskId: task.id, note: "out of scope", actorAgentId: dev.id }),
        /outside this agent's scope/,
    );

    // Unrestricted: the note text is truncated to the cap.
    await db.update(agents).set({ scopeJson: {} }).where(eq(agents.id, dev.id));
    const event = await addTaskNote({ companyId, taskId: task.id, note: "x".repeat(TASK_NOTE_MAX_CHARS + 500), actorAgentId: dev.id });
    const stored = (event.payloadJson as { note?: string } | null)?.note ?? "";
    assert.equal(stored.length, TASK_NOTE_MAX_CHARS);
});

maybe("W7: a token bound to an agent cannot impersonate another agent in task notes", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const project = await seedProject(companyId, null);
    const { createTaskForProject } = await import("@/lib/openclaw/tasks");
    const { task } = await createTaskForProject({ companyId, projectId: project.id, taskType: "build", inputJson: { title: "Bound note" }, actorType: "system" });

    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companyTokens).set({ agentId: a.id }).where(eq(companyTokens.companyId, companyId));

    const route = await import("@/app/api/mcp/tasks/[id]/notes/route");
    const headers = { authorization: `Bearer ${rawToken}` };
    const post = (body: unknown) => route.POST(
        makeRequest(`http://localhost/api/mcp/tasks/${task.id}/notes`, { method: "POST", headers: { ...headers, "Idempotency-Key": `k-${Math.random()}` }, body }),
        { params: Promise.resolve({ id: task.id }) },
    );

    // With no agentId, the bound agent acts for itself.
    const own = await post({ note: "mine" });
    assert.equal(own.status, 200);
    assert.equal((await own.json()).event.actorId, a.id);

    // A mismatched body agentId is rejected (no impersonation).
    const impersonate = await post({ note: "spoof", agentId: b.id });
    assert.equal(impersonate.status, 403);
});

maybe("W-threads: a bound agent token cannot list another agent's pair threads", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });

    const { ensureAgentPairThread } = await import("@/lib/groups");
    const pair = await ensureAgentPairThread(companyId, a.id, b.id);

    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companyTokens).set({ agentId: a.id }).where(eq(companyTokens.companyId, companyId));

    const route = await import("@/app/api/mcp/threads/route");
    const headers = { authorization: `Bearer ${rawToken}` };

    // No agentId → the bound agent sees its own pair thread.
    const own = await route.GET(makeRequest("http://localhost/api/mcp/threads", { headers }));
    assert.equal(own.status, 200);
    const ownJson = await own.json();
    assert.ok(ownJson.threads.some((t: { id: string }) => t.id === pair.id), "the bound agent sees its own pair thread");

    // agentId=B (a different agent) → rejected, not an empty/snooped listing.
    const other = await route.GET(makeRequest(`http://localhost/api/mcp/threads?agentId=${b.id}`, { headers }));
    assert.equal(other.status, 403);
});

maybe("stall reminders respect workspace opt-out, concurrent monitors and recipient cooldown", async()=>{
    await resetDb();const {companyId}=await seedCompanyWithToken();const owner=await seedAgent(companyId,{name:"Owner"});const project=await seedProject(companyId);
    const db=await getDb();const {tasks,companies,threadMessages}=await getSchema();const {eq}=await import("drizzle-orm");
    const stale=new Date(Date.now()-5*3600_000);
    await db.insert(tasks).values({companyId,projectId:project.id,taskType:"work",state:"in_progress",assignedAgentId:owner.id,updatedAt:stale});
    await db.update(companies).set({agentRoutineJson:{stallRemindersEnabled:false}}).where(eq(companies.id,companyId));
    const {runStallSweep}=await import("@/lib/stall-sweep");assert.equal(await runStallSweep(),0,"Disabled workspace receives no reminders or escalations");
    await db.update(companies).set({agentRoutineJson:{enabled:false,stallRemindersEnabled:true}}).where(eq(companies.id,companyId));
    const counts=await Promise.all([runStallSweep(),runStallSweep()]);assert.equal(counts.reduce((a,b)=>a+b,0),1,"Only one concurrent monitor posts the batch");
    await db.insert(tasks).values({companyId,projectId:project.id,taskType:"work",state:"in_progress",assignedAgentId:owner.id,updatedAt:stale});
    assert.equal(await runStallSweep(),0,"New stale tasks wait for the recipient cooldown instead of another message");
    const messages=await db.select().from(threadMessages).where(eq(threadMessages.targetAgentId,owner.id));assert.equal(messages.length,1);
    assert.equal(messages[0].senderType,"system");
});

maybe("chat polling uses UTC column encoding for the since cursor", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Reader", provider: "hermes" });
    const { ensureTeamThread, getThreadMessages } = await import("@/lib/control-plane");
    const thread = await ensureTeamThread(companyId);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const at = new Date("2026-10-09T12:00:00Z");
    await db.insert(threadMessages).values({ companyId, threadId: thread.id, senderType: "agent", senderId: agent.id, text: "UTC update", createdAt: at });
    const oldTZ = process.env.TZ;
    try {
        process.env.TZ = "Europe/Bratislava";
        assert.equal((await getThreadMessages(companyId, thread.id, 25, new Date(at.getTime() - 1000))).length, 1);
    } finally {
        if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ;
    }
});

maybe("answered-message suppression is timezone-safe and keeps a queued follow-up", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { ensureAgentPairThread } = await import("@/lib/groups");
    const thread = await ensureAgentPairThread(companyId, a.id, b.id);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const asked = new Date("2026-10-09T12:00:00Z");
    const answered = new Date("2026-10-09T12:00:05Z");
    await db.insert(threadMessages).values([
        // Beta's question, already answered by Alpha below.
        { companyId, threadId: thread.id, senderType: "agent", senderId: b.id, targetAgentId: a.id, text: "question", createdAt: asked },
        { companyId, threadId: thread.id, senderType: "agent", senderId: a.id, text: "answer", createdAt: answered },
        // A queued direct follow-up must survive suppression (and keeps the
        // sync from long-polling, so the test is fast).
        { companyId, threadId: thread.id, senderType: "system", targetAgentId: a.id, text: "followup", deliveryState: "queued", createdAt: asked },
    ]);

    const oldTZ = process.env.TZ;
    try {
        // A non-UTC host used to mis-decode the MAX(created_at) aggregate and
        // re-deliver the answered message.
        process.env.TZ = "Europe/Bratislava";
        const messages = await syncFor(companyId, rawToken, a.id);
        assert.equal(messages.find((m) => m.text === "question"), undefined, "answered message stays suppressed off-UTC");
        assert.ok(messages.find((m) => m.text === "followup"), "a queued follow-up is still delivered");
    } finally {
        if (oldTZ === undefined) delete process.env.TZ; else process.env.TZ = oldTZ;
    }
});

maybe("a peer message that arrives while the agent is busy is queued, not swallowed by the reply", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const a = await seedAgent(companyId, { name: "Alpha", provider: "hermes" });
    const b = await seedAgent(companyId, { name: "Beta", provider: "hermes" });
    const { ensureAgentPairThread } = await import("@/lib/groups");
    const thread = await ensureAgentPairThread(companyId, a.id, b.id);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const first = new Date("2026-10-10T18:48:17Z");
    const during = new Date("2026-10-10T18:52:51Z");
    const reply = new Date("2026-10-10T18:54:42Z");

    // The runtime is serial: Beta asks at 18:48, Alpha answers it at 18:54, and
    // Beta's 18:52 message lands between the answered message and the reply.
    // Keying suppression on the reply instant dropped it; keying on the answered
    // message keeps it queued so the next poll delivers it.
    const [firstQuestion] = await db.insert(threadMessages).values({
        companyId, threadId: thread.id, senderType: "agent", senderId: b.id, targetAgentId: a.id, text: "first", createdAt: first,
    }).returning();
    await db.insert(threadMessages).values([
        { companyId, threadId: thread.id, senderType: "agent", senderId: a.id, text: "answer", createdAt: reply, metadataJson: { replyToMessageId: firstQuestion.id } },
        { companyId, threadId: thread.id, senderType: "agent", senderId: b.id, targetAgentId: a.id, text: "while-busy", createdAt: during },
        // A queued follow-up keeps sync from long-polling.
        { companyId, threadId: thread.id, senderType: "system", targetAgentId: a.id, text: "followup", deliveryState: "queued", createdAt: reply },
    ]);

    const messages = await syncFor(companyId, rawToken, a.id);
    assert.equal(messages.find((m) => m.text === "first"), undefined, "the answered message stays suppressed");
    assert.ok(messages.find((m) => m.text === "while-busy"), "a message that arrived during the turn is queued, not dropped");
});
