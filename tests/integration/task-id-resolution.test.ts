/**
 * A task id that is not a UUID must not reach Postgres — case 9f691848.
 *
 * On 2026-11-21 production answered `500 /api/mcp/tasks/7793dcfa` three times
 * (and `.../d8bcc948` earlier that evening) because the route passed the eight
 * character short code straight into `eq(tasks.id, $1)`, and the driver threw
 * `invalid input syntax for type uuid`. The product shows every task as that
 * short code, so a client pasting it back is normal usage, not an attack.
 *
 * Contract pinned here:
 * - a non-hex id is refused with 400 before any query, with a message naming
 *   what to send instead and no driver text;
 * - a short code or truncated id resolves to the one task it names (200);
 * - a short code that names no task is 404, and one that names two is 409;
 * - the same guard covers PATCH and DELETE, which had the same 500.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedCompanyWithToken } from "./_helper";
import { bearer, call } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

const taskRoute = () => import("@/app/api/mcp/tasks/[id]/route");

async function world() {
    await resetDb();
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const { companyId, rawToken } = await seedCompanyWithToken();

    const [project] = await db.insert(projects).values({
        companyId,
        goal: "Task id resolution",
        status: "active",
    }).returning();

    const [task] = await db.insert(tasks).values({
        companyId,
        projectId: project.id,
        taskType: "work",
        state: "in_progress",
        inputJson: { title: "A task a short code can name" },
    }).returning();

    return { db, companyId, rawToken, tasks, task, headers: bearer(rawToken) };
}

const get = async (id: string, headers: Record<string, string>) =>
    call((await taskRoute()).GET, `/api/mcp/tasks/${id}`, { headers, params: { id } });

maybe("an id that is not hex is a 400 with advice, never a driver 500", async () => {
    const { headers } = await world();
    for (const id of ["not-a-task-id", "task-7793dcfa", "7793dcfg", "abc"]) {
        const res = await get(id, headers);
        assert.equal(res.status, 400, id);
        assert.match(String(res.json.error), /UUID or its 8-character short code/, id);
        assert.doesNotMatch(res.text, /invalid input syntax|22P02|postgres|driver|at parse/i, `${id}: no database noise`);
    }
});

maybe("the eight-character short code resolves to its task, in either case", async () => {
    const { task, headers } = await world();
    const code = task.id.slice(0, 8);
    for (const id of [code, code.toUpperCase()]) {
        const res = await get(id, headers);
        assert.equal(res.status, 200, id);
        assert.equal((res.json.task as { id: string }).id, task.id, `${id} resolves to the task it names`);
    }
});

maybe("a truncated id and a dash-less uuid resolve to the same task", async () => {
    const { task, headers } = await world();
    const dashless = task.id.replace(/-/g, "");
    for (const id of [dashless.slice(0, 12), dashless]) {
        const res = await get(id, headers);
        assert.equal(res.status, 200, id);
        assert.equal((res.json.task as { id: string }).id, task.id, id);
    }
});

maybe("a well-formed id that names no task is a 404, not a 500", async () => {
    const { headers } = await world();
    const missing = randomUUID();
    const byUuid = await get(missing, headers);
    assert.equal(byUuid.status, 404);
    assert.equal(byUuid.json.error, "Task not found");

    const byCode = await get(missing.slice(0, 8), headers);
    assert.equal(byCode.status, 404, "no task starts with that code");
    assert.match(String(byCode.json.error), /no task in this company starts with that code/);
});

maybe("a short code that names two tasks is a 409 that asks for the full id", async () => {
    const { db, companyId, tasks, headers } = await world();
    const { projects } = await getSchema();
    const [project] = await db.insert(projects).values({
        companyId,
        goal: "Ambiguous codes",
        status: "active",
    }).returning();
    const shared = "abcdef01";
    for (const tail of ["0000-4000-8000-000000000001", "0000-4000-8000-000000000002"]) {
        await db.insert(tasks).values({
            id: `${shared}-${tail}`,
            companyId,
            projectId: project.id,
            taskType: "work",
            state: "inbox",
            inputJson: { title: `Twin ${tail}` },
        });
    }

    const res = await get(shared, headers);
    assert.equal(res.status, 409);
    assert.match(String(res.json.error), /ambiguous/i);
    assert.match(String(res.json.error), /full UUID/i);

    const exact = await get(`${shared}-0000-4000-8000-000000000002`, headers);
    assert.equal(exact.status, 200, "the full id is never ambiguous");
});

maybe("PATCH and DELETE refuse a malformed id with 400 before touching anything", async () => {
    const { db, headers, tasks, task } = await world();
    const route = await taskRoute();
    const malformed = "not-a-task-id";
    const patched = await call(route.PATCH, `/api/mcp/tasks/${malformed}`, {
        method: "PATCH",
        headers: { ...headers, "idempotency-key": randomUUID() },
        body: { state: "done" },
        params: { id: malformed },
    });
    assert.equal(patched.status, 400);
    assert.match(String(patched.json.error), /UUID or its 8-character short code/);

    const deleted = await call(route.DELETE, `/api/mcp/tasks/${malformed}`, {
        method: "DELETE",
        headers: { ...headers, "idempotency-key": randomUUID() },
        params: { id: malformed },
    });
    assert.equal(deleted.status, 400);

    // A well-formed short code that names nothing is a 404 on these verbs too,
    // not a 400: the id is fine, the task is simply not there.
    const staleCode = "7793dcfa";
    const stale = await call(route.PATCH, `/api/mcp/tasks/${staleCode}`, {
        method: "PATCH",
        headers: { ...headers, "idempotency-key": randomUUID() },
        body: { state: "done" },
        params: { id: staleCode },
    });
    assert.equal(stale.status, 404);

    const rows = await db.select().from(tasks);
    assert.equal(rows.length, 1, "no task was written");
    assert.equal(rows[0].state, task.state, "the task the code never named is untouched");
});
