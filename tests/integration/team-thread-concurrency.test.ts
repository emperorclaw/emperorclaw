import { test } from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

/**
 * The team-thread get-or-create used to 500 under concurrency: two `/messages`
 * renders both saw "no team thread", both inserted, the loser hit
 * message_threads_one_team_per_company and the page answered 500 (chat e2e
 * flake on main). This exercises the real partial unique index.
 */
maybe("concurrent get-or-create calls return a single team thread", async () => {
    await resetDb();
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const { ensureTeamThread } = await import("@/lib/control-plane");
    const { and, eq, isNull } = await import("drizzle-orm");

    // The real race is timing dependent, so hammer it: five companies, four
    // simultaneous first renders each. Under the pre-fix code at least one of
    // these batches left a caller holding 23505.
    for (let round = 0; round < 5; round += 1) {
        const { companyId } = await seedCompanyWithToken();
        const settled = await Promise.allSettled(
            Array.from({ length: 4 }, () => ensureTeamThread(companyId)),
        );

        const rejected = settled.filter((result) => result.status === "rejected");
        assert.equal(
            rejected.length,
            0,
            `round ${round}: every concurrent caller must succeed, got ${rejected.map((r) => String((r as PromiseRejectedResult).reason?.cause ?? (r as PromiseRejectedResult).reason)).join(" | ")}`,
        );

        const ids = new Set(
            settled.map((result) => (result as PromiseFulfilledResult<{ id: string }>).value.id),
        );
        assert.equal(ids.size, 1, `round ${round}: every concurrent caller must receive the same thread`);

        const rows = await db.select().from(messageThreads).where(and(
            eq(messageThreads.companyId, companyId),
            eq(messageThreads.type, "team"),
            isNull(messageThreads.archivedAt),
        ));
        assert.equal(rows.length, 1, `round ${round}: the partial unique index allows exactly one live team thread`);
    }
});

maybe("a second wave still finds the thread created by the first", async () => {
    await resetDb();
    const { ensureTeamThread } = await import("@/lib/control-plane");
    const { companyId } = await seedCompanyWithToken();

    const [first, second] = await Promise.all([ensureTeamThread(companyId), ensureTeamThread(companyId)]);
    const third = await ensureTeamThread(companyId);

    assert.equal(first.id, second.id);
    assert.equal(third.id, first.id);
});
