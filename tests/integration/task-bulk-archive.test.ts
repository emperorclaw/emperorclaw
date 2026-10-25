/**
 * Bulk archive / undo (POST /api/tasks/archive and /api/tasks/unarchive)
 * through the real route handlers with a real DB session. The checks must be
 * exactly the single DELETE's: role (viewers refused), company, and a
 * restricted member's scope; anything the caller may not touch is skipped.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb } from "./_helper";
import { actAs, call, seedHuman, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function company(name = "Bulk Co") {
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [row] = await db.insert(companies).values({ name, createdByUserId: creator.id }).returning();
    return row.id;
}

async function doneTasks(companyId: string, projectId: string, count: number) {
    const db = await getDb();
    const { tasks } = await getSchema();
    const rows = await db.insert(tasks).values(Array.from({ length: count }, (_, i) => ({
        companyId, projectId, taskType: "work", state: "done", inputJson: { title: `Done ${i}` },
    }))).returning();
    return rows.map((row) => row.id);
}

async function deletedAtOf(ids: string[]) {
    const db = await getDb();
    const { tasks } = await getSchema();
    const { inArray } = await import("drizzle-orm");
    const rows = await db.select({ id: tasks.id, deletedAt: tasks.deletedAt }).from(tasks).where(inArray(tasks.id, ids));
    return new Map(rows.map((row) => [row.id, row.deletedAt]));
}

const archive = async (taskIds: unknown) => call((await import("@/app/api/tasks/archive/route")).POST as never, "/api/tasks/archive", { method: "POST", body: { taskIds } });
const unarchive = async (taskIds: unknown) => call((await import("@/app/api/tasks/unarchive/route")).POST as never, "/api/tasks/unarchive", { method: "POST", body: { taskIds } });

maybe("owner archives several tasks at once", async () => {
    await resetDb();
    const companyId = await company();
    const work = await seedTwoTenantsOfWork(companyId);
    const ids = await doneTasks(companyId, work.projectIn.id, 3);
    actAs(await seedHuman(companyId, "owner"));

    const missing = randomUUID();
    const res = await archive([...ids, missing, "not-a-uuid"]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([...(res.json.archived as string[])].sort(), [...ids].sort());
    assert.deepEqual([...(res.json.skipped as string[])].sort(), [missing, "not-a-uuid"].sort());

    const state = await deletedAtOf(ids);
    for (const id of ids) assert.ok(state.get(id), `task ${id} was not archived`);

    // Already archived: skipped the second time, not archived again.
    const again = await archive(ids);
    assert.deepEqual(again.json.archived, []);
    assert.equal((again.json.skipped as string[]).length, ids.length);
});

maybe("bad bodies are rejected", async () => {
    await resetDb();
    const companyId = await company();
    actAs(await seedHuman(companyId, "owner"));
    assert.equal((await archive([])).status, 400);
    assert.equal((await archive("x")).status, 400);
    assert.equal((await archive([1, 2])).status, 400);
    assert.equal((await archive(Array.from({ length: 201 }, () => randomUUID()))).status, 400);
    assert.equal((await unarchive(undefined)).status, 400);
});

maybe("a viewer is refused and nothing changes", async () => {
    await resetDb();
    const companyId = await company();
    const work = await seedTwoTenantsOfWork(companyId);
    const ids = await doneTasks(companyId, work.projectIn.id, 2);
    actAs(await seedHuman(companyId, "viewer"));

    const res = await archive(ids);
    assert.equal(res.status, 403, res.text);
    const undo = await unarchive(ids);
    assert.equal(undo.status, 403, undo.text);
    const state = await deletedAtOf(ids);
    for (const id of ids) assert.equal(state.get(id), null);
});

maybe("a restricted member archives only in-scope tasks; the rest are skipped", async () => {
    await resetDb();
    const companyId = await company();
    const work = await seedTwoTenantsOfWork(companyId);
    const inIds = await doneTasks(companyId, work.projectIn.id, 2);
    const outIds = await doneTasks(companyId, work.projectOut.id, 2);
    actAs(await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [], customerIds: [work.customerIn.id] } }));

    const res = await archive([...inIds, ...outIds]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([...(res.json.archived as string[])].sort(), [...inIds].sort());
    assert.deepEqual([...(res.json.skipped as string[])].sort(), [...outIds].sort());
    const state = await deletedAtOf([...inIds, ...outIds]);
    for (const id of outIds) assert.equal(state.get(id), null, "an out-of-scope task was archived");

    // The single DELETE shares the same rule.
    const del = (await import("@/app/api/tasks/[id]/route")).DELETE as never;
    assert.equal((await call(del, `/api/tasks/${outIds[0]}`, { method: "DELETE", params: { id: outIds[0] } })).status, 404);
});

maybe("ids from another company are skipped", async () => {
    await resetDb();
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const myWork = await seedTwoTenantsOfWork(mine);
    const theirWork = await seedTwoTenantsOfWork(theirs);
    const myIds = await doneTasks(mine, myWork.projectIn.id, 1);
    const theirIds = await doneTasks(theirs, theirWork.projectIn.id, 2);
    actAs(await seedHuman(mine, "owner"));

    const res = await archive([...myIds, ...theirIds]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.archived, myIds);
    assert.deepEqual([...(res.json.skipped as string[])].sort(), [...theirIds].sort());
    const state = await deletedAtOf(theirIds);
    for (const id of theirIds) assert.equal(state.get(id), null, "another company's task was archived");
});

maybe("unarchive restores only recent archives the caller may edit", async () => {
    await resetDb();
    const companyId = await company();
    const other = await company("Other");
    const work = await seedTwoTenantsOfWork(companyId);
    const otherWork = await seedTwoTenantsOfWork(other);
    const db = await getDb();
    const { tasks } = await getSchema();
    const { inArray } = await import("drizzle-orm");

    const recentIn = await doneTasks(companyId, work.projectIn.id, 2);
    const oldIn = await doneTasks(companyId, work.projectIn.id, 1);
    const recentOut = await doneTasks(companyId, work.projectOut.id, 1);
    const live = await doneTasks(companyId, work.projectIn.id, 1);
    const foreign = await doneTasks(other, otherWork.projectIn.id, 1);
    await db.update(tasks).set({ deletedAt: new Date(Date.now() - 60_000) }).where(inArray(tasks.id, [...recentIn, ...recentOut, ...foreign]));
    await db.update(tasks).set({ deletedAt: new Date(Date.now() - 11 * 60_000) }).where(inArray(tasks.id, oldIn));

    actAs(await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [], customerIds: [work.customerIn.id] } }));
    const res = await unarchive([...recentIn, ...oldIn, ...recentOut, ...live, ...foreign]);
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([...(res.json.restored as string[])].sort(), [...recentIn].sort());
    assert.deepEqual([...(res.json.skipped as string[])].sort(), [...oldIn, ...recentOut, ...live, ...foreign].sort());

    const state = await deletedAtOf([...recentIn, ...oldIn, ...recentOut, ...foreign]);
    for (const id of recentIn) assert.equal(state.get(id), null, "a recent in-scope archive was not restored");
    for (const id of [...oldIn, ...recentOut, ...foreign]) assert.ok(state.get(id), `task ${id} was restored but should not be`);

    // Round trip as an owner: archive, then undo.
    actAs(await seedHuman(companyId, "owner"));
    const archived = await archive(recentIn);
    assert.deepEqual([...(archived.json.archived as string[])].sort(), [...recentIn].sort());
    const undone = await unarchive(recentIn);
    assert.deepEqual([...(undone.json.restored as string[])].sort(), [...recentIn].sort());
});
