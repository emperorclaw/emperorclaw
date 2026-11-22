/**
 * A task dependency is a write, not a comment.
 *
 * `PATCH /api/mcp/tasks/{id}` used to accept `blockedByTaskIds`, answer 200 and
 * write nothing (reported 2026-11-22 against 0.42.9): the caller believed the
 * task was waiting on another one while the board, the review buckets and the
 * next-task query still saw it as free. These tests pin the write itself, the
 * refusals that keep the dependency graph readable, and that what lands in the
 * column is exactly what the guards read.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { randomUUID } from "node:crypto";

import {
    dbAvailable,
    getDb,
    getSchema,
    resetDb,
    seedAgent,
    seedCompanyWithToken,
} from "./_helper";
import { bearer, call } from "./_access-helper";
import { REVIEW_BUCKETS, resolveReviewBucket } from "@/lib/project-workflow";

const describeDb = dbAvailable ? describe : describe.skip;

let route: typeof import("@/app/api/mcp/tasks/[id]/route");
let companyId = "";
let rawToken = "";
let agentId = "";

async function seedProject(company = companyId) {
    const db = await getDb();
    const { projects } = await getSchema();
    const [project] = await db
        .insert(projects)
        .values({
            companyId: company,
            goal: "Dependency fixture",
            status: "active",
        })
        .returning();
    return project;
}

/** A task carries its title in inputJson.title, and always belongs to a project. */
async function seedTask(
    overrides: Record<string, unknown> = {},
    company = companyId,
) {
    const db = await getDb();
    const { tasks } = await getSchema();
    const { title, projectId, inputJson, ...rest } = overrides as {
        title?: string;
        projectId?: string;
        inputJson?: Record<string, unknown>;
        [key: string]: unknown;
    };
    const [task] = await db
        .insert(tasks)
        .values({
            companyId: company,
            projectId: projectId ?? (await seedProject(company)).id,
            taskType: "work",
            state: "inbox",
            inputJson: inputJson ?? { title: title ?? "Dep test task" },
            ...rest,
        })
        .returning();
    return task;
}

async function readTask(id: string) {
    const db = await getDb();
    const { tasks } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    return row;
}

async function patch(
    id: string,
    body: Record<string, unknown>,
    token = rawToken,
) {
    return call(route.PATCH, `/api/mcp/tasks/${id}`, {
        method: "PATCH",
        headers: { ...bearer(token), "idempotency-key": randomUUID() },
        params: { id },
        body,
    });
}

describeDb("task dependencies", () => {
    before(async () => {
        route = await import("@/app/api/mcp/tasks/[id]/route");
    });

    beforeEach(async () => {
        await resetDb();
        const seeded = await seedCompanyWithToken();
        companyId = seeded.companyId;
        rawToken = seeded.rawToken;
        agentId = (await seedAgent(companyId)).id;
    });

    after(async () => {
        const db = await getDb();
        await db.$client?.end?.();
    });

    it("writes blockedByTaskIds and returns the stored list", async () => {
        const blocker = await seedTask({
            title: "Blocker",
            state: "in_progress",
            assignedAgentId: agentId,
        });
        const blocked = await seedTask({ title: "Blocked" });

        const res = await patch(blocked.id, { blockedByTaskIds: [blocker.id] });

        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.deepEqual(res.json.task.blockedByTaskIds, [blocker.id]);
        const stored = await readTask(blocked.id);
        assert.deepEqual(stored.blockedByTaskIds, [blocker.id]);
    });

    it("the stored dependency is what the guards read", async () => {
        const blocker = await seedTask({
            title: "Blocker",
            state: "in_progress",
        });
        const blocked = await seedTask({ title: "Blocked" });

        await patch(blocked.id, { blockedByTaskIds: [blocker.id] });

        const db = await getDb();
        const { tasks } = await getSchema();
        const { eq } = await import("drizzle-orm");
        const rows = await db
            .select()
            .from(tasks)
            .where(eq(tasks.companyId, companyId));
        const byId = new Map(
            rows.map((row) => [row.id, { id: row.id, state: row.state }]),
        );

        assert.equal(
            resolveReviewBucket({
                task: rows.find((row) => row.id === blocked.id)!,
                tasksById: byId,
            }),
            REVIEW_BUCKETS.blocked,
        );

        // The dependency stops blocking once the task it names is done.
        await db
            .update(tasks)
            .set({ state: "done" })
            .where(eq(tasks.id, blocker.id));
        const after = await db
            .select()
            .from(tasks)
            .where(eq(tasks.companyId, companyId));
        const afterById = new Map(
            after.map((row) => [row.id, { id: row.id, state: row.state }]),
        );
        assert.equal(
            resolveReviewBucket({
                task: after.find((row) => row.id === blocked.id)!,
                tasksById: afterById,
            }),
            REVIEW_BUCKETS.readyToClose,
        );
    });

    it("refuses an unknown id and writes nothing", async () => {
        const blocked = await seedTask({ title: "Blocked" });

        const res = await patch(blocked.id, {
            blockedByTaskIds: [randomUUID()],
        });

        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected 4xx, got ${res.status}`,
        );
        assert.match(String(res.json.error), /not found/i);
        assert.deepEqual((await readTask(blocked.id)).blockedByTaskIds, []);
    });

    it("refuses a dependency that belongs to another company", async () => {
        const other = await seedCompanyWithToken();
        const foreign = await seedTask({ title: "Foreign" }, other.companyId);
        const blocked = await seedTask({ title: "Blocked" });

        const res = await patch(blocked.id, { blockedByTaskIds: [foreign.id] });

        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected 4xx, got ${res.status}`,
        );
        assert.deepEqual((await readTask(blocked.id)).blockedByTaskIds, []);
    });

    it("refuses a soft-deleted dependency", async () => {
        const gone = await seedTask({ title: "Gone", deletedAt: new Date() });
        const blocked = await seedTask({ title: "Blocked" });

        const res = await patch(blocked.id, { blockedByTaskIds: [gone.id] });

        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected 4xx, got ${res.status}`,
        );
        assert.deepEqual((await readTask(blocked.id)).blockedByTaskIds, []);
    });

    it("refuses a task blocked by itself", async () => {
        const blocked = await seedTask({ title: "Blocked" });

        const res = await patch(blocked.id, { blockedByTaskIds: [blocked.id] });

        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected 4xx, got ${res.status}`,
        );
        assert.match(String(res.json.error), /blocked by itself/i);
        assert.deepEqual((await readTask(blocked.id)).blockedByTaskIds, []);
    });

    it("refuses a cycle and names the path", async () => {
        const first = await seedTask({ title: "First" });
        const second = await seedTask({ title: "Second" });

        assert.equal(
            (await patch(first.id, { blockedByTaskIds: [second.id] })).status,
            200,
        );

        const res = await patch(second.id, { blockedByTaskIds: [first.id] });

        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected 4xx, got ${res.status}`,
        );
        assert.match(String(res.json.error), /cycle/i);
        assert.deepEqual((await readTask(second.id)).blockedByTaskIds, []);
        assert.deepEqual((await readTask(first.id)).blockedByTaskIds, [
            second.id,
        ]);
    });

    it("refuses a malformed list instead of filtering it", async () => {
        const blocked = await seedTask({ title: "Blocked" });

        for (const value of ["not-an-array", [42], [""], { id: "x" }]) {
            const res = await patch(blocked.id, { blockedByTaskIds: value });
            assert.ok(
                res.status >= 400 && res.status < 500,
                `expected 4xx for ${JSON.stringify(value)}, got ${res.status}`,
            );
            assert.deepEqual((await readTask(blocked.id)).blockedByTaskIds, []);
        }
    });

    it("one bad id refuses the whole list (no partial write)", async () => {
        const blocker = await seedTask({
            title: "Blocker",
            state: "in_progress",
        });
        const blocked = await seedTask({ title: "Blocked" });

        const res = await patch(blocked.id, {
            blockedByTaskIds: [blocker.id, randomUUID()],
        });

        assert.ok(
            res.status >= 400 && res.status < 500,
            `expected 4xx, got ${res.status}`,
        );
        assert.deepEqual((await readTask(blocked.id)).blockedByTaskIds, []);
    });

    it("an empty array clears the dependencies", async () => {
        const blocker = await seedTask({
            title: "Blocker",
            state: "in_progress",
        });
        const blocked = await seedTask({
            title: "Blocked",
            blockedByTaskIds: [blocker.id],
        });

        const res = await patch(blocked.id, { blockedByTaskIds: [] });

        assert.equal(res.status, 200, JSON.stringify(res.json));
        assert.deepEqual(res.json.task.blockedByTaskIds, []);
        assert.deepEqual((await readTask(blocked.id)).blockedByTaskIds, []);
    });

    it("omitting the field leaves the dependencies untouched", async () => {
        const blocker = await seedTask({
            title: "Blocker",
            state: "in_progress",
        });
        const blocked = await seedTask({
            title: "Blocked",
            blockedByTaskIds: [blocker.id],
        });

        const res = await patch(blocked.id, { title: "Renamed" });

        assert.equal(res.status, 200, JSON.stringify(res.json));
        const stored = await readTask(blocked.id);
        assert.equal(
            (stored.inputJson as Record<string, unknown>).title,
            "Renamed",
        );
        assert.deepEqual(stored.blockedByTaskIds, [blocker.id]);
    });

    it("records the change on the task timeline", async () => {
        const blocker = await seedTask({
            title: "Blocker",
            state: "in_progress",
        });
        const blocked = await seedTask({ title: "Blocked" });

        await patch(blocked.id, { blockedByTaskIds: [blocker.id] });

        const db = await getDb();
        const { taskEvents } = await getSchema();
        const { eq } = await import("drizzle-orm");
        const events = await db
            .select()
            .from(taskEvents)
            .where(eq(taskEvents.taskId, blocked.id));
        const update = events.find(
            (event) => event.eventType === "task_updated",
        );
        assert.ok(update, "expected a task_updated event");
        const payload = update!.payloadJson as Record<string, unknown>;
        assert.deepEqual(payload.blockedByTaskIds, [blocker.id]);
        assert.deepEqual(payload.previousBlockedByTaskIds, []);
    });
});
