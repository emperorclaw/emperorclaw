import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

/**
 * buildAttention is the one source for the dashboard panel, /inbox and the
 * Inbox badge. It must merge every kind of item, collapse a multi-task
 * approval into one decision, and filter per viewer: member scope, private
 * direct chats and per-person notifications.
 */
maybe("attention: merged kinds, per-viewer privacy, member scope and palette scope", async () => {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { buildAttention, needsYou } = await import("@/lib/attention");
    const { loadPaletteData } = await import("@/lib/palette");
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000);

    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    const { companyId: otherCompanyId } = await seedCompanyWithToken();
    const [member] = await db.insert(s.users).values({ email: `ana-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Ana" }).returning();
    await db.insert(s.companyMembers).values([
        { companyId, userId: ownerId, role: "owner" },
        { companyId, userId: member.id, role: "member" },
    ]);

    const ada = await seedAgent(companyId, { name: "Ada", provider: "hermes", deploymentMode: "local" });
    const bob = await seedAgent(companyId, { name: "Bob" });
    const cy = await seedAgent(companyId, { name: "Cy", lastSeenAt: new Date() });
    const eve = await seedAgent(companyId, { name: "Eve", lastSeenAt: new Date() });
    const dee = await seedAgent(companyId, { name: "Dee", lastSeenAt: new Date() });
    const outsider = await seedAgent(otherCompanyId, { name: "Outsider" });

    const [northwind, harbor] = await db.insert(s.customers).values([{ companyId, name: "Northwind Dental" }, { companyId, name: "Harbor Bakery" }]).returning();
    const [p1, p2, p3] = await db.insert(s.projects).values([
        { companyId, goal: "Northwind site", status: "active", customerId: northwind.id },
        { companyId, goal: "Harbor menu", status: "active", customerId: harbor.id },
        { companyId, goal: "Internal ops", status: "active" },
    ]).returning();
    const [otherProject] = await db.insert(s.projects).values({ companyId: otherCompanyId, goal: "Other", status: "active" }).returning();

    const [copyA, copyB, implicitTask, stuckTask, blockedTask, otherTask] = await db.insert(s.tasks).values([
        { companyId, projectId: p1.id, taskType: "copy", state: "review", assignedAgentId: ada.id, inputJson: { title: "Pricing copy" } },
        { companyId, projectId: p1.id, taskType: "copy", state: "review", assignedAgentId: ada.id, inputJson: { title: "FAQ copy" } },
        { companyId, projectId: p2.id, taskType: "menu", state: "review", assignedAgentId: bob.id, humanApprovalRequired: true, inputJson: { title: "Winter menu" } },
        { companyId, projectId: p2.id, taskType: "menu", state: "dead_letter", assignedAgentId: bob.id, inputJson: { title: "Print run" } },
        { companyId, projectId: p3.id, taskType: "ops", state: "blocked", assignedAgentId: cy.id, inputJson: { title: "Rotate keys" } },
        { companyId: otherCompanyId, projectId: otherProject.id, taskType: "x", state: "dead_letter", assignedAgentId: outsider.id, inputJson: { title: "Other company task" } },
    ]).returning();

    // One approval covering two tasks: one decision, not two.
    const [approval] = await db.insert(s.approvals).values({ companyId, projectId: p1.id, requesterAgentId: ada.id, actionType: "publish", rationale: "Both pages are ready to go live.", requestedAt: ago(30) }).returning();
    await db.insert(s.approvalTaskLinks).values([
        { companyId, approvalId: approval.id, taskId: copyA.id },
        { companyId, approvalId: approval.id, taskId: copyB.id },
    ]);
    await db.insert(s.incidents).values([
        { companyId, projectId: p2.id, taskId: stuckTask.id, severity: "high", reasonCode: "max_retries_exceeded", summary: "Print run exceeded retries", createdAt: ago(20) },
        { companyId: otherCompanyId, projectId: otherProject.id, taskId: otherTask.id, severity: "high", reasonCode: "max_retries_exceeded", summary: "Other", createdAt: ago(20) },
    ]);

    // Ana's private chat with Cy: an unanswered message and a failed run there.
    const [privateThread] = await db.insert(s.messageThreads).values({ companyId, type: "direct", title: "Direct Agent Thread", directAgentId: cy.id, ownerUserId: member.id, isPrivate: true }).returning();
    const [deeThread] = await db.insert(s.messageThreads).values({ companyId, type: "direct", title: "Direct Agent Thread", directAgentId: dee.id, ownerUserId: member.id, isPrivate: true }).returning();
    const [newsletter] = await db.insert(s.tasks).values({ companyId, projectId: p1.id, taskType: "copy", state: "in_progress", assignedAgentId: eve.id, inputJson: { title: "Draft newsletter" } }).returning();
    const eveRunId = randomUUID();
    const deeRunId = randomUUID();
    await db.insert(s.threadMessages).values({ companyId, threadId: privateThread.id, senderType: "human", senderId: member.id, targetAgentId: cy.id, text: "Ana's salary question", deliveryState: "queued", createdAt: ago(40) });
    await db.insert(s.agentRuns).values([
        // Ada failed, then succeeded: nothing to do.
        { id: randomUUID(), companyId, agentId: ada.id, status: "failed", startedAt: ago(50), endedAt: ago(49), error: "provider 402" },
        { id: randomUUID(), companyId, agentId: ada.id, status: "succeeded", startedAt: ago(10), endedAt: ago(9) },
        // Bob's latest run failed: it needs a person.
        { id: randomUUID(), companyId, agentId: bob.id, status: "timeout", startedAt: ago(15), endedAt: ago(5), exitReason: "turn limit" },
        // Cy's latest run failed inside Ana's private chat.
        { id: randomUUID(), companyId, agentId: cy.id, status: "failed", startedAt: ago(12), endedAt: ago(11), threadId: privateThread.id, error: "salary tool crashed" },
        // A fresh run: not stalled.
        { id: randomUUID(), companyId, agentId: ada.id, status: "running", startedAt: ago(1) },
        // Eve has been running on the newsletter for 30 min with nothing useful: stalled.
        { id: eveRunId, companyId, agentId: eve.id, status: "running", startedAt: ago(30), taskId: newsletter.id, threadId: null },
        // Dee is stalled inside Ana's private chat.
        { id: deeRunId, companyId, agentId: dee.id, status: "running", startedAt: ago(25), threadId: deeThread.id },
        { id: randomUUID(), companyId: otherCompanyId, agentId: outsider.id, status: "failed", startedAt: ago(3) },
    ]);
    await db.insert(s.notifications).values([
        { companyId, userId: ownerId, kind: "mention", title: "Bob mentioned you in team chat", body: "@owner can you check the menu?", link: "/messages", dedupeKey: `m:${randomUUID()}` },
        { companyId, userId: member.id, kind: "decision", title: "Cy is waiting on your decision", body: "Pick A or B", link: "/messages", dedupeKey: `d:${randomUUID()}` },
        { companyId, userId: ownerId, kind: "mention", title: "Old and read", link: "/messages", readAt: new Date(), dedupeKey: `r:${randomUUID()}` },
    ]);

    const owner = await buildAttention(companyId, { userId: ownerId, isOwnerOrAdmin: true, canAct: true, scope: null });
    const ids = (r: typeof owner) => r.entries.map((e) => e.id);
    const kinds = (r: typeof owner) => r.entries.map((e) => `${e.kind}:${e.title}`);

    const multi = owner.entries.filter((e) => e.approvalId === approval.id);
    assert.equal(multi.length, 1, "a multi-task approval is one decision");
    assert.equal(multi[0].taskCount, 2);
    assert.equal(multi[0].customerName, "Northwind Dental");
    assert.equal(multi[0].memberName, "Ada");
    assert.ok(owner.entries.some((e) => e.kind === "approval" && e.taskId === implicitTask.id), "an approval-required task with no request is a decision");
    assert.ok(owner.entries.some((e) => e.kind === "incident" && e.taskId === stuckTask.id), "the stuck task's incident");
    assert.equal(owner.entries.filter((e) => e.taskId === stuckTask.id).length, 1, "the incident covers its task: no duplicate blocked-task row");
    assert.ok(owner.entries.some((e) => e.kind === "task_blocked" && e.taskId === blockedTask.id && e.reason === "Blocked"));
    assert.ok(owner.entries.some((e) => e.kind === "run_failed" && e.agentId === bob.id && e.reason === "turn limit"), "Bob's timed-out run");
    assert.ok(!owner.entries.some((e) => e.kind === "run_failed" && e.agentId === ada.id), "a later success clears Ada's failure");
    assert.ok(!owner.entries.some((e) => e.kind === "run_failed" && e.agentId === cy.id), "a run in someone else's private chat stays private");
    assert.ok(!kinds(owner).some((k) => /salary/i.test(k)), "nothing from Ana's private chat");
    assert.ok(!owner.entries.some((e) => e.kind === "message"), "the private unanswered message is Ana's alone");
    assert.deepEqual(owner.entries.filter((e) => e.kind === "mention").map((e) => e.title), ["Bob mentioned you in team chat"], "unread mentions only, the owner's own");
    assert.ok(!owner.entries.some((e) => e.kind === "decision"), "Ana's decision notification is not the owner's");
    assert.ok(!kinds(owner).some((k) => /Other company|Outsider/.test(k)), "never another company's items");
    assert.equal(owner.counts.needsYou, owner.entries.filter(needsYou).length, "badge = what the page lists as needing you");
    const stall = owner.entries.find((e) => e.kind === "stalled");
    assert.ok(stall, "a run with no progress is an inbox item");
    assert.equal(stall!.taskId, newsletter.id);
    assert.equal(stall!.href, `/projects/tasks/${newsletter.id}#run-${eveRunId}`, "it opens the task page at the run");
    assert.match(stall!.reason ?? "", /^No progress for /);
    assert.equal(needsYou(stall!), true, "stalls are Blocked or failing");
    assert.ok(!owner.entries.some((e) => e.kind === "stalled" && e.agentId === dee.id), "a stall in someone else's private chat stays private");
    assert.deepEqual(owner.workingNow, [eve.id].sort(), "working now: connected and holding an in-progress task");
    assert.equal(owner.counts.approvals, 2);
    assert.equal(owner.counts.hasFailures, true);
    // Decisions come first.
    assert.equal(owner.entries[0].kind === "approval" || owner.entries[0].kind === "decision", true);

    const ana = await buildAttention(companyId, { userId: member.id, isOwnerOrAdmin: false, canAct: true, scope: null });
    assert.ok(ana.entries.some((e) => e.kind === "message" && e.threadId === privateThread.id && e.href.includes(`thread=${privateThread.id}`)), "Ana sees her own private chat, linked to the exact thread");
    assert.ok(ana.entries.some((e) => e.kind === "run_failed" && e.agentId === cy.id), "and the failed run in it");
    assert.ok(ana.entries.some((e) => e.kind === "decision"), "her decision notification");
    assert.ok(ana.entries.some((e) => e.kind === "stalled" && e.agentId === dee.id && e.runId === deeRunId), "Ana sees the stall in her own private chat");
    assert.ok(!ana.entries.some((e) => e.kind === "mention"), "not the owner's mention");

    // A restricted member: Ada and Northwind only.
    const restricted = await buildAttention(companyId, { userId: member.id, isOwnerOrAdmin: false, canAct: true, scope: { agentIds: [ada.id], customerIds: [northwind.id] } });
    assert.ok(ids(restricted).includes(`approval:${approval.id}`));
    assert.ok(!restricted.entries.some((e) => e.taskId === stuckTask.id || e.taskId === implicitTask.id), "Harbor's work is out of scope");
    assert.ok(!restricted.entries.some((e) => e.agentId === bob.id || e.agentId === cy.id || e.memberKey === `agent:${cy.id}`), "other agents are out of scope");
    assert.ok(!restricted.entries.some((e) => e.taskId === blockedTask.id), "a project with no customer is outside a customer scope");
    assert.deepEqual(restricted.agents.map((a) => a.name), ["Ada"], "reassign targets are scoped too");

    assert.ok(!restricted.entries.some((e) => e.kind === "stalled"), "Eve and Dee are out of scope");
    assert.deepEqual(restricted.workingNow, [], "working now is scoped too");
    const none = await buildAttention(companyId, { userId: member.id, isOwnerOrAdmin: false, canAct: true, scope: { agentIds: [], customerIds: [] } });
    assert.deepEqual(none.entries.map((e) => e.kind), ["decision"], "an empty scope sees only their own notifications");

    // The command palette applies the same scope.
    const palette = await loadPaletteData(companyId, { agentIds: [ada.id], customerIds: [northwind.id] });
    assert.deepEqual(palette.agents.map((a) => a.name), ["Ada"]);
    assert.deepEqual(palette.customers.map((c) => c.name), ["Northwind Dental"]);
    assert.deepEqual(palette.projects.map((p) => p.name), ["Northwind site"]);
    assert.deepEqual(palette.tasks.map((t) => t.title).sort(), ["FAQ copy", "Pricing copy"]);
    const nothing = await loadPaletteData(companyId, { agentIds: [], customerIds: [] });
    assert.deepEqual([nothing.agents.length, nothing.customers.length, nothing.projects.length, nothing.tasks.length], [0, 0, 0, 0], "an empty restricted scope sees nothing");
    const search = await loadPaletteData(companyId, null, "menu");
    assert.deepEqual(search.tasks.map((t) => t.title), ["Winter menu"], "task search matches titles, skips finished and other companies' tasks");
    await db.insert(s.tasks).values({ companyId, projectId: p3.id, taskType: "promo", state: "inbox", inputJson: { title: "50% off banner" } });
    const wildcard = await loadPaletteData(companyId, null, "%");
    assert.deepEqual(wildcard.tasks.map((t) => t.title), ["50% off banner"], "a typed % is a literal, not a wildcard");
});
