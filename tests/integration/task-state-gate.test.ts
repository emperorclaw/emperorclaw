/**
 * Status transitions are signed and owned — case c87002d6.
 *
 * On 2026-11-19 the same identity implemented, merged and closed a task through
 * the normal MCP path, and `PATCH /tasks/{id}` answered 200 for any token: a
 * non-assignee could close someone else's work, and the event it wrote had no
 * actor to blame. These tests pin the replacement contract at the route level:
 *
 * - a non-assignee may not change the status or the assignee (403, no write);
 * - the assignee may, and the audit entry carries the agent that did it;
 * - an unbound token is refused instead of being recorded as `system`, and
 *   naming the agent (query or body) is what signs the write.
 *
 * A closed task cannot be reopened through the API (409), so the gate has to
 * hold *before* the close is accepted: every case here asserts the row too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { bearer, call, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

const auth = (bearerHeaders: Record<string, string>) => ({ ...bearerHeaders, "idempotency-key": randomUUID() });
const taskRoute = () => import("@/app/api/mcp/tasks/[id]/route");

async function world(options: { projectLead?: "owner" | "intruder" | null } = {}) {
    await resetDb();
    const db = await getDb();
    const { projects, tasks, auditLog, taskEvents } = await getSchema();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const owner = await seedAgent(companyId, { name: "Owner" });
    const intruder = await seedAgent(companyId, { name: "Intruder" });
    const lead = options.projectLead === "intruder" ? intruder : options.projectLead === "owner" ? owner : null;

    const [project] = await db.insert(projects).values({
        companyId,
        goal: "State gate",
        status: "active",
        leadAgentId: lead?.id ?? null,
    }).returning();

    const [task] = await db.insert(tasks).values({
        companyId,
        projectId: project.id,
        taskType: "work",
        state: "in_progress",
        assignedAgentId: owner.id,
        inputJson: { title: "Work someone else wants to close" },
    }).returning();

    const audit = async () => db.select().from(auditLog).where(and(
        eq(auditLog.companyId, companyId),
        eq(auditLog.targetId, task.id),
    ));

    const events = async (type: "task_updated" | "task_reassigned") =>
        (await db.select().from(taskEvents).where(and(
            eq(taskEvents.taskId, task.id),
            eq(taskEvents.eventType, type),
        ))).at(-1);

    return {
        db, tasks, companyId, project, task, owner, intruder, audit, events,
        // A company-wide token belongs to no agent: it is the unbound case.
        companyToken: bearer(rawToken),
        ownerToken: bearer(await seedMcpToken(companyId, owner.id)),
        intruderToken: bearer(await seedMcpToken(companyId, intruder.id)),
    };
}

const rowOf = async (w: Awaited<ReturnType<typeof world>>) => {
    const [row] = await w.db.select().from(w.tasks).where(eq(w.tasks.id, w.task.id));
    return row;
};

maybe("c87002d6: a non-assignee cannot close someone else's task", async () => {
    const w = await world();
    const route = await taskRoute();

    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.intruderToken),
        params: { id: w.task.id },
        body: { state: "done" },
    });

    assert.equal(res.status, 403, `a non-assignee close must be refused, got ${res.status}: ${res.text}`);
    assert.match(String(res.json.error), /assigned agent|project lead/i);

    const row = await rowOf(w);
    assert.equal(row.state, "in_progress", "the refused close must not touch the task");
    assert.equal((await w.audit()).length, 0, "a refused close must not leave an audit entry");
});

maybe("c87002d6: the assignee closes, and the state event names the agent that did it", async () => {
    const w = await world();
    const route = await taskRoute();

    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.ownerToken),
        params: { id: w.task.id },
        body: { state: "done" },
    });
    assert.equal(res.status, 200, res.text);

    const row = await rowOf(w);
    assert.equal(row.state, "done");

    const entries = await w.audit();
    const closed = entries.find((e) => e.action === "task.state_changed");
    assert.ok(closed, "the close must be recorded in the audit trail");
    assert.equal(closed.actorType, "agent", "a signed event is attributable to an agent");
    assert.equal(closed.actorId, w.owner.id, "the agent that closed it, not system/null");
    assert.deepEqual((closed.payloadJson as { after?: { state?: string } }).after, { state: "done" });

    // GET /tasks/{id}/notes serves this row: it has to name the agent, not "system".
    const event = await w.events("task_updated");
    assert.ok(event, "the status change must appear on the task timeline");
    assert.equal(event.actorType, "agent");
    assert.equal(event.actorId, w.owner.id);
});

maybe("c87002d6: an unbound token is refused instead of being recorded as system", async () => {
    const w = await world();
    const route = await taskRoute();

    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.companyToken),
        params: { id: w.task.id },
        body: { state: "done" },
    });

    assert.equal(res.status, 403, "an unsigned status change has nobody to attribute it to");
    // The refusal names the credential, so the operator can revoke it.
    assert.match(String(res.json.error), /not bound to an agent/i);

    const row = await rowOf(w);
    assert.equal(row.state, "in_progress");
    assert.equal((await w.audit()).length, 0);
});

maybe("a company-wide token cannot re-send the assignee a task already holds", async () => {
    const w = await world();
    const route = await taskRoute();

    // The value is the one already in the row, so no column would change — and a
    // token that cannot name its agent still may not ask for it: the write used
    // to answer 200 by skipping the gate whenever the assignee matched.
    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.companyToken),
        params: { id: w.task.id },
        body: { assignedAgentId: w.owner.id },
    });

    assert.equal(res.status, 403, `an unbound assignee write must be refused, got ${res.status}: ${res.text}`);
    const row = await rowOf(w);
    assert.equal(row.assignedAgentId, w.owner.id, "the refused write must leave the assignee alone");
    assert.equal((await w.audit()).length, 0, "a refused write must leave no audit entry");
});

maybe("a shared token cannot sign a status change by naming an agent", async () => {
    const w = await world();
    const route = await taskRoute();

    // A company-wide token belongs to nobody: letting it name the agent would be
    // the token signing itself, which is what case c87002d6 did at 15:47:06.
    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}?agentId=${w.owner.id}`, {
        method: "PATCH",
        headers: auth(w.companyToken),
        params: { id: w.task.id },
        body: { state: "done" },
    });
    assert.equal(res.status, 403, res.text);
    assert.match(String(res.json.error), /not bound to an agent/i);

    const row = await rowOf(w);
    assert.equal(row.state, "in_progress");
    assert.equal((await w.audit()).length, 0);
});

maybe("c87002d6: a non-assignee cannot reassign the task away", async () => {
    const w = await world();
    const route = await taskRoute();

    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.intruderToken),
        params: { id: w.task.id },
        body: { assignedAgentId: w.intruder.id },
    });

    assert.equal(res.status, 403, `stealing a task must be refused, got ${res.status}: ${res.text}`);
    assert.match(String(res.json.error), /reassign/i);

    const row = await rowOf(w);
    assert.equal(row.assignedAgentId, w.owner.id, "the owner must not be overwritten");
    assert.equal((await w.audit()).length, 0);
});

maybe("the assignee may hand the task to another agent", async () => {
    const w = await world();
    const route = await taskRoute();

    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.ownerToken),
        params: { id: w.task.id },
        body: { assignedAgentId: w.intruder.id },
    });
    assert.equal(res.status, 200, res.text);

    const row = await rowOf(w);
    assert.equal(row.assignedAgentId, w.intruder.id);
    assert.equal(row.leaseOwner, null, "the handoff drops the old lease");

    const assigned = (await w.audit()).find((e) => e.action === "task.assigned");
    assert.ok(assigned);
    assert.equal(assigned.actorId, w.owner.id, "the handoff is signed by the agent that made it");

    const event = await w.events("task_reassigned");
    assert.ok(event, "the handoff must appear on the task timeline");
    assert.equal(event.actorId, w.owner.id, "task_reassigned carries the agent that reassigned it");
});

maybe("the project lead can still close a task assigned to someone else", async () => {
    const w = await world({ projectLead: "intruder" });
    const route = await taskRoute();

    const res = await call(route.PATCH, `/api/mcp/tasks/${w.task.id}`, {
        method: "PATCH",
        headers: auth(w.intruderToken),
        params: { id: w.task.id },
        body: { state: "done" },
    });
    assert.equal(res.status, 200, res.text);

    const closed = (await w.audit()).find((e) => e.action === "task.state_changed");
    assert.ok(closed);
    assert.equal(closed.actorId, w.intruder.id);
});
