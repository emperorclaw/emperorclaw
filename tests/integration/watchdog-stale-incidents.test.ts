import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

async function seedTask(companyId: string, overrides: Record<string, unknown> = {}) {
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "work", ...overrides }).returning();
    return task;
}

async function seedIncident(companyId: string, task: { id: string; projectId: string }, overrides: Record<string, unknown> = {}) {
    const db = await getDb();
    const { incidents } = await getSchema();
    const [incident] = await db.insert(incidents).values({
        companyId,
        projectId: task.projectId,
        taskId: task.id,
        severity: "low",
        reasonCode: "unclaimed_stale",
        summary: "test incident",
        ...overrides,
    }).returning();
    return incident;
}

maybe("resolveOwnStaleIncidents closes only its own, now-stale incidents (idempotent)", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const { resolveOwnStaleIncidents } = await import("@/lib/watchdog");
    const db = await getDb();
    const { incidents } = await getSchema();
    const { eq } = await import("drizzle-orm");

    // 1. SLA breach still in an SLA-tracked state → stays open.
    const slaActive = await seedTask(companyId, { state: "in_progress" });
    const slaActiveIncident = await seedIncident(companyId, slaActive, { reasonCode: "sla_breach" });

    // 2. SLA breach whose task finished → resolved.
    const slaDone = await seedTask(companyId, { state: "done" });
    const slaDoneIncident = await seedIncident(companyId, slaDone, { reasonCode: "sla_breach" });

    // 3. SLA "extended" (still working, due in the future) → still open; only state matters.
    const slaExtended = await seedTask(companyId, { state: "in_progress", slaDueAt: new Date(Date.now() + 3600_000) });
    const slaExtendedIncident = await seedIncident(companyId, slaExtended, { reasonCode: "sla_breach" });

    // 4. Unclaimed stale whose task was claimed → resolved.
    const claimed = await seedTask(companyId, { state: "in_progress" });
    const claimedIncident = await seedIncident(companyId, claimed, { reasonCode: "unclaimed_stale" });

    // 5. Unclaimed stale still in the inbox → stays open.
    const inbox = await seedTask(companyId, { state: "inbox" });
    const inboxIncident = await seedIncident(companyId, inbox, { reasonCode: "unclaimed_stale" });

    // 6. Deleted task → resolved for both reason codes.
    const deletedTask = await seedTask(companyId, { state: "inbox", deletedAt: new Date() });
    const deletedIncident = await seedIncident(companyId, deletedTask, { reasonCode: "unclaimed_stale" });

    // 7. A different reason code (agent-reported) → untouched.
    const otherTask = await seedTask(companyId, { state: "done" });
    const otherIncident = await seedIncident(companyId, otherTask, { reasonCode: "tool_failure" });

    await resolveOwnStaleIncidents();

    const status = async (id: string) => (await db.select().from(incidents).where(eq(incidents.id, id)))[0].status;
    assert.equal(await status(slaActiveIncident.id), "open");
    assert.equal(await status(slaDoneIncident.id), "resolved");
    assert.equal(await status(slaExtendedIncident.id), "open");
    assert.equal(await status(claimedIncident.id), "resolved");
    assert.equal(await status(inboxIncident.id), "open");
    assert.equal(await status(deletedIncident.id), "resolved");
    assert.equal(await status(otherIncident.id), "open");

    // Idempotent: a second pass changes nothing.
    const snapshot = async () => db.select({ id: incidents.id, status: incidents.status, resolvedAt: incidents.resolvedAt }).from(incidents).orderBy(incidents.id);
    const before = await snapshot();
    await resolveOwnStaleIncidents();
    const after = await snapshot();
    assert.deepEqual(after, before);
});
