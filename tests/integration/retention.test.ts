import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, resetDb, getDb, getSchema } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

const HOUR = 3_600_000;

async function seedCompany() {
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [user] = await db
        .insert(users)
        .values({ email: `retention-${Date.now()}-${Math.random()}@example.com`, passwordHash: "x" })
        .returning();
    const [company] = await db
        .insert(companies)
        .values({ name: "Retention Co", createdByUserId: user.id })
        .returning();
    return company;
}

maybe("retention deletes only idempotency keys older than the TTL", async () => {
    await resetDb();
    const db = await getDb();
    const { idempotencyKeys } = await getSchema();
    const company = await seedCompany();

    const now = new Date();
    const old = new Date(now.getTime() - 72 * HOUR); // past the 48h TTL
    const fresh = new Date(now.getTime() - 1 * HOUR);
    await db.insert(idempotencyKeys).values([
        { companyId: company.id, endpoint: "/tasks/claim", requestHash: "old-1", createdAt: old },
        { companyId: company.id, endpoint: "/tasks/claim", requestHash: "old-2", createdAt: old },
        { companyId: company.id, endpoint: "/tasks/claim", requestHash: "fresh-1", createdAt: fresh },
    ]);

    const { runScheduledRetention } = await import("@/lib/retention");
    const summary = await runScheduledRetention(now);
    assert.ok(summary, "retention should return a summary");

    const rows = await db.select().from(idempotencyKeys);
    assert.deepEqual(
        rows.map((row) => row.requestHash).sort(),
        ["fresh-1"],
        "only the fresh key should survive",
    );

    const step = summary.steps.find((entry) => entry.table === "idempotency_keys");
    assert.ok(step);
    assert.equal(step.deleted, 2);
    assert.equal(step.exhausted, false);
});

maybe("the latest retention summary is readable for the Ops storage page", async () => {
    await resetDb();
    const { runScheduledRetention, getRecentRetentionRuns } = await import("@/lib/retention");

    assert.deepEqual(await getRecentRetentionRuns(), []);

    await runScheduledRetention(new Date());
    const runs = await getRecentRetentionRuns();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].steps[0].table, "idempotency_keys");
    assert.equal(typeof runs[0].durationMs, "number");
});

maybe("retention prunes run events past their TTL before pruning runs", async () => {
    await resetDb();
    const db = await getDb();
    const { agentRuns, agentRunEvents } = await getSchema();
    const company = await seedCompany();
    const { randomUUID } = await import("node:crypto");

    const now = new Date();
    const runId = randomUUID();
    await db.insert(agentRuns).values({ id: runId, companyId: company.id, status: "succeeded", startedAt: new Date(now.getTime() - 2 * HOUR), endedAt: now });
    const old = new Date(now.getTime() - 8 * 24 * HOUR); // past the 7-day default
    await db.insert(agentRunEvents).values([
        { id: randomUUID(), companyId: company.id, runId, seq: 1, ts: old, kind: "tool.start", createdAt: old },
        { id: randomUUID(), companyId: company.id, runId, seq: 2, ts: old, kind: "tool.end", createdAt: old },
        { id: randomUUID(), companyId: company.id, runId, seq: 3, ts: now, kind: "turn.completed", createdAt: now },
    ]);

    const { runScheduledRetention, RETENTION_STEPS } = await import("@/lib/retention");
    const ids = RETENTION_STEPS.map((step) => step.id);
    assert.ok(ids.indexOf("agent_run_events") >= 0 && ids.indexOf("agent_run_events") < ids.indexOf("agent_runs"));

    const summary = await runScheduledRetention(now);
    assert.ok(summary);
    const step = summary.steps.find((entry) => entry.table === "agent_run_events");
    assert.equal(step?.deleted, 2);
    const rows = await db.select().from(agentRunEvents);
    assert.deepEqual(rows.map((row) => row.seq), [3]);
});
