// The lease expiry must be an instant, not a wall clock (migration 0089).
//
// Before 0089 `tasks.lease_until` was `timestamp without time zone` holding UTC
// written by a session pinned to UTC. Read on a host in another zone, a lease with
// ten minutes left appeared expired for about an hour, so a second session could
// take a task the first still held. These tests run with the JS process in
// Europe/Bratislava and also read the row through a Postgres session in the same
// zone, so a regression cannot hide behind the pinned UTC session.
process.env.TZ = "Europe/Bratislava";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

const MIGRATION = path.join(process.cwd(), "src/db/migrations/0089_task-lease-timestamptz.sql");

/** A raw session in a zone that is not UTC, to read what a real operator would see. */
async function nonUtcClient() {
    const client = new Client({
        connectionString: process.env.POSTGRES_CONNECTION_STRING,
        options: "-c timezone=Europe/Bratislava",
    });
    await client.connect();
    return client;
}

async function columnType() {
    const client = new Client({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
    await client.connect();
    try {
        const { rows } = await client.query(
            "select data_type from information_schema.columns where table_name = 'tasks' and column_name = 'lease_until'",
        );
        return rows[0]?.data_type as string | undefined;
    } finally {
        await client.end();
    }
}

async function seedLeasableTask() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Leaseholder" });
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const [project] = await db.insert(projects).values({ companyId, goal: "0089 timestamptz", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({
        companyId,
        projectId: project.id,
        taskType: "work",
        state: "in_progress",
        assignedAgentId: agent.id,
        inputJson: { title: "Work under a lease" },
    }).returning();
    return { db, tasks, companyId, agent, task };
}

maybe("tasks.lease_until is timestamp with time zone", async () => {
    assert.equal(await columnType(), "timestamp with time zone");
});

maybe("a lease taken now is still live when read from a Europe/Bratislava session", async () => {
    assert.notEqual(new Date(Date.UTC(2026, 6, 1, 12)).getHours(), 12, "the suite must run with a non-UTC offset");
    const { companyId, agent, task } = await seedLeasableTask();

    const { acquireTaskLease } = await import("@/lib/openclaw/tasks");
    const acquired = await acquireTaskLease({
        companyId,
        taskId: task.id,
        agentId: agent.id,
        owner: "session-a",
        ttlSeconds: 600,
    });
    assert.ok("lease" in acquired, "the lease must be acquired");

    const client = await nonUtcClient();
    try {
        const { rows } = await client.query(
            `select extract(epoch from (lease_until - now())) as remaining,
                    (lease_until <= now()) as expired
               from tasks where id = $1`,
            [task.id],
        );
        assert.equal(rows[0].expired, false, "a lease with ~10 minutes left must not read as expired");
        const remaining = Number(rows[0].remaining);
        assert.ok(remaining > 540 && remaining <= 610, `expected ~600s remaining, got ${remaining}s`);
    } finally {
        await client.end();
    }
});

maybe("a second session still cannot take a live lease on a non-UTC host", async () => {
    const { companyId, agent, task } = await seedLeasableTask();
    const { acquireTaskLease } = await import("@/lib/openclaw/tasks");

    const first = await acquireTaskLease({ companyId, taskId: task.id, agentId: agent.id, owner: "session-a", ttlSeconds: 600 });
    assert.ok("lease" in first, "the first session must hold the lease");

    const second = await acquireTaskLease({ companyId, taskId: task.id, agentId: agent.id, owner: "session-b", ttlSeconds: 600 });
    assert.ok("status" in second, "a second session must be refused, not handed the task");
    assert.equal(second.status, 409);
    assert.match(String(second.error), /another session/i);
});

maybe("0089 is idempotent and ignores the reader's timezone", async () => {
    // Re-running the migration on an already converted column must be a no-op, and
    // the conversion must not depend on the session timezone.
    assert.equal(await columnType(), "timestamp with time zone");
    const statements = readFileSync(MIGRATION, "utf8")
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean);
    assert.ok(statements.length >= 1, "the migration must contain at least one statement");

    const client = await nonUtcClient();
    try {
        for (const statement of statements) await client.query(statement);
    } finally {
        await client.end();
    }
    assert.equal(await columnType(), "timestamp with time zone");
});
