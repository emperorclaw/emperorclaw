import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, seedHuman, seedTwoTenantsOfWork } from "./_access-helper";

/**
 * The running-runs endpoint (GET /api/agents/[id]/running) must apply the same
 * privacy rules as the rest of the app: never another person's private thread,
 * never an out-of-scope task title for a restricted member, but always the
 * viewer's own private thread and the agent's Operations/Work log thread.
 */
const maybe = dbAvailable ? test : test.skip;

async function seedWorld() {
    await resetDb();
    const db = await getDb();
    const { users, companies, agentRuns } = await getSchema();
    const { eq } = await import("drizzle-orm");

    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Visibility Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));

    const owner = await seedHuman(companyId, "owner");
    const work = await seedTwoTenantsOfWork(companyId);
    const agentX = await seedAgent(companyId, { name: "Xavier", provider: "hermes" });
    const restricted = await seedHuman(companyId, "member", {
        scope: { mode: "restricted", agentIds: [agentX.id], customerIds: [work.customerIn.id] },
    });

    const { ensureDirectThread } = await import("@/lib/control-plane");
    const opsThread = await ensureDirectThread(companyId, agentX.id, null);
    const ownerPrivate = await ensureDirectThread(companyId, agentX.id, owner.userId);
    const restrictedPrivate = await ensureDirectThread(companyId, agentX.id, restricted.userId);

    const mkRun = (over: Record<string, unknown>) => db.insert(agentRuns).values({
        id: randomUUID(), companyId, agentId: agentX.id, status: "running", startedAt: new Date(), ...over,
    }).returning();

    const [runOwnerPrivate] = await mkRun({ threadId: ownerPrivate.id });
    const [runOps] = await mkRun({ threadId: opsThread.id });
    const [runRestrictedPrivate] = await mkRun({ threadId: restrictedPrivate.id });
    const [runTaskIn] = await mkRun({ taskId: work.taskIn.id });
    const [runTaskOut] = await mkRun({ taskId: work.taskOut.id });

    return {
        companyId, owner, restricted, agentX, opsThread, ownerPrivate, restrictedPrivate,
        runOwnerPrivate, runOps, runRestrictedPrivate, runTaskIn, runTaskOut,
    };
}

async function runningRuns(viewer: { userId: string; sessionId: string }, agentId: string) {
    actAs(viewer);
    try {
        const route = await import("@/app/api/agents/[id]/running/route");
        const res = await call(route.GET as never, `/api/agents/${agentId}/running`, { params: { id: agentId } });
        assert.equal(res.status, 200);
        return (res.json as { runs: { runId: string; [key: string]: unknown }[] }).runs;
    } finally {
        actAs(null);
    }
}

maybe("running runs: an owner sees their own private thread and Operations work, never another person's private thread", async () => {
    const w = await seedWorld();
    const runs = await runningRuns({ userId: w.owner.userId, sessionId: w.owner.sessionId }, w.agentX.id);
    const byId = new Map(runs.map((r) => [r.runId, r]));

    const other = byId.get(w.runRestrictedPrivate.id);
    assert.equal(other?.threadId, null, "another person's private thread id is never returned");
    assert.equal(other?.threadKind, "other-private");
    assert.equal(other?.taskTitle, null, "another person's private run never names its task");
    assert.equal(other?.taskId, null);
    assert.equal(other?.startedAt, null, "another person's private run never shows its timing");

    assert.equal(byId.get(w.runOwnerPrivate.id)?.threadId, w.ownerPrivate.id);
    assert.equal(byId.get(w.runOwnerPrivate.id)?.threadKind, "own-private");
    assert.equal(byId.get(w.runOps.id)?.threadId, w.opsThread.id);
    assert.equal(byId.get(w.runOps.id)?.threadKind, "operations");

    assert.equal(byId.get(w.runTaskIn.id)?.taskTitle, "Task In");
    assert.equal(byId.get(w.runTaskOut.id)?.taskTitle, "Task Out", "an unrestricted owner sees every task");
});

maybe("running runs: a restricted member gets their own private thread and Operations work, and out-of-scope tasks are hidden", async () => {
    const w = await seedWorld();
    const runs = await runningRuns({ userId: w.restricted.userId, sessionId: w.restricted.sessionId }, w.agentX.id);
    const byId = new Map(runs.map((r) => [r.runId, r]));

    const out = byId.get(w.runTaskOut.id);
    assert.equal(out?.taskId, null, "an out-of-scope task id is never returned");
    assert.equal(out?.taskTitle, null);
    assert.equal(out?.taskHidden, true);

    assert.equal(byId.get(w.runTaskIn.id)?.taskTitle, "Task In", "an in-scope task keeps its title");

    const other = byId.get(w.runOwnerPrivate.id);
    assert.equal(other?.threadId, null, "the owner's private thread is another person's private thread to a member");
    assert.equal(other?.threadKind, "other-private");

    assert.equal(byId.get(w.runRestrictedPrivate.id)?.threadId, w.restrictedPrivate.id);
    assert.equal(byId.get(w.runRestrictedPrivate.id)?.threadKind, "own-private");
    assert.equal(byId.get(w.runOps.id)?.threadId, w.opsThread.id);
    assert.equal(byId.get(w.runOps.id)?.threadKind, "operations");
});
