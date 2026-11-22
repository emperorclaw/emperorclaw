/**
 * A task that reaches a terminal state cannot keep its lease.
 *
 * #36 taught the heartbeat and the watchdog to drop the hold when work ends,
 * but the route every client actually closes work through is
 * `PATCH /api/mcp/tasks/{id}` → `updateTaskForCompany`, and that writer only
 * released the lease when the assignment changed. Measured in production on
 * v0.42.8: claiming the task, beating on it, then PATCHing `state=done` left
 * `lease_owner`, `lease_session` and `lease_until` on a finished row — a hold
 * nobody can release, read as live work by the board and by every other
 * session of the agent.
 *
 * These tests pin the invariant at the level clients see it: any write that
 * leaves a row terminal clears the lease (including a write to a row that was
 * already terminal, which is how the rows inherited from before the fix heal),
 * a non-terminal write keeps it, and the lease endpoint refuses to re-arm a
 * finished task.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

/** Every MCP write carries a fresh idempotency key, like the bridge does. */
const auth = (bearerHeaders: Record<string, string>) => ({ ...bearerHeaders, "idempotency-key": randomUUID() });

const taskRoute = () => import("@/app/api/mcp/tasks/[id]/route");
const leaseRoute = () => import("@/app/api/mcp/tasks/[id]/lease/route");

async function world(state: "in_progress" | "done" = "in_progress") {
    await resetDb();
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Solo" });

    const [project] = await db.insert(projects).values({
        companyId,
        goal: "Terminal lease",
        status: "active",
    }).returning();

    const [task] = await db.insert(tasks).values({
        companyId,
        projectId: project.id,
        taskType: "work",
        state,
        assignedAgentId: agent.id,
        inputJson: { title: "Work that ends" },
    }).returning();

    return {
        db, tasks, companyId, project, task, agent,
        token: bearer(await seedMcpToken(companyId, agent.id)),
    };
}

/** Take the lease through the endpoint clients use, and assert it landed. */
async function claim(w: Awaited<ReturnType<typeof world>>, session = "session-a") {
    const route = await leaseRoute();
    const res = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST",
        headers: auth(w.token),
        params: { id: w.task.id },
        body: { owner: session, ttlSeconds: 600 },
    });
    assert.equal(res.status, 200, `claim failed: ${JSON.stringify(res.json)}`);
    const [row] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(row.leaseSession, session, "the fixture must actually hold a lease");
    assert.ok(row.leaseUntil, "the fixture must actually hold a lease");
    return row;
}

async function patchState(w: Awaited<ReturnType<typeof world>>, state: string) {
    const route = await taskRoute();
    return call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.token),
        params: { id: w.task.id },
        body: { state },
    });
}

maybe("finishing a claimed task over PATCH drops owner, session and expiry", async () => {
    const w = await world();
    await claim(w, "builder-probe-s1");

    const res = await patchState(w, "done");
    assert.equal(res.status, 200, `PATCH done failed: ${JSON.stringify(res.json)}`);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.state, "done");
    assert.equal(after.leaseOwner, null, "a done row must not report a holder");
    assert.equal(after.leaseSession, null, "a done row must not report a session");
    assert.equal(after.leaseUntil, null, "a done row must not report an expiry");
});

maybe("failing a claimed task over PATCH drops the lease too", async () => {
    const w = await world();
    await claim(w, "session-f");

    const res = await patchState(w, "failed");
    assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(res.json)}`);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.state, "failed");
    assert.equal(after.leaseOwner, null);
    assert.equal(after.leaseSession, null);
    assert.equal(after.leaseUntil, null);
});

maybe("a PATCH that does not end the work keeps the lease", async () => {
    const w = await world();
    await claim(w, "session-live");

    // A title edit and a move to review are both still live work from the
    // lease's point of view: the holder must not lose its mutex to an edit.
    const route = await taskRoute();
    const titled = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.token),
        params: { id: w.task.id },
        body: { title: "Renamed while held" },
    });
    assert.equal(titled.status, 200, `title PATCH failed: ${JSON.stringify(titled.json)}`);

    const review = await patchState(w, "review");
    assert.equal(review.status, 200, `PATCH review failed: ${JSON.stringify(review.json)}`);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.state, "review");
    assert.equal(after.leaseSession, "session-live", "review is not the end of the work");
    assert.ok(after.leaseUntil, "the hold must survive a non-terminal write");
});

maybe("a write to a row that is already terminal clears a lease it inherited", async () => {
    // The rows that predate the fix: done, but still carrying a hold. Any write
    // that touches them must leave them clean, or they never heal.
    const w = await world("in_progress");
    const [stale] = await w.db.update(w.tasks).set({
        state: "done",
        leaseOwner: w.agent.id,
        leaseSession: "dead-session",
        leaseUntil: new Date(Date.now() + 600_000),
    }).where(eq(w.tasks.id, w.task.id)).returning();
    assert.equal(stale.state, "done");

    const route = await taskRoute();
    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.token),
        params: { id: w.task.id },
        body: { title: "Touched after it ended" },
    });
    assert.equal(res.status, 200, `PATCH failed: ${JSON.stringify(res.json)}`);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.leaseOwner, null, "a terminal row heals on the next write");
    assert.equal(after.leaseSession, null);
    assert.equal(after.leaseUntil, null);
});

maybe("the lease endpoint refuses to arm a finished task", async () => {
    const w = await world("done");
    const route = await leaseRoute();
    const res = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST",
        headers: auth(w.token),
        params: { id: w.task.id },
        body: { owner: "late-session", ttlSeconds: 600 },
    });
    assert.equal(res.status, 409, `a done task is not claimable: ${JSON.stringify(res.json)}`);
    assert.match(String(res.json.error), /done|finished|terminal/i);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.leaseOwner, null, "the refused claim must not write a lease");
    assert.equal(after.leaseUntil, null);
});

maybe("archiving a held task releases the hold as well", async () => {
    const w = await world();
    await claim(w, "session-a");

    const route = await taskRoute();
    const res = await call(route.DELETE, `/api/mcp/tasks/${w.task.id}`, {
        method: "DELETE",
        headers: auth(w.token),
        params: { id: w.task.id },
    });
    assert.equal(res.status, 200, `DELETE failed: ${JSON.stringify(res.json)}`);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.ok(after.deletedAt, "the task must be archived");
    assert.equal(after.leaseOwner, null, "an archived row must not hold a lease");
    assert.equal(after.leaseSession, null);
    assert.equal(after.leaseUntil, null);
});

maybe("the UI's own PATCH closes a held task and drops the lease too", async () => {
    // `PATCH /api/tasks/{id}` is the board's route: a person, a session, a role
    // check — and the same `updateTaskForCompany` underneath.
    const w = await world();
    await claim(w, "session-ui");
    actAs(await seedHuman(w.companyId, "owner"));

    const ui = await import("@/app/api/tasks/[id]/route");
    const res = await call(ui.PATCH, `/api/tasks/${w.task.id}`, {
        method: "PATCH",
        params: { id: w.task.id },
        body: { state: "done" },
    });
    assert.equal(res.status, 200, `UI PATCH failed: ${JSON.stringify(res.json)}`);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.state, "done");
    assert.equal(after.leaseOwner, null, "closing from the board releases the hold");
    assert.equal(after.leaseSession, null);
    assert.equal(after.leaseUntil, null);
});

maybe("the update_task tool closes a held task and drops the lease too", async () => {
    // The agents' own path: no HTTP route, the MCP tool and the same writer.
    const w = await world();
    await claim(w, "session-tool");
    const client = await mcpClientFor(w.companyId, w.agent.id);

    const res = await client.tool("update_task", { taskId: w.task.id, state: "done" });
    assert.equal(res.isError, false, `update_task failed: ${res.text}`);

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.state, "done");
    assert.equal(after.leaseOwner, null, "closing through update_task releases the hold");
    assert.equal(after.leaseSession, null);
    assert.equal(after.leaseUntil, null);
});
