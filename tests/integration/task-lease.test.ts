/**
 * Task lease: the mutex between sessions that share one agent.
 *
 * The platform used to accept `leaseOwner`/`leaseUntil` on
 * PATCH /api/mcp/tasks/{id}, answer 200 and drop both fields, so an agent
 * believed it held a lease it never had. These tests pin the replacement
 * contract: PATCH refuses the fields, and the dedicated lease endpoint is
 * atomic — a second session is told who holds the task instead of silently
 * starting duplicate work.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { bearer, call, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

/** Every MCP write carries a fresh idempotency key, like the bridge does. */
const auth = (bearerHeaders: Record<string, string>) => ({ ...bearerHeaders, "idempotency-key": randomUUID() });

async function world() {
    await resetDb();
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Solo" });
    const otherAgent = await seedAgent(companyId, { name: "Other" });

    const [project] = await db.insert(projects).values({
        companyId,
        goal: "Lease mutex",
        status: "active",
    }).returning();

    const [task] = await db.insert(tasks).values({
        companyId,
        projectId: project.id,
        taskType: "work",
        state: "in_progress",
        assignedAgentId: agent.id,
        inputJson: { title: "Work under a lease" },
    }).returning();

    return {
        db, tasks, companyId, project, task, agent, otherAgent,
        soloToken: bearer(await seedMcpToken(companyId, agent.id)),
        otherToken: bearer(await seedMcpToken(companyId, otherAgent.id)),
    };
}

const leaseRoute = () => import("@/app/api/mcp/tasks/[id]/lease/route");
const taskRoute = () => import("@/app/api/mcp/tasks/[id]/route");

const leaseOf = (json: Record<string, unknown>) => json.lease as { owner: string | null; until: string | null };

maybe("PATCH refuses the lease fields instead of answering 200 and dropping them", async () => {
    const w = await world();
    const route = await taskRoute();
    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.soloToken),
        params: { id: w.task.id },
        body: { leaseOwner: w.agent.id, leaseUntil: new Date(Date.now() + 600_000).toISOString() },
    });

    assert.equal(res.status, 400, "a lease-bearing PATCH must not be reported as success");
    assert.match(String(res.json.error), /lease/i);
    assert.match(String(res.json.error), new RegExp(`/api/mcp/tasks/${w.task.id}/lease`));

    const [after] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(after.leaseOwner, null, "PATCH must not write the owner it refuses");
    assert.equal(after.leaseUntil, null);
});

maybe("a second session is refused with the holder instead of getting the same lease", async () => {
    const w = await world();
    const route = await leaseRoute();

    const first = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id },
        body: { owner: "session-a" },
    });
    assert.equal(first.status, 200, first.text);
    assert.equal(leaseOf(first.json).owner, "session-a");

    const second = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id },
        body: { owner: "session-b" },
    });
    assert.equal(second.status, 409, "the second session must lose the race");
    assert.equal(second.json.leaseOwner, "session-a", "the loser must learn who holds the task");

    const [row] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(row.leaseOwner, "session-a", "the loser must not overwrite the owner");

    // The holder renews freely: same owner, fresh deadline.
    const renewed = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id },
        body: { owner: "session-a", ttlSeconds: 60 },
    });
    assert.equal(renewed.status, 200, renewed.text);
    assert.equal(leaseOf(renewed.json).owner, "session-a");
});

maybe("releasing the lease lets the other session take it", async () => {
    const w = await world();
    const route = await leaseRoute();

    await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id }, body: { owner: "session-a" },
    });
    const released = await call(route.DELETE, `/api/mcp/tasks/${w.task.id}/lease?owner=session-a`, {
        method: "DELETE", headers: auth(w.soloToken), params: { id: w.task.id },
    });
    assert.equal(released.status, 200, released.text);

    const [row] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(row.leaseOwner, null);
    assert.equal(row.leaseUntil, null);

    const taken = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id }, body: { owner: "session-b" },
    });
    assert.equal(taken.status, 200, taken.text);
    assert.equal(leaseOf(taken.json).owner, "session-b");
});

maybe("a session cannot release another session's lease", async () => {
    const w = await world();
    const route = await leaseRoute();

    await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id }, body: { owner: "session-a" },
    });
    const stolen = await call(route.DELETE, `/api/mcp/tasks/${w.task.id}/lease?owner=session-b`, {
        method: "DELETE", headers: auth(w.soloToken), params: { id: w.task.id },
    });
    assert.equal(stolen.status, 409, stolen.text);

    const [row] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(row.leaseOwner, "session-a");
});

maybe("an expired lease is free again", async () => {
    const w = await world();
    const route = await leaseRoute();

    await w.db.update(w.tasks).set({
        leaseOwner: "session-a",
        leaseUntil: new Date(Date.now() - 60_000),
    }).where(eq(w.tasks.id, w.task.id));

    const taken = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id }, body: { owner: "session-b" },
    });
    assert.equal(taken.status, 200, taken.text);
    assert.equal(leaseOf(taken.json).owner, "session-b");
});

maybe("an agent cannot lease a task assigned to another agent", async () => {
    const w = await world();
    const route = await leaseRoute();

    const res = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.otherToken), params: { id: w.task.id },
        body: { agentId: w.otherAgent.id, owner: "session-x" },
    });
    assert.equal(res.status, 403, res.text);

    const [row] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    assert.equal(row.leaseOwner, null);
});

maybe("takeover is the explicit escape hatch for a session that died holding the lease", async () => {
    const w = await world();
    const route = await leaseRoute();

    await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id }, body: { owner: "session-dead" },
    });
    const takenOver = await call(route.POST, `/api/mcp/tasks/${w.task.id}/lease`, {
        method: "POST", headers: auth(w.soloToken), params: { id: w.task.id },
        body: { owner: "session-live", takeover: true },
    });
    assert.equal(takenOver.status, 200, takenOver.text);
    assert.equal(leaseOf(takenOver.json).owner, "session-live");
});

maybe("claiming records the session as the owner, not the agent", async () => {
    const w = await world();
    const { claimNextTaskForAgent, createTaskForProject } = await import("@/lib/openclaw/tasks");

    await createTaskForProject({
        companyId: w.companyId,
        projectId: w.project.id,
        taskType: "work",
        inputJson: { title: "Queued work" },
        assignedAgentId: w.agent.id,
    });

    const claimed = await claimNextTaskForAgent({ companyId: w.companyId, agentId: w.agent.id, owner: "session-a" });
    assert.ok(claimed.task, "the queued task should be claimable");
    // Claim returns the raw row (snake_case), unlike the serialized API task.
    const claimedRow = claimed.task as unknown as { lease_owner?: string | null };
    assert.equal(claimedRow.lease_owner, "session-a");
    assert.notEqual(claimedRow.lease_owner, w.agent.id, "the owner must identify the session, not the agent");
});
