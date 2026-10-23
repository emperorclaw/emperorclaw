// Runs the server code in a non-UTC timezone: timestamps must still be stored and
// compared as UTC (a live run used to be swept as lost a minute in on such hosts).
process.env.TZ = "Europe/Bratislava";

import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

maybe("a run started seconds ago is not swept as lost on a non-UTC host", async () => {
    assert.notEqual(new Date(Date.UTC(2026, 6, 1, 12)).getHours(), 12, "the test must run with a non-UTC offset");
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Live" });
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const now = new Date();
    await db.insert(agentRuns).values({
        id: randomUUID(), companyId, agentId: agent.id, status: "running", startedAt: new Date(now.getTime() - 10_000),
    });

    const { closeLostRuns } = await import("@/lib/run-ledger");
    await closeLostRuns(now);

    const [row] = await db.select().from(agentRuns);
    assert.equal(row.status, "running");
});

maybe("raw pg reads and writes timestamps as UTC on a non-UTC host", async () => {
    await import("@/db/pg-utc");
    const { Pool } = await import("pg");
    const pool = new Pool({ connectionString: process.env.POSTGRES_CONNECTION_STRING, options: "-c timezone=UTC" });
    try {
        const instant = new Date("2026-10-23T12:00:00.000Z");
        const { rows } = await pool.query("select $1::timestamp as ts, $1::timestamp::text as txt", [instant]);
        assert.equal(rows[0].txt, "2026-10-23 12:00:00");
        assert.equal((rows[0].ts as Date).toISOString(), instant.toISOString());
    } finally {
        await pool.end();
    }
});
