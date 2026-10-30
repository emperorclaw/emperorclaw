import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

/**
 * Roadmap 11.6: a failure in the inbox reads as one plain cause and one fix,
 * filtered for the viewer's role. A 402 from the provider is "out of
 * credits" with an admin-only "Open provider settings"; a member and a viewer
 * see the same cause, and only what they may act on.
 */
maybe("failure cause: a 402 run reads as out of credits, with the fix only for those allowed", async () => {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { buildAttention } = await import("@/lib/attention");
    const now = Date.now();
    const ago = (min: number) => new Date(now - min * 60_000);

    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    const [viewerUser] = await db.insert(s.users).values({ email: `vi-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Vi" }).returning();
    const [memberUser] = await db.insert(s.users).values({ email: `mo-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Mo" }).returning();
    await db.insert(s.companyMembers).values([
        { companyId, userId: ownerId, role: "owner" },
        { companyId, userId: viewerUser.id, role: "viewer" },
        { companyId, userId: memberUser.id, role: "member" },
    ]);

    const ada = await seedAgent(companyId, { name: "Ada", lastSeenAt: new Date() });
    const bea = await seedAgent(companyId, { name: "Bea", lastSeenAt: new Date() });
    const [project] = await db.insert(s.projects).values({ companyId, goal: "Site", status: "active" }).returning();
    const [task] = await db.insert(s.tasks).values({ companyId, projectId: project.id, taskType: "copy", state: "in_progress", assignedAgentId: bea.id, inputJson: { title: "Hero copy" } }).returning();

    const adaRun = randomUUID();
    const beaRun = randomUUID();
    await db.insert(s.agentRuns).values([
        // The bridge's own classification of a provider 402.
        { id: adaRun, companyId, agentId: ada.id, status: "failed", startedAt: ago(6), endedAt: ago(5), error: "provider_credits_exhausted: HTTP 402" },
        // An unknown failure on a task: anyone who can act may retry it.
        { id: beaRun, companyId, agentId: bea.id, taskId: task.id, status: "failed", startedAt: ago(4), endedAt: ago(3), error: "hermes_failed" },
    ]);

    const access = (userId: string, role: "owner" | "member" | "viewer") => ({
        userId, isOwnerOrAdmin: role === "owner", canAct: role !== "viewer", scope: null,
    });
    const runEntry = (r: Awaited<ReturnType<typeof buildAttention>>, runId: string) => r.entries.find((e) => e.kind === "run_failed" && e.runId === runId);

    const owner = await buildAttention(companyId, access(ownerId, "owner"));
    const credits = runEntry(owner, adaRun);
    assert.ok(credits, "the failed run is listed");
    assert.equal(credits!.failure?.cause, "provider_credits");
    assert.equal(credits!.reason, "LLM provider is out of credits");
    assert.deepEqual(credits!.failure?.fix, { label: "Open provider settings", labelCopy: { key: "failures.fixes.openProviderSettings" }, action: { kind: "link", href: `/agents?agent=${ada.id}` } });

    const retry = runEntry(owner, beaRun);
    assert.equal(retry?.failure?.cause, "unknown");
    assert.equal(retry?.reason, "Run failed: hermes_failed");
    assert.deepEqual(retry?.failure?.fix, { label: "Retry", labelCopy: { key: "failures.fixes.retry" }, action: { kind: "message_agent", agentId: bea.id, taskId: task.id, mode: "retry" } });

    // A member sees the cause; the provider fix is owner/admin only, Retry is theirs.
    const member = await buildAttention(companyId, access(memberUser.id, "member"));
    assert.equal(runEntry(member, adaRun)?.failure?.headline, "LLM provider is out of credits");
    assert.equal(runEntry(member, adaRun)?.failure?.fix, null);
    assert.equal(runEntry(member, beaRun)?.failure?.fix?.label, "Retry");

    // A message the runtime gave up on after a 429: its sender may retry it, after a short delay.
    const [chat] = await db.insert(s.messageThreads).values({ companyId, type: "direct", title: "Direct Agent Thread", directAgentId: ada.id, ownerUserId: memberUser.id, isPrivate: true }).returning();
    const failedAt = ago(2).toISOString();
    const [message] = await db.insert(s.threadMessages).values({
        companyId, threadId: chat.id, senderType: "human", senderId: memberUser.id, targetAgentId: ada.id, text: "Draft the launch post", deliveryState: "cancelled", createdAt: ago(3),
        metadataJson: { runtimeFailure: { agentId: ada.id, at: failedAt, attempts: 3, reason: "Error code: 429 - {'error': {'code': 'rate_limit_exceeded'}}" } },
    }).returning();
    const memberAgain = await buildAttention(companyId, access(memberUser.id, "member"));
    const failedMessage = memberAgain.entries.find((e) => e.id === `message:${message.id}`);
    assert.equal(failedMessage?.failure?.cause, "rate_limited");
    assert.equal(failedMessage?.reason, "Rate limited by the model provider");
    assert.deepEqual(failedMessage?.failure?.fix, { label: "Retry", labelCopy: { key: "failures.fixes.retry" }, action: { kind: "retry_message", messageId: message.id }, notBefore: new Date(Date.parse(failedAt) + 60_000).toISOString() });

    // A viewer sees every cause and no action at all.
    const viewer = await buildAttention(companyId, access(viewerUser.id, "viewer"));
    const viewerCredits = runEntry(viewer, adaRun);
    assert.equal(viewerCredits?.failure?.cause, "provider_credits");
    assert.equal(viewerCredits?.reason, "LLM provider is out of credits");
    assert.equal(viewerCredits?.failure?.fix, null);
    assert.ok(viewer.entries.every((e) => !e.failure?.fix), "no fix for a viewer anywhere");
});

maybe("failure cause: a failed run's Retry goes to the task's current assignee, not the agent that ran it", async () => {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { buildAttention } = await import("@/lib/attention");
    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    await db.insert(s.companyMembers).values({ companyId, userId: ownerId, role: "owner" });
    const ada = await seedAgent(companyId, { name: "Ada", lastSeenAt: new Date() });
    const bea = await seedAgent(companyId, { name: "Bea", lastSeenAt: new Date() });
    const [project] = await db.insert(s.projects).values({ companyId, goal: "Site", status: "active" }).returning();
    // Bea ran it and failed; the task has since moved to Ada.
    const [task] = await db.insert(s.tasks).values({ companyId, projectId: project.id, taskType: "copy", state: "in_progress", assignedAgentId: ada.id, inputJson: { title: "Hero copy" } }).returning();
    const runId = randomUUID();
    await db.insert(s.agentRuns).values({ id: runId, companyId, agentId: bea.id, taskId: task.id, status: "failed", startedAt: new Date(Date.now() - 4 * 60_000), endedAt: new Date(Date.now() - 3 * 60_000), error: "hermes_failed" });

    const owner = await buildAttention(companyId, { userId: ownerId, isOwnerOrAdmin: true, canAct: true, scope: null });
    const entry = owner.entries.find((e) => e.kind === "run_failed" && e.runId === runId);
    assert.deepEqual(entry?.failure?.fix, { label: "Retry", labelCopy: { key: "failures.fixes.retry" }, action: { kind: "message_agent", agentId: ada.id, taskId: task.id, mode: "retry" } });
});
