import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

async function seedPerson(companyId: string, displayName: string, role: "owner" | "admin" | "member" = "member") {
    const db = await getDb();
    const { users, companyMembers } = await getSchema();
    const [user] = await db.insert(users).values({ email: `${displayName.toLowerCase()}-${randomUUID()}@example.com`, passwordHash: "x", displayName }).returning();
    const [member] = await db.insert(companyMembers).values({ companyId, userId: user.id, role }).returning();
    return { userId: user.id, memberId: member.id };
}

async function syncFor(rawToken: string, agentId: string) {
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${agentId}`, { headers: { authorization: `Bearer ${rawToken}` } }));
    return (await res.json()).messages as Array<Record<string, unknown>>;
}

maybe("sync carries the server's routing verdict, and the loop guard pauses agent chains", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const max = await seedAgent(companyId, { name: "Max", provider: "hermes" });
    const builder = await seedAgent(companyId, { name: "Max Builder", provider: "hermes" });
    const qa = await seedAgent(companyId, { name: "QA", provider: "hermes" });
    const { appendThreadMessage, ensureTeamThread } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(companyId);

    const ask = await appendThreadMessage({ companyId, threadId: team.id, senderType: "human", senderId: userId, text: "@Max Builder ship it" });
    const forBuilder = (await syncFor(rawToken, builder.id)).find((m) => m.id === ask.id)!;
    const forMax = (await syncFor(rawToken, max.id)).find((m) => m.id === ask.id)!;
    assert.equal(forBuilder.addressedToYou, true);
    assert.equal(forBuilder.routeReason, "mention");
    assert.equal(forMax.addressedToYou, false, "@Max Builder must not wake Max");

    // Agents ping-pong without a person: past the limit the verdict is loop_paused
    // and one visible notice is posted.
    const { agentLoopMaxTurns, agentLoopHardCap } = await import("@/lib/message-routing");
    let last = ask;
    for (let i = 0; i < agentLoopMaxTurns() + 2; i++) {
        const sender = i % 2 ? qa : builder;
        last = await appendThreadMessage({ companyId, threadId: team.id, senderType: "agent", senderId: sender.id, text: `@${i % 2 ? "Max Builder" : "QA"} round ${i}` });
    }
    const forQa = (await syncFor(rawToken, qa.id)).find((m) => m.id === last.id);
    assert.equal(forQa?.routeReason ?? (await syncFor(rawToken, builder.id)).find((m) => m.id === last.id)?.routeReason, "loop_paused");
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const notices = (await db.select().from(threadMessages).where(eq(threadMessages.threadId, team.id))).filter((m) => (m.metadataJson as Record<string, unknown>).loopGuard);
    assert.equal(notices.length, 1, "exactly one pause notice");

    // A runtime that ignores the verdict hits the hard cap.
    const { sendThreadMessageFromMcp } = await import("@/lib/openclaw/messaging");
    for (let i = 0; i < agentLoopHardCap(); i++) {
        await appendThreadMessage({ companyId, threadId: team.id, senderType: "agent", senderId: qa.id, text: `noise ${i}` });
    }
    const { currentAgentStreak } = await import("@/lib/control-plane");
    const observedStreak = await currentAgentStreak(companyId, team.id);
    assert.ok(observedStreak >= agentLoopHardCap(), `streak ${observedStreak} must reach cap ${agentLoopHardCap()}`);
    await assert.rejects(sendThreadMessageFromMcp({ companyId, threadId: team.id, agentId: qa.id, text: "more", threadType: "team" }), /Loop guard/);
    // A person writing resets everything.
    await appendThreadMessage({ companyId, threadId: team.id, senderType: "human", senderId: userId, text: "ok stop" });
    await sendThreadMessageFromMcp({ companyId, threadId: team.id, agentId: qa.id, text: "Stopping.", threadType: "team" });
});

maybe("a runtime failure is recorded, counted, and the sender is notified", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const person = await seedPerson(companyId, "Claire");
    const agent = await seedAgent(companyId, { name: "Viktor", provider: "hermes" });
    const { appendThreadMessage, ensureDirectThread } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, agent.id, person.userId);
    const msg = await appendThreadMessage({ companyId, threadId: thread.id, senderType: "human", senderId: person.userId, targetAgentId: agent.id, text: "Draft the outreach email" });
    const status = await import("@/app/api/mcp/chat/status/route");
    const post = (body: Record<string, unknown>) => status.POST(makeRequest("http://localhost/api/mcp/chat/status", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` }, body: { threadId: thread.id, agentId: agent.id, messageId: msg.id, ...body },
    }));
    // Two failed attempts, then the runtime gives up.
    for (let i = 0; i < 2; i++) {
        await post({ executionState: "acting" });
        await post({ executionState: "queued" });
    }
    const gaveUp = await (await post({ executionState: "cancelled", reason: "provider timeout" })).json();
    assert.equal(gaveUp.failed, true);

    const db = await getDb();
    const { threadMessages, notifications } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(threadMessages).where(eq(threadMessages.id, msg.id));
    const meta = row.metadataJson as Record<string, unknown>;
    assert.equal(row.deliveryState, "cancelled");
    assert.equal(meta.failedAttempts, 2);
    assert.equal((meta.runtimeFailure as Record<string, unknown>).reason, "provider timeout");
    const inbox = await db.select().from(notifications).where(eq(notifications.userId, person.userId));
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, "agent_failed");
    assert.ok(inbox[0].link?.includes(agent.id));

    const { computeCompanyHealth } = await import("@/lib/agent-health");
    const health = await computeCompanyHealth(companyId);
    const viktor = health.agents.find((a) => a.id === agent.id)!;
    assert.equal(viktor.failed, 1);
    assert.equal(viktor.retries, 2);
    assert.equal(health.attention[0].kind, "failed");
});

maybe("mentions, decisions, approvals, and assigned tasks notify the right people once", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const owner = await seedPerson(companyId, "Jose", "owner");
    const dev = await seedPerson(companyId, "Ana");
    const agent = await seedAgent(companyId, { name: "Builder", provider: "hermes" });
    const { appendThreadMessage, ensureTeamThread, ensureDirectThread } = await import("@/lib/control-plane");
    const db = await getDb();
    const { notifications, projects } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const inboxOf = async (userId: string) => db.select().from(notifications).where(eq(notifications.userId, userId));

    // An agent @mentions a person in team chat; a second mention within the window collapses.
    const team = await ensureTeamThread(companyId);
    await appendThreadMessage({ companyId, threadId: team.id, senderType: "agent", senderId: agent.id, text: "@Ana the build is green, please review" });
    await appendThreadMessage({ companyId, threadId: team.id, senderType: "agent", senderId: agent.id, text: "@Ana also the docs" });
    const anaInbox = await inboxOf(dev.userId);
    assert.equal(anaInbox.length, 1);
    assert.equal(anaInbox[0].kind, "mention");

    // A decision in a direct thread goes to whoever spoke last there.
    const dm = await ensureDirectThread(companyId, agent.id, owner.userId);
    await appendThreadMessage({ companyId, threadId: dm.id, senderType: "human", senderId: owner.userId, targetAgentId: agent.id, text: "Plan the launch" });
    await appendThreadMessage({ companyId, threadId: dm.id, senderType: "agent", senderId: agent.id, text: "Ready.\n```choices\n{\"question\":\"Launch?\",\"options\":[\"Yes\",\"No\"]}\n```" });
    const ownerInbox = await inboxOf(owner.userId);
    assert.ok(ownerInbox.some((n) => n.kind === "decision"));

    // Approvals reach owners and admins; a task assigned to a person reaches that person.
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const { createTaskForProject } = await import("@/lib/openclaw/tasks");
    const created = await createTaskForProject({ companyId, projectId: project.id, taskType: "review", inputJson: { title: "Review launch copy" }, assignee: { type: "human", id: dev.memberId } } as never);
    assert.ok("task" in created);
    assert.ok((await inboxOf(dev.userId)).some((n) => n.kind === "task_assigned"));
    const { createApprovalRequest } = await import("@/lib/approvals");
    await createApprovalRequest({ companyId, projectId: project.id, taskIds: [(created as { task: { id: string } }).task.id], requesterAgentId: agent.id, rationale: "Ready to ship" });
    assert.ok((await inboxOf(owner.userId)).some((n) => n.kind === "approval"));
    assert.ok(!(await inboxOf(dev.userId)).some((n) => n.kind === "approval"), "members don't get approval requests");
});

maybe("agent health flags unanswered requests but not ones answered later", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Ops", provider: "hermes", lastSeenAt: new Date() });
    const { appendThreadMessage, ensureTeamThread, ensureDirectThread } = await import("@/lib/control-plane");
    const old = new Date(Date.now() - 30 * 60 * 1000);
    const dm = await ensureDirectThread(companyId, agent.id, userId);
    await appendThreadMessage({ companyId, threadId: dm.id, senderType: "human", senderId: userId, targetAgentId: agent.id, text: "Where is the report?", createdAt: old });
    // Answered later in team chat, even though an old runtime never advanced the state.
    const team = await ensureTeamThread(companyId);
    await appendThreadMessage({ companyId, threadId: team.id, senderType: "human", senderId: userId, text: "@Ops quick check", createdAt: old });
    await appendThreadMessage({ companyId, threadId: team.id, senderType: "agent", senderId: agent.id, text: "All good", createdAt: new Date(old.getTime() + 60_000) });

    const { computeCompanyHealth } = await import("@/lib/agent-health");
    const health = await computeCompanyHealth(companyId);
    const ops = health.agents.find((a) => a.id === agent.id)!;
    assert.equal(ops.requests, 2);
    assert.equal(ops.unanswered, 1, "only the direct request is still waiting");
    assert.equal(ops.status, "attention");
    assert.equal(ops.medianResponseMs, 60_000);
    assert.equal(health.attention.length, 1);
    assert.equal(health.attention[0].text, "Private message", "company health must not expose a private DM preview");
    assert.equal(health.attention[0].link, `/messages?agent=${agent.id}`, "the private request remains reachable through its permission-checked conversation");
});


maybe("database-generated and explicit message timestamps use the same UTC timeline", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const { ensureTeamThread } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(companyId);
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { sql } = await import("drizzle-orm");
    const timezone = await db.execute(sql`show timezone`);
    assert.equal(Object.values(timezone.rows[0])[0], "UTC");
    const instant = new Date();
    const rows = await db.insert(threadMessages).values([
        { companyId, threadId: team.id, senderType: "system", text: "SQL default" },
        { companyId, threadId: team.id, senderType: "system", text: "Explicit date", createdAt: instant },
    ]).returning();
    assert.ok(Math.abs(rows[0].createdAt.getTime() - rows[1].createdAt.getTime()) < 1000,
        "SQL now() must agree with JavaScript dates on hosts with a local timezone");
});
