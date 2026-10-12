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
