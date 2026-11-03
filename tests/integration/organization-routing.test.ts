import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

async function team(companyId: string, userId: string, title: string, agentIds: string[], coordinator: string) {
    const { createGroup } = await import("@/lib/groups");
    return createGroup(companyId, { type: "human", id: userId }, { title, agentIds, coordinator: { kind: "agent", id: coordinator } });
}

/** Boss leads; Dev leads the Development team; Qa works in it. The project lead is Other. */
async function routingFixture() {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const boss = await seedAgent(companyId, { name: "Boss" });
    const dev = await seedAgent(companyId, { name: "Dev" });
    const qa = await seedAgent(companyId, { name: "Qa" });
    const other = await seedAgent(companyId, { name: "Other lead" });
    const devTeam = await team(companyId, userId, "Development", [boss.id, dev.id, qa.id], dev.id);
    const { attachTeamToOrganization } = await import("@/lib/organization");
    await attachTeamToOrganization(companyId, devTeam.id, { rootAgentId: boss.id });
    const db = await getDb();
    const schema = await getSchema();
    const { and, asc, eq, sql } = await import("drizzle-orm");
    const [project] = await db.insert(schema.projects).values({ companyId, goal: "Launch", status: "active", leadAgentId: other.id }).returning();
    const newTask = async (title: string, values: Record<string, unknown> = {}) => (await db.insert(schema.tasks).values({ companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: qa.id, inputJson: { title }, ...values }).returning())[0];
    const reports = (agentId: string) => db.select().from(schema.threadMessages)
        .where(and(eq(schema.threadMessages.targetAgentId, agentId), sql`${schema.threadMessages.metadataJson}->>'orgReport' = 'true'`))
        .orderBy(asc(schema.threadMessages.createdAt));
    const { settleTaskOutcomeReports } = await import("@/lib/organization-routing");
    return { companyId, userId, boss, dev, qa, other, project, db, schema, newTask, reports, settle: settleTaskOutcomeReports };
}

maybe("done or blocked work reaches the chart manager once per state change; edits by the manager or a person do not", async () => {
    const f = await routingFixture();
    const task = await f.newTask("Test checkout");
    const { updateTaskForCompany } = await import("@/lib/openclaw/tasks");
    await updateTaskForCompany({ companyId: f.companyId, taskId: task.id, state: "blocked", blockedReason: "Waiting on API keys", actorType: "agent", actorId: f.qa.id });
    await f.settle();
    let toDev = await f.reports(f.dev.id);
    assert.equal(toDev.length, 1);
    assert.match(toDev[0].text, /"Qa" set \[Test checkout\]\(emperor:\/\/task\/.+\) to blocked/);
    assert.match(toDev[0].text, /Blocker: "Waiting on API keys"/);
    assert.equal(toDev[0].deliveryState, "queued", "the first report wakes the manager");
    // blocked → in_progress → blocked inside the dedupe window is one report.
    await updateTaskForCompany({ companyId: f.companyId, taskId: task.id, state: "in_progress", actorType: "agent", actorId: f.qa.id });
    await updateTaskForCompany({ companyId: f.companyId, taskId: task.id, state: "blocked", blockedReason: "Still waiting", actorType: "agent", actorId: f.qa.id });
    await f.settle();
    assert.equal((await f.reports(f.dev.id)).length, 1, "deduped within the window");
    // The manager's own change and a person's change are not reported.
    await updateTaskForCompany({ companyId: f.companyId, taskId: task.id, state: "in_progress", actorType: "agent", actorId: f.dev.id });
    await updateTaskForCompany({ companyId: f.companyId, taskId: task.id, state: "done", actorType: "human", actorId: f.userId });
    await f.settle();
    toDev = await f.reports(f.dev.id);
    assert.equal(toDev.length, 1);
    assert.equal((await f.reports(f.boss.id)).length, 0, "only the direct manager, never the whole chain");
});

maybe("finalize and an approved close both report; only the first report in the window wakes the manager", async () => {
    const f = await routingFixture();
    const { eq } = await import("drizzle-orm");
    const { finalizeTaskForAgent } = await import("@/lib/openclaw/tasks");
    const first = await f.newTask("Write tests");
    const result = await finalizeTaskForAgent({ companyId: f.companyId, taskId: first.id, agentId: f.qa.id, state: "done", comment: "All green, see PR 12" });
    assert.equal(result.status, 200);
    await f.settle();
    let toDev = await f.reports(f.dev.id);
    assert.equal(toDev.length, 1);
    assert.match(toDev[0].text, /to done/);
    assert.match(toDev[0].text, /Handoff: "All green, see PR 12"/);

    // Approval-gated close: done when a person approves the agent's request.
    const second = await f.newTask("Ship release", { humanApprovalRequired: true });
    const gated = await finalizeTaskForAgent({ companyId: f.companyId, taskId: second.id, agentId: f.qa.id, state: "done", comment: "Ready" });
    assert.equal(gated.status, 409);
    const approvalId = (gated as { approval?: { id: string } }).approval!.id;
    const { resolveApproval } = await import("@/lib/approvals");
    await resolveApproval({ companyId: f.companyId, approvalId, resolverUserId: f.userId, status: "approved" });
    await f.settle();
    toDev = await f.reports(f.dev.id);
    assert.equal(toDev.length, 2, "the approved close reaches the manager too");
    assert.match(toDev[1].text, /Ship release/);
    assert.equal(toDev[1].deliveryState, "resolved", "a second report inside 15 minutes waits quietly");
    assert.equal((toDev[1].metadataJson as Record<string, unknown>).wakes, false);

    // After the window, the next report wakes again and counts the quiet one.
    await f.db.update(f.schema.threadMessages).set({ createdAt: new Date(Date.now() - 20 * 60_000) }).where(eq(f.schema.threadMessages.companyId, f.companyId));
    const third = await f.newTask("Fix flake");
    await finalizeTaskForAgent({ companyId: f.companyId, taskId: third.id, agentId: f.qa.id, state: "done" });
    await f.settle();
    toDev = await f.reports(f.dev.id);
    const last = toDev[toDev.length - 1];
    assert.match(last.text, /Fix flake/);
    assert.equal(last.deliveryState, "queued");
    assert.match(last.text, /1 earlier org chart report/);
});

maybe("no report when the manager created or owns the task", async () => {
    const f = await routingFixture();
    const { createTaskForProject, updateTaskForCompany } = await import("@/lib/openclaw/tasks");
    const created = await createTaskForProject({ companyId: f.companyId, projectId: f.project.id, taskType: "work", inputJson: { title: "Made by Dev" }, assignedAgentId: f.qa.id, actorType: "agent", actorId: f.dev.id, wake: false });
    const createdId = (created as { task?: { id: string } }).task?.id;
    assert.ok(createdId);
    await updateTaskForCompany({ companyId: f.companyId, taskId: createdId, state: "done", actorType: "agent", actorId: f.qa.id });
    // Qa sets a task Dev owns: Dev is the assignee, so it already knows.
    const owned = await f.newTask("Dev's own", { assignedAgentId: f.dev.id });
    await updateTaskForCompany({ companyId: f.companyId, taskId: owned.id, state: "blocked", blockedReason: "y", actorType: "agent", actorId: f.qa.id });
    await f.settle();
    assert.equal((await f.reports(f.dev.id)).length, 0);
    assert.equal((await f.reports(f.boss.id)).length, 0, "Dev's own manager is not told about Qa's edit");
});

maybe("stalls skip a manager that cannot see the project or was deleted, then escalate to the project lead", async () => {
    const f = await routingFixture();
    const { and, eq, sql } = await import("drizzle-orm");
    const { runStallSweep } = await import("@/lib/stall-sweep");
    const stalled = async (title: string) => {
        await f.db.delete(f.schema.taskEvents).where(eq(f.schema.taskEvents.companyId, f.companyId));
        await f.db.delete(f.schema.threadMessages).where(eq(f.schema.threadMessages.companyId, f.companyId));
        const task = await f.newTask(title, { updatedAt: new Date(Date.now() - 10 * 3600_000) });
        await runStallSweep();
        await f.db.update(f.schema.taskEvents).set({ createdAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(f.schema.taskEvents.taskId, task.id));
        await f.db.update(f.schema.threadMessages).set({ createdAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(f.schema.threadMessages.companyId, f.companyId));
        await runStallSweep();
        await f.db.update(f.schema.tasks).set({ state: "done" }).where(eq(f.schema.tasks.id, task.id));
        return f.db.select().from(f.schema.threadMessages).where(and(eq(f.schema.threadMessages.companyId, f.companyId), sql`${f.schema.threadMessages.metadataJson}->>'stallEscalation' = 'true'`));
    };
    // The chart manager first.
    assert.deepEqual((await stalled("Stale one")).map((m) => m.targetAgentId), [f.dev.id]);
    // A manager limited to other projects is skipped (no title leaks to it): the project lead gets it.
    await f.db.update(f.schema.agents).set({ scopeJson: { mode: "restricted", projectIds: [], customerIds: [] } }).where(eq(f.schema.agents.id, f.dev.id));
    const scoped = await stalled("Secret stale");
    assert.deepEqual(scoped.map((m) => m.targetAgentId), [f.other.id]);
    // A deleted manager is skipped the same way.
    await f.db.update(f.schema.agents).set({ scopeJson: {}, deletedAt: new Date() }).where(eq(f.schema.agents.id, f.dev.id));
    const { invalidateOrganizationCache } = await import("@/lib/organization-cache");
    invalidateOrganizationCache(f.companyId);
    assert.deepEqual((await stalled("Orphan stale")).map((m) => m.targetAgentId), [f.other.id]);
});

maybe("a manager outside the project or the worker's reach gets a link, not the details", async () => {
    const f = await routingFixture();
    const { eq } = await import("drizzle-orm");
    await f.db.update(f.schema.agents).set({ scopeJson: { mode: "restricted", projectIds: [], customerIds: [], agentIds: [f.boss.id] } }).where(eq(f.schema.agents.id, f.dev.id));
    const task = await f.newTask("Confidential deal");
    const { updateTaskForCompany } = await import("@/lib/openclaw/tasks");
    await updateTaskForCompany({ companyId: f.companyId, taskId: task.id, state: "done", actorType: "agent", actorId: f.qa.id });
    await f.settle();
    const [report] = await f.reports(f.dev.id);
    assert.ok(report);
    assert.doesNotMatch(report.text, /Confidential|Launch|"Qa"/);
    assert.match(report.text, /emperor:\/\/task\//);
});

maybe("re-adding easy setup's first team keeps one place per agent; an unplaceable team says so", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const lead = await seedAgent(companyId, { name: "Lead" });
    const a = await seedAgent(companyId, { name: "A" });
    const b = await seedAgent(companyId, { name: "B" });
    const crew = await team(companyId, userId, "Crew", [lead.id, a.id, b.id], lead.id);
    const { attachTeamToOrganization, loadOrganization } = await import("@/lib/organization");
    assert.equal((await attachTeamToOrganization(companyId, crew.id)).onChart, true);
    const again = await attachTeamToOrganization(companyId, crew.id);
    assert.equal(again.changed, false);
    assert.equal(again.onChart, true);
    const nodes = (await loadOrganization(companyId)).config.nodes ?? [];
    assert.equal(nodes.filter((n) => n.kind === "person" && n.person.id === b.id).length, 1, "no duplicate under a second team node");
    // A team whose only agent already leads the company cannot be placed.
    const solo = await team(companyId, userId, "Solo", [lead.id], lead.id);
    const result = await attachTeamToOrganization(companyId, solo.id);
    assert.equal(result.changed, false);
    assert.equal(result.onChart, false);
});

maybe("an agent limited to certain agents cannot read the org chart note; others can", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const boss = await seedAgent(companyId, { name: "Boss" });
    const dev = await seedAgent(companyId, { name: "Dev" });
    const limited = await seedAgent(companyId, { name: "Limited", scopeJson: { agentIds: [boss.id] } });
    const group = await team(companyId, userId, "Development", [boss.id, dev.id], dev.id);
    const { attachTeamToOrganization } = await import("@/lib/organization");
    await attachTeamToOrganization(companyId, group.id, { rootAgentId: boss.id });
    const { refreshOrganizationNote } = await import("@/lib/organization-note");
    assert.equal(await refreshOrganizationNote(companyId), "created");
    const db = await getDb();
    const { scopedResources } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [note] = await db.select().from(scopedResources).where(eq(scopedResources.name, "organization-chart"));
    // Even if someone made it an index note, a limited agent must not see it.
    await db.update(scopedResources).set({ inject: "index", isShared: true }).where(eq(scopedResources.id, note.id));
    const { searchVisibleKnowledgeNotes, getVisibleKnowledgeNote, buildKnowledgeIndex, resolveCompanyBrainContext } = await import("@/lib/resources");
    const seen = async (agentId: string) => ({
        search: (await searchVisibleKnowledgeNotes({ companyId, agentId, query: "Organization chart" })).some((n) => n.id === note.id),
        read: Boolean(await getVisibleKnowledgeNote({ companyId, agentId, resourceId: note.id })),
        index: (await buildKnowledgeIndex({ companyId, agentId })).knowledgeIndex.includes(note.id),
        context: JSON.stringify(await resolveCompanyBrainContext({ companyId, callerAgentId: agentId, agentId, resourceIds: [note.id] })).includes(note.id),
    });
    assert.deepEqual(await seen(limited.id), { search: false, read: false, index: false, context: false });
    const open = await seen(dev.id);
    assert.equal(open.read, true);
    assert.equal(open.search, true);
    assert.equal(open.index, true);
});
