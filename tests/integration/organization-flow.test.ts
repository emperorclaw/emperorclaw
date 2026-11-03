import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

async function team(companyId: string, userId: string, title: string, agentIds: string[], coordinator: string) {
    const { createGroup } = await import("@/lib/groups");
    return createGroup(companyId, { type: "human", id: userId }, { title, agentIds, coordinator: { kind: "agent", id: coordinator } });
}

maybe("setup places teams on the chart, only adds, and agents learn their place", async () => {
    await resetDb();
    const { companyId, userId, rawToken } = await seedCompanyWithToken();
    const boss = await seedAgent(companyId, { name: "Boss", role: "Chief of staff" });
    const dev = await seedAgent(companyId, { name: "Dev", role: "Developer" });
    const qa = await seedAgent(companyId, { name: "Qa", role: "Tester" });
    const writer = await seedAgent(companyId, { name: "Writer", role: "Content" });
    const devTeam = await team(companyId, userId, "Development", [boss.id, dev.id, qa.id], dev.id);
    const mkt = await team(companyId, userId, "Marketing", [boss.id, writer.id], writer.id);
    const { attachTeamToOrganization, loadOrganization, organizationForAgent } = await import("@/lib/organization");

    const first = await attachTeamToOrganization(companyId, devTeam.id, { rootAgentId: boss.id });
    assert.equal(first.changed, true);
    assert.equal(first.onChart, true);
    assert.equal((await attachTeamToOrganization(companyId, devTeam.id, { rootAgentId: qa.id })).changed, false, "a team already on the chart is left alone");
    await attachTeamToOrganization(companyId, mkt.id, { rootAgentId: qa.id });
    const org = await loadOrganization(companyId);
    assert.equal(org.config.leader?.id, boss.id, "the root chosen first stays");
    assert.deepEqual(org.config.teamIds.sort(), [devTeam.id, mkt.id].sort());

    const qaPlace = await organizationForAgent(companyId, qa.id);
    assert.equal(qaPlace.summary, "Org chart: you report to Dev (Development).");
    assert.equal(qaPlace.chainSummary, "Dev → Boss → the humans");
    const devPlace = await organizationForAgent(companyId, dev.id);
    assert.deepEqual(devPlace.directReports.map((p) => p.id), [qa.id]);
    assert.deepEqual(devPlace.peers.map((p) => p.id), [writer.id]);
    assert.match(devPlace.tree, /Team Development, led by Dev — Developer \(you\)/);

    // GET /organization and the lean context carry the same place.
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companyTokens).set({ agentId: qa.id }).where(eq(companyTokens.companyId, companyId));
    const route = await import("@/app/api/mcp/organization/route");
    const info = await (await route.GET(makeRequest(`http://localhost/api/mcp/organization?agentId=${qa.id}`, { headers: { authorization: `Bearer ${rawToken}` } }))).json();
    assert.equal(info.managers[0].manager.id, dev.id);
    assert.equal(info.reporting[0].reportsTo.id, dev.id);
    const { buildLeanContext } = await import("@/lib/lean-context");
    assert.equal((await buildLeanContext({ companyId, agentId: qa.id })).organization, "Org chart: you report to Dev (Development).");
});

maybe("easy setup's first team starts a chart led by its leader", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const lead = await seedAgent(companyId, { name: "Lead" });
    const a = await seedAgent(companyId, { name: "A" });
    const group = await team(companyId, userId, "Crew", [lead.id, a.id], lead.id);
    const { attachTeamToOrganization, organizationForAgent } = await import("@/lib/organization");
    const result = await attachTeamToOrganization(companyId, group.id);
    assert.equal(result.onChart, true);
    assert.equal(result.config?.leader?.id, lead.id);
    assert.equal((await organizationForAgent(companyId, a.id)).managers[0].manager.id, lead.id);
});

maybe("setup can put the person above the AI leader; escalation names them", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const db = await getDb();
    const { companyMembers, users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.insert(companyMembers).values({ companyId, userId, role: "owner" });
    await db.update(users).set({ displayName: "Jose", roleTitle: "Founder" }).where(eq(users.id, userId));
    const boss = await seedAgent(companyId, { name: "Boss" });
    const dev = await seedAgent(companyId, { name: "Dev" });
    const group = await team(companyId, userId, "Development", [boss.id, dev.id], dev.id);
    const { attachTeamToOrganization, organizationForAgent } = await import("@/lib/organization");
    const result = await attachTeamToOrganization(companyId, group.id, { rootAgentId: boss.id, rootHumanId: userId });
    assert.equal(result.config?.leader?.kind, "human");
    const place = await organizationForAgent(companyId, dev.id);
    assert.equal(place.chainSummary, "Boss → Jose");
    assert.match(place.tree, /^- Jose — Founder \(human\)/);
});

maybe("the Organization chart note is generated, kept current and never recreated after deletion", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const boss = await seedAgent(companyId, { name: "Boss" });
    const dev = await seedAgent(companyId, { name: "Dev" });
    const group = await team(companyId, userId, "Development", [boss.id, dev.id], dev.id);
    const { refreshOrganizationNote } = await import("@/lib/organization-note");
    assert.equal(await refreshOrganizationNote(companyId), "skipped", "no chart, no note");
    const { attachTeamToOrganization } = await import("@/lib/organization");
    await attachTeamToOrganization(companyId, group.id, { rootAgentId: boss.id });
    assert.equal(await refreshOrganizationNote(companyId), "created");
    assert.equal(await refreshOrganizationNote(companyId), "unchanged");
    const { updateAgentForCompany } = await import("@/lib/agents-crud");
    await updateAgentForCompany({ companyId, agentId: dev.id, role: "Staff engineer" });
    assert.equal(await refreshOrganizationNote(companyId), "updated");
    const db = await getDb();
    const { scopedResources } = await getSchema();
    const { and, eq, isNull } = await import("drizzle-orm");
    const [note] = await db.select().from(scopedResources).where(and(eq(scopedResources.companyId, companyId), eq(scopedResources.name, "organization-chart"), isNull(scopedResources.deletedAt)));
    assert.equal(note.inject, "on_request", "search only, never pushed into prompts");
    assert.match(note.configText, /^> Generated by Emperor Claw/);
    assert.match(note.configText, /Dev — Staff engineer/);
    await db.update(scopedResources).set({ deletedAt: new Date() }).where(eq(scopedResources.id, note.id));
    assert.equal(await refreshOrganizationNote(companyId), "skipped");
});
