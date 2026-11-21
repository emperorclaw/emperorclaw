/**
 * Task lease expiry must not depend on the session timezone.
 *
 * `tasks.lease_until` is written as a UTC wall clock by sessions pinned to UTC.
 * When the column was `timestamp without time zone`, a session that did not pin
 * its zone cast that naive value with the session zone, so a live lease read as
 * expired under e.g. Europe/Bratislava. The column is now `timestamptz`, so the
 * same instant compares as live under any session zone.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "pg";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

async function world() {
    await resetDb();
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Solo" });

    const [project] = await db.insert(projects).values({
        companyId,
        goal: "Lease timezone",
        status: "active",
    }).returning();

    const [task] = await db.insert(tasks).values({
        companyId,
        projectId: project.id,
        taskType: "work",
        state: "in_progress",
        assignedAgentId: agent.id,
        inputJson: { title: "Live lease across zones" },
    }).returning();

    return { companyId, task, agent };
}

maybe("a live lease is not expired under Europe/Bratislava and under UTC", async (t) => {
    const w = await world();
    const { acquireTaskLease } = await import("@/lib/openclaw/tasks");

    const leased = await acquireTaskLease({
        companyId: w.companyId,
        taskId: w.task.id,
        agentId: w.agent.id,
        owner: "session-tz",
        ttlSeconds: 600,
    });
    assert.ok("task" in leased, `lease acquisition failed: ${JSON.stringify(leased)}`);
    assert.ok(leased.lease.until, "the acquired lease carries an expiry");

    const client = new Client({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
    await client.connect();
    try {
        for (const zone of ["Europe/Bratislava", "UTC"]) {
            await t.test(`live lease is not expired under timezone=${zone}`, async () => {
                // Pin the zone explicitly: the ambient zone of the test host is irrelevant.
                await client.query(`SET timezone = '${zone}'`);
                const setting = await client.query("select current_setting('TimeZone') as zone");
                assert.equal(setting.rows[0].zone, zone, `session timezone was not applied for ${zone}`);

                const { rows } = await client.query(
                    "select lease_until > now() as live from tasks where id = $1",
                    [w.task.id],
                );
                assert.equal(rows.length, 1, "the leased row is still there");
                assert.equal(
                    rows[0].live,
                    true,
                    `lease_until > now() must hold under timezone=${zone}`,
                );
            });
        }
    } finally {
        await client.end();
    }
});
