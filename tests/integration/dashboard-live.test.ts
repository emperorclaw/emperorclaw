import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

/**
 * The dashboard's living office reads reasoning and moments with the device
 * feed's loaders, under a stricter rule: no direct thread ever, and agent pair
 * threads only for owners/admins.
 */
maybe("dashboard thoughts and moments: team/group only, pair threads for admins, scoped to the company", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const { companyId: otherCompanyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { messageThreads, threadMessages, threadMessageReasoning, projects, tasks, taskEvents } = await getSchema();
    const { loadDashboardLive } = await import("@/lib/dashboard-live");
    const now = Date.now();
    const ago = (sec: number) => new Date(now - sec * 1000);

    const ada = await seedAgent(companyId, { name: "Ada" });
    const bob = await seedAgent(companyId, { name: "Bob" });
    const cy = await seedAgent(companyId, { name: "Cy" });
    const outsider = await seedAgent(otherCompanyId, { name: "Ada" });

    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const [direct] = await db.insert(messageThreads).values({ companyId, type: "direct", title: "Private" }).returning();
    const [pair] = await db.insert(messageThreads).values({ companyId, type: "group", title: "Ada ↔ Cy", description: "agent-pair", createdByType: "system" }).returning();
    const [otherTeam] = await db.insert(messageThreads).values({ companyId: otherCompanyId, type: "team", title: "Team" }).returning();

    const [adaTeam, adaDirect, bobDirect, cyPair, outsiderMsg] = await db.insert(threadMessages).values([
        { companyId, threadId: team.id, senderType: "agent", senderId: ada.id, text: "@Bob can you take the deploy?", createdAt: ago(60) },
        { companyId, threadId: direct.id, senderType: "agent", senderId: ada.id, text: "Private answer", createdAt: ago(10) },
        { companyId, threadId: direct.id, senderType: "agent", senderId: bob.id, text: "Private answer", createdAt: ago(10) },
        { companyId, threadId: pair.id, senderType: "agent", senderId: cy.id, text: "@Ada here is the handover", createdAt: ago(15) },
        { companyId: otherCompanyId, threadId: otherTeam.id, senderType: "agent", senderId: outsider.id, text: "Other company", createdAt: ago(5) },
    ]).returning();
    await db.insert(threadMessageReasoning).values([
        { companyId, messageId: adaTeam.id, reasoning: "Reading the deploy logs before handing the release to Bob", createdAt: ago(60) },
        { companyId, messageId: adaDirect.id, reasoning: "The owner's private salary question needs a careful answer", createdAt: ago(10) },
        { companyId, messageId: bobDirect.id, reasoning: "Only private reasoning exists for Bob right now", createdAt: ago(10) },
        { companyId, messageId: cyPair.id, reasoning: "Packaging the handover notes for Ada in the pair thread", createdAt: ago(15) },
        { companyId: otherCompanyId, messageId: outsiderMsg.id, reasoning: "Another company's thinking must never leak across", createdAt: ago(5) },
    ]);
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const [done] = await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "report", state: "done", assignedAgentId: bob.id, inputJson: { title: "Ship the report" } }).returning();
    await db.insert(taskEvents).values({ companyId, taskId: done.id, eventType: "task_done", actorType: "agent", actorId: bob.id, createdAt: ago(30) });

    const agents = [ada, bob, cy].map((a) => ({ id: a.id, name: a.name }));
    const member = await loadDashboardLive(companyId, { now: new Date(now), agents, approvals: [], includePairThreads: false });
    const thoughts = new Map(member.thoughts.map((t) => [t.memberKey, t.text]));
    assert.equal(thoughts.get(`agent:${ada.id}`), "Reading the deploy logs before handing the release to Bob", "the newer direct-thread thought is never used");
    assert.equal(thoughts.has(`agent:${bob.id}`), false, "direct-only reasoning never reaches the dashboard");
    assert.equal(thoughts.has(`agent:${cy.id}`), false, "pair threads are hidden from non-admins");
    assert.ok(member.thoughts.every((t) => !/salary|private|Another company/i.test(t.text)));

    const types = member.liveEvents.map((e) => `${e.type}:${e.actorKey}${e.targetKey ? `>${e.targetKey}` : ""}`).sort();
    assert.deepEqual(types, [`handoff:agent:${ada.id}>agent:${bob.id}`, `task_done:agent:${bob.id}`].sort(), "no pair-thread handoff for a non-admin");

    const admin = await loadDashboardLive(companyId, { now: new Date(now), agents, approvals: [], includePairThreads: true });
    assert.equal(new Map(admin.thoughts.map((t) => [t.memberKey, t.text])).get(`agent:${cy.id}`), "Packaging the handover notes for Ada in the pair thread");
    assert.ok(admin.liveEvents.some((e) => e.type === "handoff" && e.actorKey === `agent:${cy.id}` && e.targetKey === `agent:${ada.id}`));
    assert.ok(admin.thoughts.every((t) => !/salary|Another company/i.test(t.text)), "admins never see direct-thread or other-company reasoning either");
});

/**
 * 0.9 bridges never fill thread_message_reasoning: their steps live in
 * agent_run_events. The dashboard bubble reads the running run's newest step,
 * from any thread, redacted to the generic label for a direct chat the viewer
 * is not in.
 */
maybe("dashboard thoughts from 0.9 run events, direct runs redacted for non-participants", async () => {
    await resetDb();
    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    const db = await getDb();
    const { messageThreads, threadParticipants, agentRuns, agentRunEvents, users } = await getSchema();
    const { loadDashboardLive, loadRunThoughts } = await import("@/lib/dashboard-live");
    const { randomUUID } = await import("node:crypto");
    const now = Date.now();
    const ago = (sec: number) => new Date(now - sec * 1000);

    const ada = await seedAgent(companyId, { name: "Ada" });
    const bob = await seedAgent(companyId, { name: "Bob" });
    const cy = await seedAgent(companyId, { name: "Cy" });
    const [other] = await db.insert(users).values({ email: `member-${randomUUID()}@example.com`, passwordHash: "x" }).returning();

    const [team] = await db.insert(messageThreads).values({ companyId, type: "team", title: "Team" }).returning();
    const [direct] = await db.insert(messageThreads).values({ companyId, type: "direct", title: "Owner and Bob" }).returning();
    await db.insert(threadParticipants).values([
        { companyId, threadId: direct.id, participantType: "human", participantRef: ownerId },
        { companyId, threadId: direct.id, participantType: "agent", participantId: bob.id },
    ]);

    const adaRun = randomUUID();
    const bobRun = randomUUID();
    const cyRun = randomUUID();
    const oldBobRun = randomUUID();
    await db.insert(agentRuns).values([
        { id: adaRun, companyId, agentId: ada.id, threadId: team.id, status: "running", startedAt: ago(40) },
        { id: bobRun, companyId, agentId: bob.id, threadId: direct.id, status: "running", startedAt: ago(30) },
        { id: oldBobRun, companyId, agentId: bob.id, threadId: team.id, status: "succeeded", startedAt: ago(300), endedAt: ago(200) },
        // Running, but no events yet: no bubble from it.
        { id: cyRun, companyId, agentId: cy.id, threadId: team.id, status: "running", startedAt: ago(5) },
    ]);
    const event = (runId: string, agentId: string, threadId: string, seq: number, sec: number, fields: Record<string, unknown>) => ({
        id: randomUUID(), companyId, runId, agentId, threadId, seq, ts: ago(sec), ...fields,
    });
    await db.insert(agentRunEvents).values([
        event(adaRun, ada.id, team.id, 1, 30, { kind: "turn.started" }),
        event(adaRun, ada.id, team.id, 2, 20, { kind: "reasoning", summary: "The deploy logs show a missing env var. Next I check the compose file." }),
        event(adaRun, ada.id, team.id, 3, 10, { kind: "tool.start", toolName: "read_file", summary: "docker-compose.yml", status: "running" }),
        event(bobRun, bob.id, direct.id, 1, 25, { kind: "tool.end", toolName: "web", status: "ok" }),
        event(bobRun, bob.id, direct.id, 2, 8, { kind: "reasoning", summary: "The owner's salary question needs a careful answer." }),
        event(oldBobRun, bob.id, team.id, 1, 250, { kind: "reasoning", summary: "An old finished run" }),
    ]);

    const agents = [ada, bob, cy].map((a) => ({ id: a.id, name: a.name }));
    const asMember = await loadDashboardLive(companyId, { now: new Date(now), agents, approvals: [], includePairThreads: false, viewerUserId: other.id });
    const memberThoughts = new Map(asMember.thoughts.map((t) => [t.memberKey, t]));
    assert.equal(memberThoughts.get(`agent:${ada.id}`)?.label, "Running read_file");
    assert.equal(memberThoughts.get(`agent:${ada.id}`)?.text, "docker-compose.yml");
    assert.equal(Math.round((now - Date.parse(memberThoughts.get(`agent:${ada.id}`)!.at)) / 1000), 10, "the bubble is as old as the step");
    assert.equal(memberThoughts.get(`agent:${bob.id}`)?.label, "Thinking…", "a direct run the viewer is not in shows only the generic label");
    assert.equal(memberThoughts.get(`agent:${bob.id}`)?.text, "");
    assert.equal(memberThoughts.has(`agent:${cy.id}`), false, "a run without events gives no bubble");
    assert.ok(asMember.thoughts.every((t) => !/salary|old finished/i.test(`${t.label} ${t.text}`)));

    const asOwner = await loadDashboardLive(companyId, { now: new Date(now), agents, approvals: [], includePairThreads: true, viewerUserId: ownerId });
    const ownerBob = asOwner.thoughts.find((t) => t.memberKey === `agent:${bob.id}`);
    assert.equal(ownerBob?.label, "Thinking");
    assert.equal(ownerBob?.text, "The owner's salary question needs a careful answer.", "the participant sees the full step");

    // The fast poll path returns the same redacted steps.
    const polled = await loadRunThoughts(companyId, { now: new Date(now), viewerUserId: other.id, includePairThreads: false });
    assert.deepEqual(polled.map((t) => `${t.memberKey}|${t.label}|${t.text}`).sort(), [
        `agent:${ada.id}|Running read_file|docker-compose.yml`,
        `agent:${bob.id}|Thinking…|`,
    ].sort());
    const scoped = await loadRunThoughts(companyId, { now: new Date(now), agentIds: [ada.id], viewerUserId: other.id, includePairThreads: false });
    assert.deepEqual(scoped.map((t) => t.memberKey), [`agent:${ada.id}`], "a member scope limits the agents read");
});
