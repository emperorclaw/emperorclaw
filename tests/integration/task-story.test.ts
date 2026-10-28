import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken, migrateLegacyMemberScopes } from "./_helper";

/**
 * The task page read side (slices 10.4–10.6): loadTaskStory merges task
 * events, approvals, files, linked messages and runs; it 404s (null) across
 * companies and outside a restricted member's scope; runs and messages from a
 * private chat the viewer is not in keep their place but lose their text,
 * thread and error; the live block carries the last useful action.
 */
const maybe = dbAvailable ? test : test.skip;

const MIN = 60_000;

async function seedStory() {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { eq } = await import("drizzle-orm");
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);

    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    const [scoped] = await db.insert(s.users).values({ email: `scoped-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Sam Scoped" }).returning();
    const [customerOnly] = await db.insert(s.users).values({ email: `cust-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await db.update(s.users).set({ displayName: "Olive Owner" }).where(eq(s.users.id, ownerId));
    await db.update(s.companies).set({ directChatMode: "private" }).where(eq(s.companies.id, companyId));

    const atlas = await seedAgent(companyId, { name: "Atlas", provider: "hermes" });
    const nova = await seedAgent(companyId, { name: "Nova", provider: "hermes" });

    const [harbor] = await db.insert(s.customers).values({ companyId, name: "Harbor Dental" }).returning();
    const [other] = await db.insert(s.customers).values({ companyId, name: "Other Co" }).returning();
    const [project] = await db.insert(s.projects).values({ companyId, customerId: harbor.id, goal: "Weekly reporting", status: "active" }).returning();
    const [otherProject] = await db.insert(s.projects).values({ companyId, customerId: other.id, goal: "Other work", status: "active" }).returning();

    await db.insert(s.companyMembers).values([
        { companyId, userId: ownerId, role: "owner" },
        { companyId, userId: scoped.id, role: "member", scopeJson: { mode: "restricted", agentIds: [atlas.id], customerIds: [harbor.id] } },
        { companyId, userId: customerOnly.id, role: "member", scopeJson: { mode: "restricted", agentIds: [], customerIds: [other.id] } },
    ]);
    await migrateLegacyMemberScopes();

    const [task] = await db.insert(s.tasks).values({
        companyId, projectId: project.id, taskType: "reporting", state: "review", assignedAgentId: atlas.id,
        inputJson: { title: "Friday status report", description: "Summarize the week" }, createdAt: ago(5 * 24 * 60 * MIN),
    }).returning();
    // Unassigned work for another customer.
    const [unassigned] = await db.insert(s.tasks).values({
        companyId, projectId: otherProject.id, taskType: "manual_task", inputJson: { title: "Loose end" },
    }).returning();
    // An internal project (no customer): hidden from every restricted member.
    const [internalProject] = await db.insert(s.projects).values({ companyId, goal: "Internal", status: "active" }).returning();
    const [internalTask] = await db.insert(s.tasks).values({ companyId, projectId: internalProject.id, taskType: "manual_task", assignedAgentId: atlas.id }).returning();

    await db.insert(s.taskEvents).values([
        { companyId, taskId: task.id, eventType: "task_generated", actorType: "system", payloadJson: { assignee: { type: "agent", id: atlas.id } }, createdAt: ago(5 * 24 * 60 * MIN) },
        { companyId, taskId: task.id, eventType: "task_note", actorType: "agent", actorId: atlas.id, payloadJson: { note: "Pulled the numbers", kind: "progress" }, createdAt: ago(3 * 60 * MIN) },
        { companyId, taskId: task.id, eventType: "task_review", actorType: "agent", actorId: atlas.id, payloadJson: { comment: "Ready" }, createdAt: ago(2 * 60 * MIN) },
    ]);

    // Approvals: one decided long ago, one still pending from run "succeeded-team".
    const [decided] = await db.insert(s.approvals).values({
        companyId, projectId: project.id, requesterAgentId: atlas.id, resolverUserId: ownerId, status: "approved",
        actionType: "send_email", rationale: "Send the draft", resolutionNote: "Go ahead", requestedAt: ago(4 * 24 * 60 * MIN), resolvedAt: ago(4 * 24 * 60 * MIN - MIN),
    }).returning();
    const [pending] = await db.insert(s.approvals).values({
        companyId, projectId: project.id, requesterAgentId: atlas.id, status: "pending", actionType: "task_done", requestedAt: ago(119 * MIN),
    }).returning();
    await db.insert(s.approvalTaskLinks).values([
        { companyId, approvalId: decided.id, taskId: task.id },
        { companyId, approvalId: pending.id, taskId: task.id },
    ]);

    await db.insert(s.artifacts).values({
        companyId, projectId: project.id, taskId: task.id, agentId: atlas.id, title: "status-report.md", kind: "report",
        contentType: "text/markdown", sha256: "x", sizeBytes: 2048, createdByType: "agent", createdById: atlas.id, createdAt: ago(100 * MIN),
    });

    const { ensureTeamThread, ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(companyId);
    const privateThread = await ensureDirectThread(companyId, atlas.id, ownerId);

    const teamReply = await appendThreadMessage({ companyId, threadId: team.id, senderType: "agent", senderId: atlas.id, text: "Report draft is ready for review" });
    const privateReply = await appendThreadMessage({ companyId, threadId: privateThread.id, senderType: "agent", senderId: atlas.id, text: "secret numbers for Olive" });
    // Replies are as old as the runs that wrote them (they are not progress for the live run).
    await db.update(s.threadMessages).set({ createdAt: ago(118 * MIN) }).where(eq(s.threadMessages.id, teamReply.id));
    await db.update(s.threadMessages).set({ createdAt: ago(89 * MIN) }).where(eq(s.threadMessages.id, privateReply.id));

    // A thread attached to the task, with one message.
    const [taskThread] = await db.insert(s.messageThreads).values({ companyId, type: "group", title: "Report review", taskId: task.id, createdByType: "human" }).returning();
    await appendThreadMessage({ companyId, threadId: taskThread.id, senderType: "human", senderId: ownerId, text: "Use the new chart style" });

    const run = async (values: Record<string, unknown>) => {
        const [row] = await db.insert(s.agentRuns).values({
            id: randomUUID(), companyId, agentId: atlas.id, runtimeKind: "hermes", triggerKind: "task", taskId: task.id, ...values,
        } as typeof s.agentRuns.$inferInsert).returning();
        return row;
    };
    const teamRun = await run({ threadId: team.id, status: "succeeded", replyMessageId: teamReply.id, startedAt: ago(125 * MIN), endedAt: ago(118 * MIN), durationMs: 7 * MIN, toolCalls: 12, inputTokens: 18_000, outputTokens: 900, costCents: 21, model: "deepseek-v4" });
    const privateRun = await run({ threadId: privateThread.id, status: "failed", error: "quoted secret numbers", replyMessageId: privateReply.id, startedAt: ago(90 * MIN), endedAt: ago(89 * MIN) });
    const stoppedRun = await run({ threadId: team.id, status: "cancelled", startedAt: ago(80 * MIN), endedAt: ago(79 * MIN) });
    const novaRun = await run({ agentId: nova.id, threadId: team.id, status: "succeeded", startedAt: ago(70 * MIN), endedAt: ago(69 * MIN) });
    const liveRun = await run({ threadId: privateThread.id, status: "running", startedAt: ago(30 * MIN) });
    await db.insert(s.agentRunEvents).values([
        { id: randomUUID(), companyId, runId: liveRun.id, agentId: atlas.id, threadId: privateThread.id, seq: 1, ts: ago(29 * MIN), kind: "tool.start", toolName: "web_search", summary: "secret query" },
        { id: randomUUID(), companyId, runId: liveRun.id, agentId: atlas.id, threadId: privateThread.id, seq: 2, ts: ago(25 * MIN), kind: "tool.end", toolName: "web_search", status: "ok", durationMs: 4 * MIN },
        { id: randomUUID(), companyId, runId: liveRun.id, agentId: atlas.id, threadId: privateThread.id, seq: 3, ts: ago(1 * MIN), kind: "reasoning", summary: "still thinking about secrets" },
    ]);

    // Another company with its own task.
    const otherCo = await seedCompanyWithToken();
    const [foreignProject] = await db.insert(s.projects).values({ companyId: otherCo.companyId, goal: "Theirs", status: "active" }).returning();
    const [foreignTask] = await db.insert(s.tasks).values({ companyId: otherCo.companyId, projectId: foreignProject.id, taskType: "x" }).returning();
    await db.insert(s.companyMembers).values({ companyId: otherCo.companyId, userId: otherCo.userId, role: "owner" });

    const { loadTaskViewer } = await import("@/lib/task-story-reads");
    return {
        companyId, task, unassigned, internalTask, otherProject, foreignTask, atlas, nova, teamRun, privateRun, stoppedRun, novaRun, liveRun, pending,
        owner: await loadTaskViewer(companyId, ownerId),
        scoped: await loadTaskViewer(companyId, scoped.id),
        customerOnly: await loadTaskViewer(companyId, customerOnly.id),
        foreignOwner: await loadTaskViewer(otherCo.companyId, otherCo.userId),
        otherCompanyId: otherCo.companyId,
    };
}

maybe("the owner sees one merged, newest-first story with every source", async () => {
    const t = await seedStory();
    const { loadTaskStory } = await import("@/lib/task-story-reads");
    const story = await loadTaskStory(t.companyId, t.task.id, t.owner);
    assert.ok(story);
    assert.equal(story.task.title, "Friday status report");
    assert.equal(story.task.customerName, "Harbor Dental");
    assert.deepEqual(story.task.owner, { type: "agent", id: t.atlas.id, name: "Atlas" });
    assert.equal(story.task.approval.pending, 1);
    assert.equal(story.task.approval.latest?.status, "approved");

    const kinds = new Set(story.entries.map((entry) => entry.kind));
    assert.deepEqual([...kinds].sort(), ["approval", "artifact", "event", "message", "run"]);
    const times = story.entries.map((entry) => Date.parse(entry.at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a), "newest first");

    // The live run is pinned, not in the list.
    assert.ok(!story.entries.some((entry) => entry.id === t.liveRun.id));
    assert.equal(story.live.runs.length, 1);
    assert.equal(story.live.runs[0].live.runId, t.liveRun.id);

    const runs = new Map(story.entries.flatMap((entry) => entry.kind === "run" ? [[entry.run.id, entry.run] as const] : []));
    // Outcomes: the team run left an approval pending → Needs you; failed; cancelled → Stopped.
    assert.equal(runs.get(t.teamRun.id)?.outcome, "needs_you");
    assert.equal(runs.get(t.privateRun.id)?.outcome, "failed");
    assert.equal(runs.get(t.stoppedRun.id)?.outcome, "stopped");
    assert.equal(runs.get(t.novaRun.id)?.outcome, "done");
    // Run ↔ reply: the reply rides on its run and is not repeated as a message entry.
    assert.equal(runs.get(t.teamRun.id)?.reply?.excerpt, "Report draft is ready for review");
    assert.equal(runs.get(t.teamRun.id)?.threadLabel, "Team chat");
    assert.ok(!story.entries.some((entry) => entry.kind === "message" && entry.text?.includes("Report draft")));
    // The owner is in their own private chat: nothing is redacted for them.
    assert.equal(runs.get(t.privateRun.id)?.private, false);
    assert.equal(runs.get(t.privateRun.id)?.error, "quoted secret numbers");
    assert.equal(runs.get(t.privateRun.id)?.reply?.excerpt, "secret numbers for Olive");

    // Approvals appear as request + decision.
    const approvalPhases = story.entries.filter((entry) => entry.kind === "approval").map((entry) => entry.kind === "approval" ? `${entry.actionType}:${entry.phase}` : "");
    assert.deepEqual(approvalPhases.sort(), ["send_email:decided", "send_email:requested", "task_done:requested"]);
    const message = story.entries.find((entry) => entry.kind === "message");
    assert.equal(message?.kind === "message" ? message.text : null, "Use the new chart style");
});

maybe("a scoped member sees the task but not another agent's runs, and private chats are redacted", async () => {
    const t = await seedStory();
    const { loadTaskStory, loadTaskLive } = await import("@/lib/task-story-reads");
    const story = await loadTaskStory(t.companyId, t.task.id, t.scoped);
    assert.ok(story, "Harbor Dental is in scope, so the task is visible");
    const runs = story.entries.flatMap((entry) => (entry.kind === "run" ? [entry.run] : []));
    assert.ok(!runs.some((run) => run.id === t.novaRun.id), "Nova is outside the member's agent scope");
    const privateRun = runs.find((run) => run.id === t.privateRun.id);
    assert.ok(privateRun);
    assert.equal(privateRun.private, true);
    assert.equal(privateRun.error, "Run failed");
    assert.equal(privateRun.reply?.excerpt, null);
    assert.equal(privateRun.threadHref, null);
    assert.equal(privateRun.threadLabel, "Private chat");
    assert.ok(!JSON.stringify(story).includes("secret"), "no private text anywhere in the payload");
    // A restricted member does not get the people list for reassigning.
    assert.deepEqual(story.assignees.members, []);
    assert.deepEqual(story.assignees.agents.map((agent) => agent.name), ["Atlas"]);

    const live = await loadTaskLive(t.companyId, t.task.id, t.scoped);
    assert.ok(live);
    assert.equal(live.runs[0].private, true);
    assert.equal(live.runs[0].live.current.summary, "Working in a private chat");
    assert.deepEqual(live.runs[0].live.steps, []);
});

maybe("out of scope, unassigned, foreign and malformed tasks read as missing", async () => {
    const t = await seedStory();
    const { loadTaskStory, loadTaskLive } = await import("@/lib/task-story-reads");
    assert.equal(await loadTaskStory(t.companyId, t.unassigned.id, t.scoped), null, "unassigned work for a customer outside the scope");
    assert.equal(await loadTaskStory(t.companyId, t.task.id, t.customerOnly), null, "another customer's task");
    assert.equal(await loadTaskLive(t.companyId, t.task.id, t.customerOnly), null);
    assert.equal(await loadTaskStory(t.companyId, t.internalTask.id, t.scoped), null, "internal project, even with the agent in scope");
    const loose = await loadTaskStory(t.companyId, t.unassigned.id, t.customerOnly);
    assert.ok(loose, "the customer-scoped member sees their customer's task");
    assert.deepEqual(loose.assignees.agents, [], "a member with no agents in scope cannot assign agents");
    assert.equal(await loadTaskStory(t.companyId, t.foreignTask.id, t.owner), null, "cross-company");
    assert.equal(await loadTaskStory(t.otherCompanyId, t.task.id, t.foreignOwner), null, "cross-company, the other way");
    assert.equal(await loadTaskStory(t.companyId, "not-a-uuid", t.owner), null);
    assert.ok(await loadTaskStory(t.companyId, t.unassigned.id, t.owner), "the owner sees unassigned work");
    // An admin is never scoped, even with a leftover restricted scope_json.
    const dbx = await getDb();
    const sx = await getSchema();
    const [admin] = await dbx.insert(sx.users).values({ email: `admin-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    await dbx.insert(sx.companyMembers).values({ companyId: t.companyId, userId: admin.id, role: "admin", scopeJson: { mode: "restricted", agentIds: [], customerIds: [] } });
    const { loadTaskViewer } = await import("@/lib/task-story-reads");
    assert.ok(await loadTaskStory(t.companyId, t.internalTask.id, await loadTaskViewer(t.companyId, admin.id)));

    const db = await getDb();
    const { tasks } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, t.unassigned.id));
    assert.equal(await loadTaskStory(t.companyId, t.unassigned.id, t.owner), null, "archived");
});

maybe("Load older pages through the story without gaps or repeats", async () => {
    const t = await seedStory();
    const { loadTaskStory } = await import("@/lib/task-story-reads");
    const full = await loadTaskStory(t.companyId, t.task.id, t.owner, { limit: 200 });
    assert.ok(full);
    const seen: string[] = [];
    let before: string | null = null;
    for (let i = 0; i < 20; i++) {
        const page = await loadTaskStory(t.companyId, t.task.id, t.owner, { limit: 3, before });
        assert.ok(page);
        assert.ok(page.entries.length <= 3);
        seen.push(...page.entries.map((entry) => `${entry.kind}:${entry.id}`));
        if (!page.hasMore) break;
        before = page.nextBefore;
    }
    assert.deepEqual(seen, full.entries.map((entry) => `${entry.kind}:${entry.id}`));
    assert.equal(new Set(seen).size, seen.length);
});

maybe("the live run's last useful action is its last tool end, and it reads as stalled", async () => {
    const t = await seedStory();
    const { loadStallSignals } = await import("@/lib/stall-signal-reads");
    const { loadTaskLive } = await import("@/lib/task-story-reads");
    const signals = await loadStallSignals(t.companyId, { taskIds: [t.task.id] });
    assert.equal(signals.length, 1);
    const [signal] = signals;
    assert.equal(signal.runId, t.liveRun.id);
    // tool.end 25 min ago; the reasoning beat 1 min ago does not count.
    assert.ok(signal.idleMs >= 24 * MIN && signal.idleMs < 27 * MIN, `idle ${signal.idleMs}`);
    assert.equal(signal.stalled, true);

    // A message from the agent after that is progress.
    const db = await getDb();
    const { threadMessages } = await getSchema();
    await db.insert(threadMessages).values({ companyId: t.companyId, threadId: t.liveRun.threadId!, senderType: "agent", senderId: t.atlas.id, text: "update", createdAt: new Date(Date.now() - 2 * MIN) });
    const [after] = await loadStallSignals(t.companyId, { runIds: [t.liveRun.id] });
    assert.equal(after.stalled, false);
    assert.equal((await loadStallSignals(t.companyId, { onlyStalled: true })).length, 0);
    assert.deepEqual(await loadStallSignals(t.companyId, { agentIds: [t.nova.id] }), []);
    assert.deepEqual(await loadStallSignals(t.companyId, { taskIds: [] }), []);

    const live = await loadTaskLive(t.companyId, t.task.id, t.owner);
    assert.equal(live?.runs[0].lastUsefulAt, after.lastUsefulAt);
});
