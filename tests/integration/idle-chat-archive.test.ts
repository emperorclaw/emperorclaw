import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { seedHuman } from "./_access-helper";

/**
 * Idle auto-archive of extra private chats (docs/design/multi-chat-per-agent.md
 * §5.3, lib/idle-chat-archive.ts): which chats it archives, every chat it must
 * never touch, the per-company settings, the private-chat lock, and the one
 * summary audit row per company.
 */
const maybe = dbAvailable ? test : test.skip;

const DAY = 86_400_000;
const NOW = () => new Date();
const daysAgo = (days: number) => new Date(Date.now() - days * DAY);

async function seed(companyPatch: Record<string, unknown> = {}) {
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    await db.update(companies).set({ directChatMode: "private", ...companyPatch }).where(eq(companies.id, companyId));
    const agent = await seedAgent(companyId, { name: "Scout", provider: "hermes" });
    return { companyId, owner, agent };
}

/** An extra (or main) private chat created `createdDaysAgo` days ago, with optional old messages. */
async function chat(s: Awaited<ReturnType<typeof seed>>, options: { createdDaysAgo?: number; isMain?: boolean; title?: string } = {}) {
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const [thread] = await db.insert(messageThreads).values({
        companyId: s.companyId, type: "direct", title: options.title ?? "Q3 invoices", createdByType: "human", createdById: s.owner.userId,
        directAgentId: s.agent.id, ownerUserId: s.owner.userId, isPrivate: true, isMain: options.isMain ?? false,
        createdAt: daysAgo(options.createdDaysAgo ?? 40),
    }).returning();
    return thread;
}

async function message(s: Awaited<ReturnType<typeof seed>>, threadId: string, options: { daysAgo?: number; deliveryState?: string; senderType?: string } = {}) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    await db.insert(threadMessages).values({
        companyId: s.companyId, threadId, senderType: options.senderType ?? "human", senderId: s.owner.userId, targetAgentId: s.agent.id,
        text: "secret plan", deliveryState: options.deliveryState ?? "delivered", createdAt: daysAgo(options.daysAgo ?? 35),
    });
}

async function threadState(id: string) {
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(messageThreads).where(eq(messageThreads.id, id));
    return { archived: row.archivedAt !== null, reason: row.archiveReason };
}

async function idleAudits(companyId: string) {
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    return db.select().from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "company.idle_chats_archived")));
}

maybe("the retention sweep archives idle extra chats as 'idle' and never touches a chat that is still in use", async () => {
    await resetDb();
    const db = await getDb();
    const { agentRuns, agentObjectives, approvals } = await getSchema();
    const s = await seed();

    // Archived: idle with no message, idle with only old messages, and chats
    // whose objective / approval / run is over (the exclusions are exact).
    const idleEmpty = await chat(s);
    const idleOld = await chat(s);
    await message(s, idleOld.id, { daysAgo: 35 });
    await message(s, idleOld.id, { daysAgo: 33, senderType: "agent" });
    const doneObjective = await chat(s);
    await db.insert(agentObjectives).values({ companyId: s.companyId, agentId: s.agent.id, threadId: doneObjective.id, objective: "ship", status: "completed" });
    const decidedApproval = await chat(s);
    await db.insert(approvals).values({ companyId: s.companyId, requesterAgentId: s.agent.id, status: "approved", threadId: decidedApproval.id });
    const finishedRun = await chat(s);
    await db.insert(agentRuns).values({ id: randomUUID(), companyId: s.companyId, agentId: s.agent.id, threadId: finishedRun.id, status: "succeeded", startedAt: daysAgo(35) });

    // Kept: one per exclusion.
    const main = await chat(s, { isMain: true, title: "Scout" });
    const recentMessage = await chat(s);
    await message(s, recentMessage.id, { daysAgo: 2 });
    const recentlyCreated = await chat(s, { createdDaysAgo: 3 });
    const queued = await chat(s);
    await message(s, queued.id, { daysAgo: 35, deliveryState: "queued" });
    const seen = await chat(s);
    await message(s, seen.id, { daysAgo: 35, deliveryState: "seen" });
    const acting = await chat(s);
    await message(s, acting.id, { daysAgo: 35, deliveryState: "acting" });
    const running = await chat(s);
    await db.insert(agentRuns).values({ id: randomUUID(), companyId: s.companyId, agentId: s.agent.id, threadId: running.id, status: "running", startedAt: new Date() });
    // (A run left "running" for days is closed as lost by the same job first.)
    const objective = await chat(s);
    await db.insert(agentObjectives).values({ companyId: s.companyId, agentId: s.agent.id, threadId: objective.id, objective: "ship", status: "active" });
    const pausedObjective = await chat(s);
    await db.insert(agentObjectives).values({ companyId: s.companyId, agentId: s.agent.id, threadId: pausedObjective.id, objective: "later", status: "paused" });
    const pendingApproval = await chat(s);
    await db.insert(approvals).values({ companyId: s.companyId, requesterAgentId: s.agent.id, status: "pending", threadId: pendingApproval.id });

    // Through the scheduled retention job, as in production.
    const { runScheduledRetention } = await import("@/lib/retention");
    const summary = await runScheduledRetention(NOW());
    assert.ok(summary);
    const step = summary.steps.find((entry) => entry.table === "private_chats_idle_archive");
    assert.equal(step?.deleted, 5);
    assert.equal(step?.error, undefined);

    for (const thread of [idleEmpty, idleOld, doneObjective, decidedApproval, finishedRun]) {
        assert.deepEqual(await threadState(thread.id), { archived: true, reason: "idle" }, `archived: ${thread.id}`);
    }
    const kept = { main, recentMessage, recentlyCreated, queued, seen, acting, running, objective, pausedObjective, pendingApproval };
    for (const [name, thread] of Object.entries(kept)) {
        assert.deepEqual(await threadState(thread.id), { archived: false, reason: null }, `kept: ${name}`);
    }

    // One summary row for the company: a count, the system as actor, no title or content.
    const rows = await idleAudits(s.companyId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actorType, "system");
    assert.equal(rows[0].targetType, "company");
    assert.equal(rows[0].targetId, s.companyId);
    assert.deepEqual(rows[0].payloadJson, { meta: { count: 5 } });
    assert.doesNotMatch(JSON.stringify(rows[0].payloadJson), /Q3 invoices|secret plan/);

    // A second run finds nothing: no new audit row.
    const { archiveIdlePrivateChats } = await import("@/lib/idle-chat-archive");
    assert.equal(await archiveIdlePrivateChats(NOW()), 0);
    assert.equal((await idleAudits(s.companyId)).length, 1);
});

maybe("only companies with the window set, multiple chats on and private mode are swept; each uses its own window", async () => {
    await resetDb();
    const never = await seed({ multiChatIdleArchiveDays: null });
    const disabled = await seed({ multiChatEnabled: false });
    const shared = await seed();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await (await getDb()).update(companies).set({ directChatMode: "shared" }).where(eq(companies.id, shared.companyId));
    const longWindow = await seed({ multiChatIdleArchiveDays: 60 });
    const shortWindow = await seed({ multiChatIdleArchiveDays: 7 });

    const neverChat = await chat(never, { createdDaysAgo: 200 });
    const disabledChat = await chat(disabled, { createdDaysAgo: 200 });
    const sharedChat = await chat(shared, { createdDaysAgo: 200 });
    const longKept = await chat(longWindow, { createdDaysAgo: 40 });
    const longArchived = await chat(longWindow, { createdDaysAgo: 61 });
    const shortArchived = await chat(shortWindow, { createdDaysAgo: 8 });
    const shortKept = await chat(shortWindow, { createdDaysAgo: 30 });
    await message(shortWindow, shortKept.id, { daysAgo: 6 });

    const { archiveIdlePrivateChats } = await import("@/lib/idle-chat-archive");
    assert.equal(await archiveIdlePrivateChats(NOW()), 2);

    for (const thread of [neverChat, disabledChat, sharedChat, longKept, shortKept]) {
        assert.equal((await threadState(thread.id)).archived, false);
    }
    for (const thread of [longArchived, shortArchived]) {
        assert.deepEqual(await threadState(thread.id), { archived: true, reason: "idle" });
    }
    // One row per company that had something archived; none for the others.
    for (const s of [never, disabled, shared]) assert.equal((await idleAudits(s.companyId)).length, 0);
    for (const s of [longWindow, shortWindow]) {
        const rows = await idleAudits(s.companyId);
        assert.equal(rows.length, 1);
        assert.deepEqual(rows[0].payloadJson, { meta: { count: 1 } });
    }
});

maybe("a chat whose owner holds the private-chat lock is skipped and archived on the next run", async () => {
    await resetDb();
    const s = await seed();
    const idle = await chat(s);
    const db = await getDb();
    const { lockPrivateChats } = await import("@/lib/control-plane");
    const { archiveIdlePrivateChats } = await import("@/lib/idle-chat-archive");

    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => { locked = resolve; });
    const holder = db.transaction(async (tx) => {
        await lockPrivateChats(tx, s.companyId, s.agent.id, s.owner.userId);
        locked();
        await held;
    });
    await lockTaken;
    try {
        assert.equal(await archiveIdlePrivateChats(NOW()), 0);
        assert.equal((await threadState(idle.id)).archived, false);
    } finally {
        release();
        await holder;
    }
    assert.equal(await archiveIdlePrivateChats(NOW()), 1);
    assert.deepEqual(await threadState(idle.id), { archived: true, reason: "idle" });
    assert.equal((await idleAudits(s.companyId)).length, 1);
});

maybe("an idle-archived chat restores with one call", async () => {
    await resetDb();
    const s = await seed();
    const idle = await chat(s);
    const { archiveIdlePrivateChats } = await import("@/lib/idle-chat-archive");
    assert.equal(await archiveIdlePrivateChats(NOW()), 1);
    const { updatePrivateChat } = await import("@/lib/private-chats");
    const restored = await updatePrivateChat(s.companyId, s.owner.userId, idle.id, { archived: false });
    assert.equal(restored.archivedAt, null);
    assert.equal(restored.archiveReason, null);
    assert.equal(restored.isMain, false);
});

maybe("a restored idle chat stays open on the next sweep: a restore counts as activity", async () => {
    await resetDb();
    const s = await seed();
    const idle = await chat(s);
    await message(s, idle.id, { daysAgo: 35 });
    const { archiveIdlePrivateChats } = await import("@/lib/idle-chat-archive");
    await archiveIdlePrivateChats(NOW());
    assert.deepEqual(await threadState(idle.id), { archived: true, reason: "idle" });

    const { updatePrivateChat } = await import("@/lib/private-chats");
    const restored = await updatePrivateChat(s.companyId, s.owner.userId, idle.id, { archived: false });
    assert.ok(restored.restoredAt, "the restore is stamped");
    assert.equal(await archiveIdlePrivateChats(NOW()), 0);
    assert.deepEqual(await threadState(idle.id), { archived: false, reason: null }, "not re-archived an hour later");

    // Once the restore itself is older than the window, it is idle again.
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(messageThreads).set({ restoredAt: daysAgo(31) }).where(eq(messageThreads.id, idle.id));
    await archiveIdlePrivateChats(NOW());
    assert.deepEqual(await threadState(idle.id), { archived: true, reason: "idle" });
});
