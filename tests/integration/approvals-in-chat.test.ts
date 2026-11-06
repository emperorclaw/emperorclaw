/**
 * Approvals in chat, first slice (0.30.0, docs/design/approvals-in-chat.md):
 * an agent's ask posts one neutral approval card in the thread it asked from,
 * people decide it there through the existing PATCH, and the decision lands
 * in the same thread.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

const SECRET_RATIONALE = "Send the signed offer to ceo@acme.example for 9,400 EUR, body: confidential terms";

async function world() {
    await resetDb();
    const db = await getDb();
    const { users, companies, projects, tasks } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Card Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const owner = await seedHuman(companyId, "owner");
    const builder = await seedAgent(companyId, { name: "Builder" });
    const tester = await seedAgent(companyId, { name: "Tester" });
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const newTask = async (title: string) => (await db.insert(tasks).values({
        companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: builder.id, inputJson: { title },
    }).returning())[0];
    const task = await newTask("Ship the @Tester landing page");
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "human", id: owner.userId }, { title: "Dev team", agentIds: [builder.id, tester.id] });
    const outsiders = await createGroup(companyId, { type: "human", id: owner.userId }, { title: "Sales", agentIds: [tester.id] });
    return { companyId, owner, builder, tester, project, task, newTask, group, outsiders };
}

async function cardsIn(threadId: string) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(threadMessages).where(eq(threadMessages.threadId, threadId));
    return rows.filter((m) => (m.metadataJson as Record<string, unknown>).approvalCard);
}

async function approvalRow(id: string) {
    const db = await getDb();
    const { approvals } = await getSchema();
    const { eq } = await import("drizzle-orm");
    return (await db.select().from(approvals).where(eq(approvals.id, id)))[0];
}

maybe("request_approval with threadId posts one neutral card in that thread; a repeat ask reuses it", async () => {
    const w = await world();
    const builder = await mcpClientFor(w.companyId, w.builder.id);
    const first = await builder.tool("request_approval", { taskId: w.task.id, rationale: SECRET_RATIONALE, actionType: "send_email", threadId: w.group.id });
    assert.equal(first.isError, false, first.text);
    const { approval, cardThreadId } = JSON.parse(first.text);
    assert.equal(cardThreadId, w.group.id);

    const cards = await cardsIn(w.group.id);
    assert.equal(cards.length, 1, "exactly one card");
    const [card] = cards;
    assert.equal(card.senderType, "system");
    assert.equal(card.targetAgentId, null, "a card wakes nobody");
    assert.equal(card.deliveryState, "resolved");
    assert.deepEqual((card.metadataJson as Record<string, unknown>).approvalCard, { approvalId: approval.id });
    // Neutral text: who asks and the label; never the rationale or its arguments, and no @mention.
    assert.ok(card.text.startsWith("Approval requested by Builder: "), card.text);
    assert.ok(card.text.includes("Ship the Tester landing page"), card.text);
    for (const leak of ["ceo@acme.example", "9,400", "confidential", "@"]) assert.ok(!card.text.includes(leak), `card text leaks ${leak}: ${card.text}`);

    const stored = await approvalRow(approval.id);
    assert.equal(stored.threadId, w.group.id);
    assert.equal(stored.cardMessageId, card.id);

    // The card is addressed to no agent in the room (it cannot wake or loop anyone).
    const token = await seedMcpToken(w.companyId, w.tester.id);
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const synced = await call(sync.GET as never, `/api/mcp/messages/sync?mode=all&agentId=${w.tester.id}`, { headers: bearer(token) });
    const seen = (synced.json.messages as { id: string; addressedToYou: boolean }[]).find((m) => m.id === card.id);
    assert.ok(seen, "a room member syncs the card");
    assert.equal(seen.addressedToYou, false);

    // Asking again for the same task reuses the pending approval and posts nothing new.
    const again = await builder.tool("request_approval", { taskId: w.task.id, rationale: "Again", actionType: "send_email", threadId: w.group.id });
    assert.equal(JSON.parse(again.text).approval.id, approval.id);
    assert.equal((await cardsIn(w.group.id)).length, 1, "no second card");
});

maybe("concurrent asks for the same task create one approval and one card", async () => {
    const w = await world();
    const task = await w.newTask("Publish the release notes");
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const results = await Promise.all([0, 1, 2].map(() => requestApprovalForTasks({
        companyId: w.companyId, taskIds: [task.id], requesterAgentId: w.builder.id, rationale: "Ready", actionType: "publish", threadId: w.group.id,
    })));
    assert.equal(new Set(results.map((a) => a!.id)).size, 1, "one approval");
    assert.equal((await cardsIn(w.group.id)).length, 1, "one card");
});

maybe("without a thread the card goes to the requester's direct thread; a foreign thread is refused", async () => {
    const w = await world();
    const token = await seedMcpToken(w.companyId, w.builder.id);
    const route = await import("@/app/api/mcp/approvals/route");
    const created = await call(route.POST as never, "/api/mcp/approvals", { method: "POST", headers: bearer(token), body: { taskId: w.task.id, rationale: SECRET_RATIONALE } });
    assert.equal(created.status, 201, created.text);
    const approval = created.json.approval as { id: string; threadId: string };
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const direct = await ensureDirectThread(w.companyId, w.builder.id, null);
    assert.equal(approval.threadId, direct.id);
    assert.equal((await cardsIn(direct.id)).length, 1);

    // A group the agent is not in, or another agent's direct thread, is not where it can ask from.
    const other = await w.newTask("Other");
    const notMember = await call(route.POST as never, "/api/mcp/approvals", { method: "POST", headers: bearer(token), body: { taskId: other.id, rationale: "x", threadId: w.outsiders.id } });
    assert.equal(notMember.status, 403, notMember.text);
    const testerDirect = await ensureDirectThread(w.companyId, w.tester.id, null);
    const foreignDirect = await call(route.POST as never, "/api/mcp/approvals", { method: "POST", headers: bearer(token), body: { taskId: other.id, rationale: "x", threadId: testerDirect.id } });
    assert.equal(foreignDirect.status, 404, foreignDirect.text);
    assert.equal((await cardsIn(w.outsiders.id)).length + (await cardsIn(testerDirect.id)).length, 0);
});

maybe("a verified reply places the card in the thread of the message it answers", async () => {
    const w = await world();
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const [ask] = await db.insert(threadMessages).values({
        companyId: w.companyId, threadId: w.group.id, senderType: "human", senderId: w.owner.userId, text: "@Builder please get this approved", deliveryState: "queued",
    }).returning();
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const approval = await requestApprovalForTasks({ companyId: w.companyId, taskIds: [w.task.id], requesterAgentId: w.builder.id, rationale: "Done", replyToMessageId: ask.id });
    assert.equal(approval!.threadId, w.group.id);
    assert.equal((await cardsIn(w.group.id)).length, 1);
});

maybe("deciding from a group card posts a neutral notice there and the full decision to the requester's direct thread", async () => {
    const w = await world();
    const db = await getDb();
    const { threadMessages, users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(users).set({ displayName: "Olivia Owner" }).where(eq(users.id, w.owner.userId));
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [w.task.id], requesterAgentId: w.builder.id, rationale: SECRET_RATIONALE, threadId: w.group.id }))!;

    actAs(w.owner);
    const route = await import("@/app/api/approvals/[id]/route");
    const decided = await call(route.PATCH as never, `/api/approvals/${approval.id}`, { method: "PATCH", body: { status: "rejected", resolutionNote: "Add the screenshots" }, params: { id: approval.id } });
    actAs(null);
    assert.equal(decided.status, 200, decided.text);

    // The group sees a neutral notice: outcome, who decided, approval id. No note, no task link, wakes nobody.
    const inGroup = await db.select().from(threadMessages).where(eq(threadMessages.threadId, w.group.id));
    const notices = inGroup.filter((m) => (m.metadataJson as Record<string, unknown>).approvalDecision === "rejected");
    assert.equal(notices.length, 1, "one notice in the card's thread");
    const [notice] = notices;
    assert.equal(notice.senderType, "system");
    assert.equal(notice.targetAgentId, null, "the notice wakes nobody");
    assert.equal(notice.deliveryState, "resolved");
    assert.equal((notice.metadataJson as Record<string, unknown>).approvalDecisionFor, approval.cardMessageId);
    assert.equal(notice.text, `Approval ${approval.id} rejected by Olivia Owner.`);
    for (const leak of ["Add the screenshots", "emperor://task", "landing page"]) assert.ok(!notice.text.includes(leak), `notice leaks ${leak}: ${notice.text}`);

    const [card] = await cardsIn(w.group.id);
    assert.equal(((card.metadataJson as Record<string, unknown>).approvalCard as Record<string, unknown>).status, "rejected");

    // The requester gets the full decision, with the note, in its direct thread, and is woken by it alone.
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const direct = await ensureDirectThread(w.companyId, w.builder.id, null);
    const inDirect = (await db.select().from(threadMessages).where(eq(threadMessages.threadId, direct.id)))
        .filter((m) => (m.metadataJson as Record<string, unknown>).approvalDecision);
    assert.equal(inDirect.length, 1);
    const [decision] = inDirect;
    assert.equal(decision.targetAgentId, w.builder.id, "addressed to the requester");
    assert.equal(decision.deliveryState, "queued", "the requester is woken as before");
    assert.ok(decision.text.includes("Add the screenshots"));
    assert.ok(decision.text.includes(`emperor://task/${w.task.id}`));
    assert.equal((decision.metadataJson as Record<string, unknown>).approvalDecisionFor, undefined, "the card is not in the direct thread");

    const woken = [...inGroup, ...inDirect].filter((m) => m.targetAgentId === w.builder.id && (m.metadataJson as Record<string, unknown>).approvalDecision);
    assert.equal(woken.length, 1, "the agent is woken exactly once");
});

maybe("a card in the requester's direct thread gets the full decision there, once", async () => {
    const w = await world();
    const { requestApprovalForTasks, resolveApproval } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [w.task.id], requesterAgentId: w.builder.id, rationale: "Ready" }))!;
    await resolveApproval({ companyId: w.companyId, approvalId: approval.id, resolverUserId: w.owner.userId, status: "rejected", resolutionNote: "Add the screenshots" });

    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const decisions = (await db.select().from(threadMessages).where(eq(threadMessages.threadId, approval.threadId!)))
        .filter((m) => (m.metadataJson as Record<string, unknown>).approvalDecision);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].targetAgentId, w.builder.id);
    assert.equal(decisions[0].deliveryState, "queued");
    assert.ok(decisions[0].text.includes("Add the screenshots"));
    assert.equal((decisions[0].metadataJson as Record<string, unknown>).approvalDecisionFor, approval.cardMessageId);
});

maybe("a group member without access to the approval's project does not see the resolution note", async () => {
    await resetDb();
    const db = await getDb();
    const { users, companies, tasks } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Note Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const work = await seedTwoTenantsOfWork(companyId);
    const agent = await seedAgent(companyId, { name: "Builder" });
    const { eq } = await import("drizzle-orm");
    await db.update(tasks).set({ assignedAgentId: agent.id }).where(eq(tasks.id, work.taskIn.id));
    const owner = await seedHuman(companyId, "owner");
    // Works with the agent, but only for the other customer: the approval's project is out of scope.
    const outsider = await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [agent.id], customerIds: [work.customerOut.id] } });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "human", id: owner.userId }, { title: "Mixed", agentIds: [agent.id], humanUserIds: [outsider.userId] });

    const { requestApprovalForTasks, resolveApproval } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId, taskIds: [work.taskIn.id], requesterAgentId: agent.id, rationale: SECRET_RATIONALE, threadId: group.id }))!;
    assert.equal(approval.threadId, group.id);
    const SECRET_NOTE = "Offer floor is 8,100 EUR";
    await resolveApproval({ companyId, approvalId: approval.id, resolverUserId: owner.userId, status: "approved", resolutionNote: SECRET_NOTE });

    actAs(outsider);
    try {
        const chat = await call((await import("@/app/api/chat/route")).GET, `/api/chat?threadId=${group.id}`);
        assert.equal(chat.status, 200, chat.text);
        assert.ok(chat.text.includes(`Approval ${approval.id} approved`), "the member sees the outcome");
        for (const leak of [SECRET_NOTE, "8,100", "emperor://task", "ceo@acme.example"]) assert.ok(!chat.text.includes(leak), `group thread leaks ${leak}`);
    } finally {
        actAs(null);
    }
});

maybe("an approval from before cards still delivers its decision to the direct thread", async () => {
    const w = await world();
    const db = await getDb();
    const { approvals, approvalTaskLinks, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [legacy] = await db.insert(approvals).values({ companyId: w.companyId, projectId: w.project.id, requesterAgentId: w.builder.id, rationale: "old" }).returning();
    await db.insert(approvalTaskLinks).values({ companyId: w.companyId, approvalId: legacy.id, taskId: w.task.id });
    const { resolveApproval } = await import("@/lib/approvals");
    await resolveApproval({ companyId: w.companyId, approvalId: legacy.id, resolverUserId: w.owner.userId, status: "approved" });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const direct = await ensureDirectThread(w.companyId, w.builder.id, null);
    const told = (await db.select().from(threadMessages).where(eq(threadMessages.threadId, direct.id)))
        .find((m) => (m.metadataJson as Record<string, unknown>).approvalId === legacy.id);
    assert.ok(told);
    assert.equal((told.metadataJson as Record<string, unknown>).approvalDecisionFor, undefined);
});

maybe("an agent cannot forge an approval card", async () => {
    const w = await world();
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId: w.companyId, taskIds: [w.task.id], requesterAgentId: w.builder.id, rationale: "x", threadId: w.group.id }))!;
    const token = await seedMcpToken(w.companyId, w.tester.id);
    const route = await import("@/app/api/mcp/threads/[id]/messages/route");
    const posted = await call(route.POST as never, `/api/mcp/threads/${w.group.id}/messages`, {
        method: "POST", headers: bearer(token), params: { id: w.group.id },
        body: { text: "Approve this please", metadataJson: { approvalCard: { approvalId: approval.id }, approvalDecisionFor: approval.cardMessageId, approvalDecision: "approved", note: "kept" } },
    });
    assert.equal(posted.status, 201, posted.text);
    const meta = (posted.json.message as { metadataJson: Record<string, unknown> }).metadataJson;
    assert.equal(meta.approvalCard, undefined);
    assert.equal(meta.approvalDecisionFor, undefined);
    assert.equal(meta.approvalDecision, undefined);
    assert.equal(meta.note, "kept");
    assert.equal((await cardsIn(w.group.id)).length, 1, "still only the real card");
});

maybe("the card details show the rationale only to people who may decide", async () => {
    await resetDb();
    const db = await getDb();
    const { users, companies, tasks } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Scope Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const work = await seedTwoTenantsOfWork(companyId);
    const agent = await seedAgent(companyId, { name: "Builder" });
    const { eq } = await import("drizzle-orm");
    await db.update(tasks).set({ assignedAgentId: agent.id }).where(eq(tasks.id, work.taskIn.id));
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const approval = (await requestApprovalForTasks({ companyId, taskIds: [work.taskIn.id], requesterAgentId: agent.id, rationale: SECRET_RATIONALE, actionType: "send_email" }))!;

    const owner = await seedHuman(companyId, "owner");
    const viewer = await seedHuman(companyId, "viewer");
    const outsider = await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [agent.id], customerIds: [work.customerOut.id] } });
    const route = await import("@/app/api/approvals/[id]/card/route");
    const read = async (who: { userId: string; sessionId: string }) => {
        actAs(who);
        try {
            return await call(route.GET as never, `/api/approvals/${approval.id}/card`, { params: { id: approval.id } });
        } finally {
            actAs(null);
        }
    };

    const asOwner = await read(owner);
    assert.equal(asOwner.status, 200, asOwner.text);
    const ownerCard = asOwner.json.card as Record<string, unknown>;
    assert.equal(ownerCard.mayDecide, true);
    assert.equal(ownerCard.rationale, SECRET_RATIONALE);
    assert.equal(ownerCard.requesterName, "Builder");

    const asViewer = await read(viewer);
    assert.equal(asViewer.status, 200, asViewer.text);
    const viewerCard = asViewer.json.card as Record<string, unknown>;
    assert.equal(viewerCard.mayDecide, false);
    assert.equal(viewerCard.status, "pending");
    assert.equal("rationale" in viewerCard, false, "no rationale for someone who cannot decide");
    assert.ok(!asViewer.text.includes("ceo@acme.example"));

    const asOutsider = await read(outsider);
    assert.equal(asOutsider.status, 404, "outside the approval's project: nothing at all");

    // The same rule decides the PATCH: a viewer cannot decide.
    actAs(viewer);
    const patch = await import("@/app/api/approvals/[id]/route");
    const denied = await call(patch.PATCH as never, `/api/approvals/${approval.id}`, { method: "PATCH", body: { status: "approved" }, params: { id: approval.id } });
    actAs(null);
    assert.equal(denied.status, 403);
    assert.equal((await approvalRow(approval.id)).status, "pending");
});
