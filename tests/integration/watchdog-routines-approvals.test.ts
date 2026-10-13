import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

async function seedOwner(companyId: string) {
    const db = await getDb();
    const { users, companyMembers } = await getSchema();
    const [user] = await db.insert(users).values({ email: `owner-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Owner" }).returning();
    await db.insert(companyMembers).values({ companyId, userId: user.id, role: "owner" });
    return user.id;
}

async function seedTask(companyId: string, agentId: string, title: string, state = "in_progress") {
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "work", state, assignedAgentId: agentId, inputJson: { title } }).returning();
    return task;
}

maybe("silent agents go offline, and owners hear about it when work is waiting", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const owner = await seedOwner(companyId);
    const old = new Date(Date.now() - 30 * 60_000);
    const busy = await seedAgent(companyId, { name: "Busy", status: "online", lastSeenAt: old, createdAt: old });
    const idle = await seedAgent(companyId, { name: "Idle", status: "online", lastSeenAt: old, createdAt: old });
    const fresh = await seedAgent(companyId, { name: "Fresh", status: "online", lastSeenAt: new Date() });
    await seedTask(companyId, busy.id, "Ship the landing page");

    const { markSilentAgentsOffline, touchAgentLiveness } = await import("@/lib/lifecycle");
    assert.equal(await markSilentAgentsOffline(), 2);
    const db = await getDb();
    const { agents, notifications } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const status = async (id: string) => (await db.select().from(agents).where(eq(agents.id, id)))[0].status;
    assert.equal(await status(busy.id), "offline");
    assert.equal(await status(idle.id), "offline");
    assert.equal(await status(fresh.id), "online");
    const inbox = await db.select().from(notifications).where(eq(notifications.userId, owner));
    assert.equal(inbox.length, 1, "only the agent with work waiting is reported");
    assert.equal(inbox[0].kind, "agent_down");
    assert.match(inbox[0].title, /Busy went offline/);

    // Any sign of life brings it back.
    await touchAgentLiveness(companyId, busy.id);
    assert.equal(await status(busy.id), "online");
});

maybe("the daily review reaches each agent with open tasks, addressed to it", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const worker = await seedAgent(companyId, { name: "Worker", provider: "hermes" });
    const idle = await seedAgent(companyId, { name: "Idler", provider: "hermes" });
    const task = await seedTask(companyId, worker.id, "Write the report");

    const { reviewCompany, runDailyRoutines } = await import("@/lib/agent-routines");
    assert.equal(await reviewCompany(companyId), 1, "idle agents get nothing");

    const sync = await import("@/app/api/mcp/messages/sync/route");
    const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${worker.id}`, { headers: { authorization: `Bearer ${rawToken}` } }));
    const review = (await res.json()).messages.find((m: { metadataJson: Record<string, unknown> }) => m.metadataJson.routine === "daily_review");
    assert.ok(review);
    assert.equal(review.addressedToYou, true);
    assert.equal(review.routeReason, "targeted");
    assert.ok(review.text.includes(`emperor://task/${task.id}`));
    void idle;

    // Scheduled runs claim the day once: a second run the same day sends nothing.
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ agentRoutineJson: { enabled: true, time: "00:00", timezone: "UTC", weekdaysOnly: false } }).where(eq(companies.id, companyId));
    assert.equal(await runDailyRoutines(), 1);
    assert.equal(await runDailyRoutines(), 0);
});

maybe("approvals: agents request them, decisions reach the agent, and they close properly", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Sender", provider: "hermes" });
    const task = await seedTask(companyId, agent.id, "Email the Acme proposal");
    const db = await getDb();
    const { tasks, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const stateOf = async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].state;

    // The agent asks over REST with just the task: the project is derived and the task waits in review.
    const route = await import("@/app/api/mcp/approvals/route");
    const created = await route.POST(makeRequest("http://localhost/api/mcp/approvals", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` },
        body: { taskId: task.id, rationale: "Ready to send the proposal to acme@example.com", actionType: "send_email", requesterAgentId: agent.id },
    }));
    assert.equal(created.status, 201);
    const { approval } = await created.json();
    assert.equal(await stateOf(), "review");

    // A rejection returns the task to the agent with the note.
    const { resolveApproval, requestApprovalForTasks } = await import("@/lib/approvals");
    await resolveApproval({ companyId, approvalId: approval.id, resolverUserId: userId, status: "rejected", resolutionNote: "Lower the price to 9k" });
    assert.equal(await stateOf(), "in_progress");
    const told = (await db.select().from(threadMessages)).find((m) => (m.metadataJson as Record<string, unknown>).approvalDecision === "rejected");
    assert.ok(told, "the agent is told");
    assert.equal(told!.targetAgentId, agent.id);
    assert.match(told!.text, /Lower the price to 9k/);

    // A decision is final.
    const again = await resolveApproval({ companyId, approvalId: approval.id, resolverUserId: userId, status: "approved" });
    assert.equal(again?.status, "rejected");

    // Approving "send an email" means go ahead, not "done".
    const second = await requestApprovalForTasks({ companyId, taskIds: [task.id], requesterAgentId: agent.id, rationale: "Revised to 9k", actionType: "send_email" });
    await resolveApproval({ companyId, approvalId: second!.id, resolverUserId: userId, status: "approved" });
    assert.equal(await stateOf(), "in_progress");

    // Approving "close the task" closes it.
    const third = await requestApprovalForTasks({ companyId, taskIds: [task.id], requesterAgentId: agent.id, rationale: "Sent; the client confirmed" });
    await resolveApproval({ companyId, approvalId: third!.id, resolverUserId: userId, status: "approved" });
    assert.equal(await stateOf(), "done");

    // Other companies' tasks are refused.
    await assert.rejects(requestApprovalForTasks({ companyId: randomUUID(), taskIds: [task.id], rationale: "x" }), /Task not found/);
});

maybe("a dismissed approval is final, leaves the task untouched, and tells the agent not to act", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Sender", provider: "hermes" });
    const task = await seedTask(companyId, agent.id, "Email the Acme proposal");
    const db = await getDb();
    const { approvals, tasks, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const stateOf = async () => (await db.select().from(tasks).where(eq(tasks.id, task.id)))[0].state;

    const { requestApprovalForTasks, resolveApproval } = await import("@/lib/approvals");
    const approval = await requestApprovalForTasks({ companyId, taskIds: [task.id], requesterAgentId: agent.id, rationale: "Ready to send to acme@example.com", actionType: "send_email" });
    assert.equal(await stateOf(), "review");

    const resolved = await resolveApproval({ companyId, approvalId: approval!.id, resolverUserId: userId, status: "dismissed", resolutionNote: "No longer needed" });
    assert.equal(resolved?.status, "dismissed");
    assert.equal(resolved?.resolutionNote, "No longer needed");
    assert.equal(resolved?.resolverUserId, userId);
    assert.ok(resolved?.resolvedAt, "resolvedAt is set");

    // Dismissing does NOT complete the task and does NOT send it back for rework.
    assert.equal(await stateOf(), "review");

    const told = (await db.select().from(threadMessages)).find((m) => (m.metadataJson as Record<string, unknown>).approvalDecision === "dismissed");
    assert.ok(told, "the agent is told");
    assert.match(told!.text, /do NOT perform this action/);
    assert.match(told!.text, /No longer needed/);
    assert.equal(told!.deliveryState, "queued", "the agent is woken so it stops waiting");

    // A decision is final: a later approve does not override the dismissal.
    const again = await resolveApproval({ companyId, approvalId: approval!.id, resolverUserId: userId, status: "approved" });
    assert.equal(again?.status, "dismissed");
    const [row] = await db.select().from(approvals).where(eq(approvals.id, approval!.id));
    assert.equal(row.status, "dismissed");
});

maybe("external approvals expire after 48h and tell the agent not to act; task_done does not", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Sender", provider: "hermes" });
    const externalTask = await seedTask(companyId, agent.id, "Email the Acme proposal");
    const closeTask = await seedTask(companyId, agent.id, "Close the report");
    const db = await getDb();
    const { approvals, tasks, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const stateOf = async (id: string) => (await db.select().from(tasks).where(eq(tasks.id, id)))[0].state;

    const { requestApprovalForTasks, expireStaleApprovals } = await import("@/lib/approvals");
    const external = await requestApprovalForTasks({ companyId, taskIds: [externalTask.id], requesterAgentId: agent.id, rationale: "Send it", actionType: "send_email" });
    const closing = await requestApprovalForTasks({ companyId, taskIds: [closeTask.id], requesterAgentId: agent.id, rationale: "Close it", actionType: "task_done" });

    // Backdate both requests past the 48h TTL.
    await db.update(approvals).set({ requestedAt: new Date(Date.now() - 49 * 60 * 60 * 1000) }).where(eq(approvals.companyId, companyId));

    const expired = await expireStaleApprovals();
    assert.equal(expired, 1, "only the external action expires");

    const statusOf = async (id: string) => (await db.select().from(approvals).where(eq(approvals.id, id)))[0].status;
    assert.equal(await statusOf(external!.id), "expired");
    assert.equal(await statusOf(closing!.id), "pending", "a task_done request never auto-expires");
    assert.equal(await stateOf(externalTask.id), "review", "an expired external action leaves the task untouched");

    const told = (await db.select().from(threadMessages)).find((m) => (m.metadataJson as Record<string, unknown>).approvalId === external!.id && (m.metadataJson as Record<string, unknown>).approvalDecision === "expired");
    assert.ok(told, "the agent is told the approval expired");
    assert.match(told!.text, /do NOT perform this action/);

    // Idempotent: a second sweep finds nothing pending to expire.
    assert.equal(await expireStaleApprovals(), 0);
});
