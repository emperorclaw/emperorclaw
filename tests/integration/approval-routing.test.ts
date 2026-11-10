/**
 * Approval routing (docs/design/approval-routing.md), against a real DB:
 *   - a boss agent decides an ask it is itself allowed to do (decide_approval),
 *     and the requester is told who decided;
 *   - a boss without the permission is skipped (at creation) or refused (at
 *     decision time), and the ask reaches a person;
 *   - people: only the approvers (and owners/admins, as an override) decide;
 *     the loser of a race learns who decided;
 *   - the escalation sweep moves an undecided ask up after the timeout;
 *   - only the current approvers are notified.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, mcpClientFor, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

/**
 * Boss leads the company (chart root); Dev leads the Development team; Qa works
 * in it. Jose and Luis are members, Olivia the owner. Qa asks; Dev is its manager.
 */
async function world() {
    await resetDb();
    const db = await getDb();
    const schema = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [creator] = await db.insert(schema.users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(schema.companies).values({ name: "Routing Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const owner = await seedHuman(companyId, "owner");
    const jose = await seedHuman(companyId, "member");
    const luis = await seedHuman(companyId, "member");
    for (const [who, name] of [[owner, "Olivia"], [jose, "Jose"], [luis, "Luis"]] as const) {
        await db.update(schema.users).set({ displayName: name }).where(eq(schema.users.id, who.userId));
    }
    const boss = await seedAgent(companyId, { name: "Boss" });
    const dev = await seedAgent(companyId, { name: "Dev" });
    const qa = await seedAgent(companyId, { name: "Qa" });
    const { createGroup } = await import("@/lib/groups");
    const team = await createGroup(companyId, { type: "human", id: owner.userId }, { title: "Development", agentIds: [boss.id, dev.id, qa.id], coordinator: { kind: "agent", id: dev.id } });
    const { attachTeamToOrganization } = await import("@/lib/organization");
    await attachTeamToOrganization(companyId, team.id, { rootAgentId: boss.id });
    const { invalidateOrganizationCache } = await import("@/lib/organization-cache");
    invalidateOrganizationCache(companyId);
    const [project] = await db.insert(schema.projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const newTask = async (title: string) => (await db.insert(schema.tasks).values({
        companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: qa.id, inputJson: { title },
    }).returning())[0];
    const setPolicies = (agentId: string, map: Record<string, string>) => db.update(schema.agents).set({ actionPoliciesJson: map }).where(eq(schema.agents.id, agentId));
    return { companyId, owner, jose, luis, boss, dev, qa, team, project, newTask, setPolicies, db, schema, eq };
}

type World = Awaited<ReturnType<typeof world>>;

async function approvalRow(w: World, id: string) {
    return (await w.db.select().from(w.schema.approvals).where(w.eq(w.schema.approvals.id, id)))[0];
}

/** Who was notified about this approval. */
async function notified(w: World, approvalId: string) {
    const rows = await w.db.select().from(w.schema.notifications).where(w.eq(w.schema.notifications.sourceId, approvalId));
    return rows.map((r) => r.userId).sort();
}

/** System messages addressed to an agent with this metadata flag. */
async function messagesTo(w: World, agentId: string, flag: string) {
    const rows = await w.db.select().from(w.schema.threadMessages).where(w.eq(w.schema.threadMessages.targetAgentId, agentId));
    return rows.filter((m) => (m.metadataJson as Record<string, unknown>)[flag] !== undefined);
}

const patch = async (who: { userId: string; sessionId: string }, approvalId: string, status: "approved" | "rejected") => {
    actAs(who);
    try {
        return await call((await import("@/app/api/approvals/[id]/route")).PATCH as never, `/api/approvals/${approvalId}`, { method: "PATCH", body: { status }, params: { id: approvalId } });
    } finally {
        actAs(null);
    }
};

const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;

maybe("a boss agent approves a deploy it is itself allowed to do; the requester learns who decided", async () => {
    const w = await world();
    await w.setPolicies(w.dev.id, { deploy: "allowed" });
    const qa = await mcpClientFor(w.companyId, w.qa.id);
    const asked = parse((await qa.tool("check_action", { action: "deploy", details: { target: "production", version: "1.2.0" } })).text);
    assert.equal(asked.decision, "approval_pending");
    const approvalId = asked.approvalId as string;

    const row = await approvalRow(w, approvalId);
    assert.equal(row.approverKind, "agent");
    assert.equal(row.approverAgentId, w.dev.id, "Qa's manager, who may deploy");
    assert.deepEqual(await notified(w, approvalId), [], "no person is notified while an agent decides");

    // Dev is woken in its own thread with what, who, why and how to decide.
    const [wake] = await messagesTo(w, w.dev.id, "approvalWake");
    assert.ok(wake, "the boss agent is woken");
    assert.equal(wake.deliveryState, "queued");
    assert.equal(wake.senderType, "system");
    assert.match(wake.text, /decide_approval/);
    assert.match(wake.text, /"Qa"/);
    assert.match(wake.text, /production/);
    assert.match(wake.text, /emperor_decide_approval/, "names the Hermes tool too");
    assert.match(wake.text, /in the end to a person/, "says it escalates to a person if it can't decide");

    const dev = await mcpClientFor(w.companyId, w.dev.id);
    const pending = parse((await dev.tool("list_pending_approvals", {})).text).approvals as { approvalId: string; requestedBy: string }[];
    assert.deepEqual(pending.map((p) => [p.approvalId, p.requestedBy]), [[approvalId, "Qa"]]);
    // The requester cannot decide its own ask; nor can an agent it was not routed to.
    const own = await qa.tool("decide_approval", { approvalId, decision: "approve" });
    assert.equal(own.isError, true);
    assert.match(own.text, /your own request/);
    // A connection not bound to an agent (operator / shared bridge token) never decides or lists, whatever it names.
    const operator = await mcpClientFor(w.companyId, null);
    for (const [tool, args] of [["decide_approval", { approvalId, decision: "approve" }], ["list_pending_approvals", {}]] as const) {
        const refused = await operator.tool(tool, args);
        assert.equal(refused.isError, true);
        assert.match(refused.text, /Approving needs this agent's own token/);
    }
    const bossClient = await mcpClientFor(w.companyId, w.boss.id);
    const notBoss = await bossClient.tool("decide_approval", { approvalId, decision: "approve" });
    assert.equal(notBoss.isError, true);
    assert.match(notBoss.text, /not found/);

    const decided = await dev.tool("decide_approval", { approvalId, decision: "approve", note: "Green CI, go" });
    assert.equal(decided.isError, false, decided.text);
    const stored = await approvalRow(w, approvalId);
    assert.equal(stored.status, "approved");
    assert.equal(stored.resolverAgentId, w.dev.id);
    assert.equal(stored.resolverUserId, null);

    const [told] = await messagesTo(w, w.qa.id, "approvalDecision");
    assert.match(told.text, /Decided by Dev \(agent\)\./);
    const [settledWake] = await messagesTo(w, w.dev.id, "approvalWake");
    assert.equal(settledWake.deliveryState, "resolved", "the decided ask no longer wakes Dev");

    // The grant works like a person's: one matching call goes through.
    const again = parse((await qa.tool("check_action", { action: "deploy", details: { target: "production", version: "1.2.0" } })).text);
    assert.equal(again.mayProceed, true);

    // A second decision loses and says who won.
    const late = await dev.tool("decide_approval", { approvalId, decision: "deny" });
    assert.equal(late.isError, true);
    assert.match(late.text, /Already decided by Dev \(agent\) \(approved\)/);
});

maybe("a boss without the permission is skipped at creation, and refused at decision time if revoked", async () => {
    const w = await world();
    await w.db.update(w.schema.agents).set({ ownerUserId: w.jose.userId }).where(w.eq(w.schema.agents.id, w.qa.id));
    const qa = await mcpClientFor(w.companyId, w.qa.id);
    // Neither Dev nor Boss may deploy (default: ask first): the ask goes to Qa's owner, Jose.
    const first = parse((await qa.tool("check_action", { action: "deploy", details: { target: "staging" } })).text);
    const row = await approvalRow(w, first.approvalId as string);
    assert.equal(row.approverKind, "users");
    assert.deepEqual(row.approverUserIds, [w.jose.userId]);
    assert.deepEqual(await notified(w, row.id), [w.jose.userId], "only the approver is notified");
    assert.equal((await messagesTo(w, w.dev.id, "approvalWake")).length, 0);

    // Dev may deploy when Qa asks; then its permission is taken away before it decides.
    await w.setPolicies(w.dev.id, { deploy: "allowed" });
    const second = parse((await qa.tool("check_action", { action: "deploy", details: { target: "production" } })).text);
    assert.equal((await approvalRow(w, second.approvalId as string)).approverAgentId, w.dev.id);
    await w.setPolicies(w.dev.id, { deploy: "ask" });
    const dev = await mcpClientFor(w.companyId, w.dev.id);
    const refused = await dev.tool("decide_approval", { approvalId: second.approvalId, decision: "approve" });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /not allowed to do this action itself/);
    assert.equal((await approvalRow(w, second.approvalId as string)).status, "pending", "it waits for the next approver");
    const listed = parse((await dev.tool("list_pending_approvals", {})).text).approvals as unknown[];
    assert.deepEqual(listed, [], "it no longer lists what it may not decide");
});

maybe("an action type Emperor can't classify skips every agent and goes to people", async () => {
    const w = await world();
    await w.setPolicies(w.dev.id, { deploy: "allowed", send_email: "allowed", spend_money: "allowed", delete_data: "allowed", post_social: "allowed" });
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const unknown = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Wire the payment")).id], requesterAgentId: w.qa.id, rationale: "Pay vendor", actionType: "Wire Transfer" }))!;
    assert.equal(unknown.approverKind, "admins", "no agent may decide it; no person on the chart or owner, so owners and admins");
    assert.ok(!(unknown.approverChainJson as { kind: string }[]).some((s) => s.kind === "agent"));
    // A known action in another spelling is still the boss's to decide.
    const known = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Email the client")).id], requesterAgentId: w.qa.id, rationale: "Send", actionType: "Send-Email" }))!;
    assert.equal(known.approverAgentId, w.dev.id);
    // The request_approval result names people to an agent only as "a person".
    await w.db.update(w.schema.agents).set({ approvalSettingsJson: { mode: "people", userIds: [w.jose.userId] } }).where(w.eq(w.schema.agents.id, w.qa.id));
    const qa = await mcpClientFor(w.companyId, w.qa.id);
    const asked = parse((await qa.tool("request_approval", { taskId: (await w.newTask("Ship it")).id, rationale: "Ready" })).text);
    assert.equal(asked.waitingOn, "a person");
    assert.ok(!JSON.stringify(asked).includes("Jose"));
});

maybe("a team lead whose team names it as approver goes to its own manager, not straight to admins", async () => {
    const w = await world();
    await w.db.update(w.schema.companies).set({ approvalSettingsJson: { teamApprovers: { [w.team.id]: { mode: "agent", agentId: w.dev.id } } } }).where(w.eq(w.schema.companies.id, w.companyId));
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const fromDev = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Lead's own work")).id], requesterAgentId: w.dev.id, rationale: "Done" }))!;
    assert.equal(fromDev.approverAgentId, w.boss.id);
    const fromQa = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Member work")).id], requesterAgentId: w.qa.id, rationale: "Done" }))!;
    assert.equal(fromQa.approverAgentId, w.dev.id);
});

maybe("an agent decision is atomic with the step it checked", async () => {
    const w = await world();
    const { requestApprovalForTasks, resolveApprovalOutcome } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Race")).id], requesterAgentId: w.qa.id, rationale: "Done" }))!;
    // The ask moved on (level 1) after the decider read level 0: the decision must not land.
    await w.db.update(w.schema.approvals).set({ escalationLevel: 1 }).where(w.eq(w.schema.approvals.id, approval.id));
    const outcome = await resolveApprovalOutcome({ companyId: w.companyId, approvalId: approval.id, resolverAgentId: w.dev.id, status: "approved", expectedEscalationLevel: 0 });
    assert.equal(outcome.decided, false);
    assert.equal((await approvalRow(w, approval.id)).status, "pending");
});

maybe("only members who can decide are approvers: viewers are refused, restricted members out of scope are skipped", async () => {
    const w = await world();
    const viewer = await seedHuman(w.companyId, "viewer");
    const route = await import("@/app/api/agents/[id]/approvers/route");
    actAs(w.owner);
    const put = await call(route.PUT as never, `/api/agents/${w.qa.id}/approvers`, { method: "PUT", body: { approvers: { mode: "people", userIds: [viewer.userId] } }, params: { id: w.qa.id } });
    const got = await call(route.GET as never, `/api/agents/${w.qa.id}/approvers`, { params: { id: w.qa.id } });
    actAs(null);
    assert.equal(put.status, 400, put.text);
    const people = ((got.json.options as { people: { id: string }[] }).people).map((p) => p.id);
    assert.ok(!people.includes(viewer.userId), "the picker offers no viewers");

    // A restricted member who can't see the ask's project is skipped at resolve time.
    const outsider = await seedHuman(w.companyId, "member", { scope: { mode: "restricted", agentIds: [w.qa.id], customerIds: [] } });
    await w.db.update(w.schema.agents).set({ approvalSettingsJson: { mode: "people", userIds: [outsider.userId] } }).where(w.eq(w.schema.agents.id, w.qa.id));
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Scoped")).id], requesterAgentId: w.qa.id, rationale: "Done" }))!;
    assert.equal(approval.approverAgentId, w.dev.id, "falls through to the chart");
    assert.ok(!JSON.stringify(approval.approverChainJson).includes(outsider.userId));
});

maybe("people approvers: a non-approver gets 403, the approver decides, an owner overrides, the loser learns who won", async () => {
    const w = await world();
    await w.db.update(w.schema.agents).set({ approvalSettingsJson: { mode: "people", userIds: [w.jose.userId] } }).where(w.eq(w.schema.agents.id, w.qa.id));
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const first = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Ship the landing page")).id], requesterAgentId: w.qa.id, rationale: "Done, screenshots attached" }))!;
    assert.equal(first.approverKind, "users");
    assert.deepEqual(await notified(w, first.id), [w.jose.userId], "Jose only: not the owner, not Luis");

    const asLuis = await patch(w.luis, first.id, "approved");
    assert.equal(asLuis.status, 403, asLuis.text);
    assert.match(String(asLuis.json.error), /^Waiting on another approver/);
    assert.ok(!asLuis.text.includes("Jose"), "the 403 names nobody");

    // The card: no buttons and no approver names for Luis, but the ask's reason as before.
    const cardRoute = await import("@/app/api/approvals/[id]/card/route");
    actAs(w.luis);
    const card = await call(cardRoute.GET as never, `/api/approvals/${first.id}/card`, { params: { id: first.id } });
    actAs(w.jose);
    const joseCard = await call(cardRoute.GET as never, `/api/approvals/${first.id}/card`, { params: { id: first.id } });
    actAs(null);
    const cardBody = card.json.card as Record<string, unknown>;
    assert.equal(cardBody.mayDecide, false);
    assert.deepEqual(cardBody.waitingOn, { kind: "hidden", names: [] });
    assert.equal(cardBody.rationale, "Done, screenshots attached");
    assert.deepEqual((joseCard.json.card as Record<string, unknown>).waitingOn, { kind: "users", names: ["Jose"] });

    const asJose = await patch(w.jose, first.id, "approved");
    assert.equal(asJose.status, 200, asJose.text);
    const late = await patch(w.owner, first.id, "rejected");
    assert.equal(late.status, 409, late.text);
    assert.equal(late.json.decidedBy, "Jose");
    assert.match(String(late.json.error), /Already decided by Jose/);
    const [told] = await messagesTo(w, w.qa.id, "approvalDecision");
    assert.match(told.text, /Decided by Jose\./);

    // An owner may decide an ask that waits on someone else.
    const second = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Publish the blog post")).id], requesterAgentId: w.qa.id, rationale: "Ready" }))!;
    const override = await patch(w.owner, second.id, "rejected");
    assert.equal(override.status, 200, override.text);
    assert.equal((await approvalRow(w, second.id)).resolverUserId, w.owner.userId);

    // The Inbox: Jose's needs-me list has his asks; the owner sees others' only under "All approvals".
    const third = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Send the newsletter")).id], requesterAgentId: w.qa.id, rationale: "Ready" }))!;
    const { buildAttention } = await import("@/lib/attention");
    const forJose = await buildAttention(w.companyId, { userId: w.jose.userId, isOwnerOrAdmin: false, canAct: true, scope: null });
    assert.ok(forJose.entries.some((e) => e.approvalId === third.id));
    assert.deepEqual(forJose.entries.find((e) => e.approvalId === third.id)?.waitingOn, { kind: "users", names: ["Jose"] });
    const forLuis = await buildAttention(w.companyId, { userId: w.luis.userId, isOwnerOrAdmin: false, canAct: true, scope: null });
    assert.ok(!forLuis.entries.some((e) => e.approvalId === third.id), "not Luis's to decide");
    const forOwner = await buildAttention(w.companyId, { userId: w.owner.userId, isOwnerOrAdmin: true, canAct: true, scope: null });
    assert.ok(!forOwner.entries.some((e) => e.approvalId === third.id), "not counted as needing the owner");
    assert.ok(forOwner.otherApprovals.some((e) => e.approvalId === third.id), "but listed under All approvals");
});

maybe("the escalation sweep moves an undecided ask up the chain after the timeout, once per step", async () => {
    const w = await world();
    const { requestApprovalForTasks, escalateStaleApprovals } = await import("@/lib/approvals");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Close the sprint")).id], requesterAgentId: w.qa.id, rationale: "All done" }))!;
    assert.equal(approval.approverAgentId, w.dev.id, "task asks follow the chart: Dev");
    const steps = approval.approverChainJson as { kind: string; agentId?: string }[];
    assert.deepEqual(steps.map((s) => s.agentId ?? s.kind), [w.dev.id, w.boss.id, "admins"]);

    const age = (minutes: number) => w.db.update(w.schema.approvals)
        .set({ requestedAt: new Date(Date.now() - minutes * 60_000), escalatedAt: null }).where(w.eq(w.schema.approvals.id, approval.id));

    // Not yet: 20 of 30 minutes.
    await age(20);
    assert.equal(await escalateStaleApprovals(new Date()), 0);

    await age(31);
    assert.equal(await escalateStaleApprovals(new Date()), 1);
    let row = await approvalRow(w, approval.id);
    assert.equal(row.escalationLevel, 1);
    assert.equal(row.approverAgentId, w.boss.id);
    assert.ok(row.escalatedAt);
    assert.equal((await messagesTo(w, w.boss.id, "approvalWake")).length, 1, "Boss is woken");
    const [devWake] = await messagesTo(w, w.dev.id, "approvalWake");
    assert.equal(devWake.deliveryState, "resolved", "Dev, passed over, is no longer woken for it");
    assert.equal(await escalateStaleApprovals(new Date()), 0, "a repeat pass is a no-op");

    // The note in the card thread (Qa's direct thread).
    const direct = await ensureDirectThread(w.companyId, w.qa.id, null);
    const notes = (await w.db.select().from(w.schema.threadMessages).where(w.eq(w.schema.threadMessages.threadId, direct.id)))
        .filter((m) => (m.metadataJson as Record<string, unknown>).approvalEscalation !== undefined);
    assert.deepEqual(notes.map((n) => n.text), ["Waiting longer than 30 min — escalated to Boss (agent)."]);
    assert.equal(notes[0].targetAgentId, null, "the note wakes nobody");

    // Dev, reached before, may still decide; first, the next step: owners and admins.
    await w.db.update(w.schema.approvals).set({ escalatedAt: new Date(Date.now() - 31 * 60_000) }).where(w.eq(w.schema.approvals.id, approval.id));
    assert.equal(await escalateStaleApprovals(new Date()), 1);
    row = await approvalRow(w, approval.id);
    assert.equal(row.approverKind, "admins");
    assert.deepEqual(await notified(w, approval.id), [w.owner.userId], "owners and admins only once it reaches them");
    assert.equal(await escalateStaleApprovals(new Date(Date.now() + 120 * 60_000)), 0, "the top of the chain does not escalate");

    const dev = await mcpClientFor(w.companyId, w.dev.id);
    const decided = await dev.tool("decide_approval", { approvalId: approval.id, decision: "approve" });
    assert.equal(decided.isError, false, decided.text);
});

maybe("a company's own escalation time applies, and only owners and admins change approval settings", async () => {
    const w = await world();
    const route = await import("@/app/api/approval-settings/route");
    actAs(w.jose);
    const denied = await call(route.PUT as never, "/api/approval-settings", { method: "PUT", body: { escalateAfterMinutes: 60 } });
    actAs(null);
    assert.equal(denied.status, 403);

    actAs(w.owner);
    const saved = await call(route.PUT as never, "/api/approval-settings", { method: "PUT", body: { escalateAfterMinutes: 60, teamApprovers: { [w.team.id]: { mode: "people", userIds: [w.luis.userId] } } } });
    const bad = await call(route.PUT as never, "/api/approval-settings", { method: "PUT", body: { escalateAfterMinutes: 1 } });
    actAs(null);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.escalateAfterMinutes, 60);
    assert.equal(bad.status, 400);

    // The team's approvers now apply to Qa (no agent setting of its own).
    const { requestApprovalForTasks, escalateStaleApprovals } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Ship docs")).id], requesterAgentId: w.qa.id, rationale: "Ready" }))!;
    assert.deepEqual(approval.approverUserIds, [w.luis.userId]);
    await w.db.update(w.schema.approvals).set({ requestedAt: new Date(Date.now() - 45 * 60_000) }).where(w.eq(w.schema.approvals.id, approval.id));
    assert.equal(await escalateStaleApprovals(new Date()), 0, "45 of 60 minutes");

    // An agent's own approvers (owners and admins set them) take precedence over the team's.
    const agentRoute = await import("@/app/api/agents/[id]/approvers/route");
    actAs(w.jose);
    const memberPut = await call(agentRoute.PUT as never, `/api/agents/${w.qa.id}/approvers`, { method: "PUT", body: { approvers: { mode: "agent", agentId: w.boss.id } }, params: { id: w.qa.id } });
    actAs(w.owner);
    const self = await call(agentRoute.PUT as never, `/api/agents/${w.qa.id}/approvers`, { method: "PUT", body: { approvers: { mode: "agent", agentId: w.qa.id } }, params: { id: w.qa.id } });
    const ok = await call(agentRoute.PUT as never, `/api/agents/${w.qa.id}/approvers`, { method: "PUT", body: { approvers: { mode: "agent", agentId: w.boss.id } }, params: { id: w.qa.id } });
    actAs(null);
    assert.equal(memberPut.status, 403);
    assert.equal(self.status, 400, "no self-approval");
    assert.equal(ok.status, 200, ok.text);
    const chain = (ok.json.chain as { steps: { kind: string; names: string[] }[] }).steps;
    assert.deepEqual(chain.map((s) => s.kind === "admins" ? "admins" : s.names.join("+")), ["Boss", "admins"]);
    const next = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Ship more docs")).id], requesterAgentId: w.qa.id, rationale: "Ready" }))!;
    assert.equal(next.approverAgentId, w.boss.id);
});

maybe("an ask from before routing keeps the old rules: owners and admins notified, any member decides", async () => {
    const w = await world();
    const task = await w.newTask("Legacy");
    const [legacy] = await w.db.insert(w.schema.approvals).values({ companyId: w.companyId, projectId: w.project.id, requesterAgentId: w.qa.id, rationale: "old" }).returning();
    await w.db.insert(w.schema.approvalTaskLinks).values({ companyId: w.companyId, approvalId: legacy.id, taskId: task.id });
    const asLuis = await patch(w.luis, legacy.id, "approved");
    assert.equal(asLuis.status, 200, asLuis.text);
});

maybe("REST twins for runtimes without MCP tools: GET /approvals/pending and POST /approvals/{id}/decide", async () => {
    const w = await world();
    const { bearer, seedMcpToken } = await import("./_access-helper");
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [(await w.newTask("Merge the PR")).id], requesterAgentId: w.qa.id, rationale: "Reviewed" }))!;
    const devToken = await seedMcpToken(w.companyId, w.dev.id);
    const operator = await seedMcpToken(w.companyId, null);
    const pending = await import("@/app/api/mcp/approvals/pending/route");
    const listed = await call(pending.GET as never, "/api/mcp/approvals/pending", { headers: bearer(devToken) });
    assert.equal(listed.status, 200, listed.text);
    assert.deepEqual((listed.json.approvals as { approvalId: string }[]).map((a) => a.approvalId), [approval.id]);
    const unnamed = await call(pending.GET as never, "/api/mcp/approvals/pending?agentId=" + w.dev.id, { headers: bearer(operator) });
    assert.equal(unnamed.status, 403, "a company-wide token never lists, even naming the agent");

    const decide = await import("@/app/api/mcp/approvals/[id]/decide/route");
    const qaToken = await seedMcpToken(w.companyId, w.qa.id);
    const own = await call(decide.POST as never, `/api/mcp/approvals/${approval.id}/decide`, { method: "POST", headers: bearer(qaToken), body: { decision: "approve" }, params: { id: approval.id } });
    assert.equal(own.status, 403, "the requester never decides its own ask");
    const impersonated = await call(decide.POST as never, `/api/mcp/approvals/${approval.id}/decide`, { method: "POST", headers: bearer(operator), body: { decision: "deny", agentId: w.dev.id }, params: { id: approval.id } });
    assert.equal(impersonated.status, 403, "a company-wide token naming the boss is refused");
    assert.match(String(impersonated.json.error), /own token/);
    assert.equal((await approvalRow(w, approval.id)).status, "pending");
    const ok = await call(decide.POST as never, `/api/mcp/approvals/${approval.id}/decide`, { method: "POST", headers: bearer(devToken), body: { decision: "deny", note: "Add tests" }, params: { id: approval.id } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((ok.json.approval as { status: string }).status, "rejected");
    const again = await call(decide.POST as never, `/api/mcp/approvals/${approval.id}/decide`, { method: "POST", headers: bearer(devToken), body: { decision: "approve" }, params: { id: approval.id } });
    assert.equal(again.status, 409);
    assert.match(String(again.json.error), /Already decided by Dev \(agent\) \(rejected\)/);
});

maybe("an explicitly chosen approver works without an org chart; mutual pairs are refused; people stay unnamed to non-admins", async () => {
    await resetDb();
    const db = await getDb();
    const schema = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [creator] = await db.insert(schema.users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(schema.companies).values({ name: "No Chart Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const owner = await seedHuman(companyId, "owner");
    const member = await seedHuman(companyId, "member");
    await db.update(schema.users).set({ displayName: "Olivia" }).where(eq(schema.users.id, owner.userId));
    const builder = await seedAgent(companyId, { name: "Builder" });
    const architect = await seedAgent(companyId, { name: "Architect" });
    const [project] = await db.insert(schema.projects).values({ companyId, goal: "Site", status: "active" }).returning();
    const [task] = await db.insert(schema.tasks).values({ companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: builder.id, inputJson: { title: "Build" } }).returning();

    const route = await import("@/app/api/agents/[id]/approvers/route");
    const put = async (agentId: string, approvers: unknown) => call(route.PUT as never, `/api/agents/${agentId}/approvers`, { method: "PUT", body: { approvers }, params: { id: agentId } });
    actAs(owner);
    const set = await put(builder.id, { mode: "agent", agentId: architect.id });
    const mutual = await put(architect.id, { mode: "agent", agentId: builder.id });
    actAs(null);
    assert.equal(set.status, 200, set.text);
    const steps = (set.json.chain as { steps: { kind: string; names: string[] }[] }).steps;
    assert.deepEqual(steps.map((s) => s.kind === "agent" ? s.names[0] : s.kind), ["Architect", "admins"], "Asks go to: Architect → owners and admins");
    assert.equal(mutual.status, 400, "the two would approve each other");
    assert.match(String(mutual.json.error), /approve each other/);

    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId, taskIds: [task.id], requesterAgentId: builder.id, rationale: "Done" }))!;
    assert.equal(approval.approverAgentId, architect.id);
    const architectClient = await mcpClientFor(companyId, architect.id);
    const decided = await architectClient.tool("decide_approval", { approvalId: approval.id, decision: "approve" });
    assert.equal(decided.isError, false, decided.text);

    // A mutual pair written behind the API's back is unusable at resolve time.
    await db.update(schema.agents).set({ approvalSettingsJson: { mode: "agent", agentId: builder.id } }).where(eq(schema.agents.id, architect.id));
    const [task2] = await db.insert(schema.tasks).values({ companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: builder.id, inputJson: { title: "More" } }).returning();
    const second = (await requestApprovalForTasks({ companyId, taskIds: [task2.id], requesterAgentId: builder.id, rationale: "Done" }))!;
    assert.equal(second.approverKind, "admins");

    // People approvers are named only to owners and admins.
    await db.update(schema.agents).set({ approvalSettingsJson: { mode: "people", userIds: [owner.userId] } }).where(eq(schema.agents.id, builder.id));
    actAs(member);
    const asMember = await call(route.GET as never, `/api/agents/${builder.id}/approvers`, { params: { id: builder.id } });
    actAs(owner);
    const asOwner = await call(route.GET as never, `/api/agents/${builder.id}/approvers`, { params: { id: builder.id } });
    actAs(null);
    assert.equal(asMember.status, 200, asMember.text);
    assert.ok(!asMember.text.includes("Olivia"), "no names for a non-admin");
    assert.deepEqual((asMember.json.chain as { steps: unknown[] }).steps[0], { kind: "hidden", names: [] });
    assert.deepEqual((asOwner.json.chain as { steps: unknown[] }).steps[0], { kind: "users", names: ["Olivia"] });
});
