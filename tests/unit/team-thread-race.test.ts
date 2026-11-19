import { test } from "node:test";
import assert from "node:assert/strict";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { getOrCreateTeamThread, type TeamThreadStore } from "../../src/lib/control-plane";

type Row = { id: string; companyId: string; type: string; archivedAt: Date | null; createdAt: Date };

const row = (id: string): Row => ({
    id,
    companyId: "company-1",
    type: "team",
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
});

/** The 23505 exactly as it reaches the page: drizzle wraps the pg error. */
function uniqueViolation(): DrizzleQueryError {
    const pgError = Object.assign(
        new Error('duplicate key value violates unique constraint "message_threads_one_team_per_company"'),
        { code: "23505", constraint: "message_threads_one_team_per_company", severity: "ERROR" },
    );
    return new DrizzleQueryError(
        'insert into "message_threads" ("company_id", "type", "title") values ($1, $2, $3) returning *',
        ["company-1", "team", "Agent Team Chat"],
        pgError,
    );
}

/**
 * A store that behaves like the partial unique index: one team thread per
 * company, and the second concurrent insert loses with 23505. `serialize`
 * mirrors the real adapter's advisory lock; turn it off to simulate a caller
 * that raced outside the lock.
 */
function fakeStore({ serialize }: { serialize: boolean }) {
    let stored: Row | undefined;
    let creates = 0;
    let holdsLock = false;

    const store: TeamThreadStore = {
        async serialized<T>(work: (tx: never) => Promise<T>): Promise<T> {
            if (!serialize) return work(undefined as never);
            while (holdsLock) await new Promise((resolve) => setTimeout(resolve, 1));
            holdsLock = true;
            try {
                return await work(undefined as never);
            } finally {
                holdsLock = false;
            }
        },
        async find() {
            return stored;
        },
        async create() {
            creates += 1;
            const id = `thread-${creates}`;
            await new Promise((resolve) => setTimeout(resolve, 5));
            if (stored) throw uniqueViolation();
            stored = row(id);
            return stored;
        },
    };

    return { store, creates: () => creates, current: () => stored };
}

test("two concurrent get-or-create calls return one thread and never throw", async () => {
    const fake = fakeStore({ serialize: true });

    const [first, second] = await Promise.all([
        getOrCreateTeamThread("company-1", fake.store),
        getOrCreateTeamThread("company-1", fake.store),
    ]);

    assert.equal(first.id, second.id);
    assert.equal(fake.creates(), 1, "the serialized section must create the thread once");
});

test("a caller that raced outside the lock adopts the winner instead of answering 500", async () => {
    const fake = fakeStore({ serialize: false });

    const [first, second] = await Promise.all([
        getOrCreateTeamThread("company-1", fake.store),
        getOrCreateTeamThread("company-1", fake.store),
    ]);

    assert.equal(first.id, second.id);
    assert.equal(fake.creates(), 2, "both callers tried to insert; the loser recovered");
});

test("an existing team thread is returned without inserting", async () => {
    const fake = fakeStore({ serialize: true });
    const created = await getOrCreateTeamThread("company-1", fake.store);
    const again = await getOrCreateTeamThread("company-1", fake.store);

    assert.equal(again.id, created.id);
    assert.equal(fake.creates(), 1);
});

test("errors that are not unique violations still surface", async () => {
    const fake = fakeStore({ serialize: true });
    const broken: TeamThreadStore = {
        ...fake.store,
        async create() {
            const pgError = Object.assign(new Error("insert or update on table violates foreign key constraint"), { code: "23503" });
            throw new DrizzleQueryError('insert into "message_threads" ...', [], pgError);
        },
    };

    await assert.rejects(() => getOrCreateTeamThread("company-1", broken), /Failed query/);
});
