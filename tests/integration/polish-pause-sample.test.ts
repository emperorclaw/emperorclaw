/**
 * The 0.13 polish pass, through the real route handlers and a real DB:
 *   - POST /api/agents/pause-all: owners/admins only, every agent of the
 *     company (never another company's, never a deleted one), one activity
 *     entry per agent that changed, and the member-scope filter.
 *   - /api/onboarding/sample-client: create once for an empty workspace,
 *     and DELETE removes exactly the tagged rows.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function company(name = "Polish Co") {
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [row] = await db.insert(companies).values({ name, createdByUserId: creator.id }).returning();
    return row.id;
}

async function statuses(ids: string[]) {
    const db = await getDb();
    const { agents } = await getSchema();
    const { inArray } = await import("drizzle-orm");
    const rows = await db.select({ id: agents.id, budgetStatus: agents.budgetStatus }).from(agents).where(inArray(agents.id, ids));
    return new Map(rows.map((row) => [row.id, row.budgetStatus]));
}

async function auditFor(companyId: string) {
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    return db.select({ action: auditLog.action, targetId: auditLog.targetId, actorType: auditLog.actorType, actorId: auditLog.actorId }).from(auditLog).where(eq(auditLog.companyId, companyId));
}

const pauseAll = async (body: unknown) => call((await import("@/app/api/agents/pause-all/route")).POST as never, "/api/agents/pause-all", { method: "POST", body });

maybe("pause-all: an owner pauses every agent of the company, one audit entry each", async () => {
    await resetDb();
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const a = await seedAgent(mine, { name: "Atlas" });
    const b = await seedAgent(mine, { name: "Bea", budgetStatus: "warning" });
    const already = await seedAgent(mine, { name: "Cal", budgetStatus: "paused" });
    const gone = await seedAgent(mine, { name: "Gone", deletedAt: new Date() });
    const other = await seedAgent(theirs, { name: "Other" });
    const owner = await seedHuman(mine, "owner");
    actAs(owner);

    const res = await pauseAll({ paused: true });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual([...(res.json.changed as string[])].sort(), [a.id, b.id].sort());
    assert.deepEqual(res.json.unchanged, [already.id]);

    const after = await statuses([a.id, b.id, already.id, gone.id, other.id]);
    assert.equal(after.get(a.id), "paused");
    assert.equal(after.get(b.id), "paused");
    assert.equal(after.get(already.id), "paused");
    assert.equal(after.get(gone.id), "active", "a deleted agent was touched");
    assert.equal(after.get(other.id), "active", "another company's agent was paused");

    const audit = await auditFor(mine);
    const paused = audit.filter((row) => row.action === "agent.paused");
    assert.deepEqual(paused.map((row) => row.targetId).sort(), [a.id, b.id].sort(), "one agent.paused entry per changed agent");
    for (const row of paused) {
        assert.equal(row.actorType, "human");
        assert.equal(row.actorId, owner.userId);
    }
    assert.equal((await auditFor(theirs)).length, 0);

    // Resume lifts every pause, again one entry per agent.
    const resume = await pauseAll({ paused: false });
    assert.equal(resume.status, 200, resume.text);
    assert.deepEqual([...(resume.json.changed as string[])].sort(), [a.id, b.id, already.id].sort());
    const resumed = await statuses([a.id, b.id, already.id, other.id]);
    for (const id of [a.id, b.id, already.id]) assert.equal(resumed.get(id), "active");
    assert.equal((await auditFor(mine)).filter((row) => row.action === "agent.resumed").length, 3);
});

maybe("pause-all: an admin may; members and viewers are refused and nothing changes", async () => {
    await resetDb();
    const companyId = await company();
    const agent = await seedAgent(companyId);

    for (const role of ["member", "viewer"] as const) {
        actAs(await seedHuman(companyId, role));
        const res = await pauseAll({ paused: true });
        assert.equal(res.status, 403, `${role}: ${res.text}`);
    }
    assert.equal((await statuses([agent.id])).get(agent.id), "active");
    assert.equal((await auditFor(companyId)).length, 0);

    actAs(await seedHuman(companyId, "admin"));
    const ok = await pauseAll({ paused: true });
    assert.equal(ok.status, 200, ok.text);
    assert.equal((await statuses([agent.id])).get(agent.id), "paused");
});

maybe("pause-all: bad bodies are rejected; signed out is refused", async () => {
    await resetDb();
    const companyId = await company();
    await seedAgent(companyId);
    actAs(await seedHuman(companyId, "owner"));
    for (const body of [null, {}, { paused: "yes" }, { paused: 1 }]) {
        assert.equal((await pauseAll(body)).status, 400, JSON.stringify(body));
    }
    actAs(null);
    assert.equal((await pauseAll({ paused: true })).status, 401);
});

maybe("pause-all: a member scope limits which agents change", async () => {
    // Owners/admins are never scoped (so the route never sees one); the helper
    // still honours a scope so it can never reach past one.
    await resetDb();
    const companyId = await company();
    const inScope = await seedAgent(companyId, { name: "In" });
    const outScope = await seedAgent(companyId, { name: "Out" });
    const { setAllAgentsPaused } = await import("@/lib/pause-all");
    const result = await setAllAgentsPaused({ companyId, userId: null, scope: { mode: "restricted", agentIds: [inScope.id], customerIds: [] } }, true);
    assert.deepEqual(result.changed, [inScope.id]);
    const after = await statuses([inScope.id, outScope.id]);
    assert.equal(after.get(inScope.id), "paused");
    assert.equal(after.get(outScope.id), "active");
});

// ─── Sample client ──────────────────────────────────────────────────────────

const sampleRoute = async () => import("@/app/api/onboarding/sample-client/route");
const createSample = async () => call((await sampleRoute()).POST as never, "/api/onboarding/sample-client", { method: "POST" });
const removeSample = async () => call((await sampleRoute()).DELETE as never, "/api/onboarding/sample-client", { method: "DELETE" });
const sampleStatus = async () => call((await sampleRoute()).GET as never, "/api/onboarding/sample-client");

async function counts(companyId: string) {
    const db = await getDb();
    const { customers, projects, tasks, scopedResources } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [c, p, t, n] = await Promise.all([
        db.select({ id: customers.id, name: customers.name }).from(customers).where(eq(customers.companyId, companyId)),
        db.select({ id: projects.id, kpi: projects.kpiTargetsJson, customerId: projects.customerId }).from(projects).where(eq(projects.companyId, companyId)),
        db.select({ id: tasks.id, state: tasks.state, input: tasks.inputJson, projectId: tasks.projectId }).from(tasks).where(eq(tasks.companyId, companyId)),
        db.select({ id: scopedResources.id, scopeType: scopedResources.scopeType, scopeId: scopedResources.scopeId, inject: scopedResources.inject }).from(scopedResources).where(eq(scopedResources.companyId, companyId)),
    ]);
    return { customers: c, projects: p, tasks: t, notes: n };
}

maybe("sample client: an owner of an empty workspace gets one labelled, tagged sample, once", async () => {
    await resetDb();
    const companyId = await company();
    actAs(await seedHuman(companyId, "owner"));

    assert.deepEqual((await sampleStatus()).json, { hasSample: false, canOffer: true });
    const res = await createSample();
    assert.equal(res.status, 201, res.text);

    const rows = await counts(companyId);
    assert.equal(rows.customers.length, 1);
    assert.equal(rows.customers[0].name, "Sample: Harbor Dental");
    assert.equal(rows.projects.length, 1);
    const { SAMPLE_TAG, sampleManifest } = await import("@/lib/sample-client");
    const manifest = sampleManifest(rows.projects[0].kpi);
    assert.ok(manifest, "the project carries the sample manifest");
    assert.equal(manifest.customerId, rows.customers[0].id);
    assert.equal(rows.tasks.length, 3);
    assert.equal(new Set(rows.tasks.map((t) => t.state)).size, 3);
    for (const task of rows.tasks) assert.equal((task.input as { sample?: string }).sample, SAMPLE_TAG);
    assert.equal(rows.notes.length, 1);
    assert.equal(manifest.noteId, rows.notes[0].id);
    assert.equal(rows.notes[0].scopeType, "customer");
    assert.equal(rows.notes[0].scopeId, rows.customers[0].id);
    assert.equal(rows.notes[0].inject, "on_request", "sample text must not enter agent context by itself");

    assert.deepEqual((await sampleStatus()).json, { hasSample: true, canOffer: false });
    const again = await createSample();
    assert.equal(again.status, 409, again.text);
    assert.equal((await counts(companyId)).customers.length, 1);
});

maybe("sample client: refused for members, and for a workspace that already has customers", async () => {
    await resetDb();
    const companyId = await company();
    actAs(await seedHuman(companyId, "member"));
    assert.equal((await createSample()).status, 403);
    assert.equal((await removeSample()).status, 403);
    assert.equal((await sampleStatus()).json.canOffer, false);

    const db = await getDb();
    const { customers } = await getSchema();
    await db.insert(customers).values({ companyId, name: "Real Client" });
    actAs(await seedHuman(companyId, "owner"));
    const res = await createSample();
    assert.equal(res.status, 409, res.text);
    assert.equal((await counts(companyId)).customers.length, 1);
});

maybe("sample client: removal deletes only the tagged rows and keeps what people added", async () => {
    await resetDb();
    const companyId = await company();
    const otherCompany = await company("Other");
    actAs(await seedHuman(companyId, "owner"));
    assert.equal((await createSample()).status, 201);

    const db = await getDb();
    const { customers, projects, tasks } = await getSchema();
    const before = await counts(companyId);
    const sampleProject = before.projects[0];
    // People keep working: a real task inside the sample project, and a real client.
    const [userTask] = await db.insert(tasks).values({ companyId, projectId: sampleProject.id, taskType: "work", state: "inbox", inputJson: { title: "Real task in the sample project" } }).returning();
    const [realCustomer] = await db.insert(customers).values({ companyId, name: "Real Client" }).returning();
    const [realProject] = await db.insert(projects).values({ companyId, customerId: realCustomer.id, goal: "Real work", status: "active" }).returning();
    const [realTask] = await db.insert(tasks).values({ companyId, projectId: realProject.id, taskType: "work", state: "inbox", inputJson: { title: "Real", sample: "something-else" } }).returning();
    // A look-alike in another company must never be touched.
    const [foreignCustomer] = await db.insert(customers).values({ companyId: otherCompany, name: "Sample: Harbor Dental" }).returning();

    const res = await removeSample();
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.removed, { customers: 0, projects: 0, tasks: 3, notes: 1, keptProjects: 1, keptCustomers: 1 });

    const after = await counts(companyId);
    assert.deepEqual(after.tasks.map((t) => t.id).sort(), [userTask.id, realTask.id].sort(), "only the three sample tasks were deleted");
    assert.deepEqual(after.projects.map((p) => p.id).sort(), [sampleProject.id, realProject.id].sort());
    assert.equal(after.projects.find((p) => p.id === sampleProject.id)?.kpi, null, "the kept project is no longer tagged as sample");
    assert.equal(after.customers.length, 2, "the sample customer still holds the kept project");
    assert.equal(after.notes.length, 0);
    assert.equal((await counts(otherCompany)).customers[0]?.id, foreignCustomer.id);

    // Nothing tagged is left, so a second removal is a no-op.
    const again = await removeSample();
    assert.deepEqual(again.json.removed, { customers: 0, projects: 0, tasks: 0, notes: 0, keptProjects: 0, keptCustomers: 0 });
});

maybe("sample client: untouched, removal clears every sample row and records it", async () => {
    await resetDb();
    const companyId = await company();
    actAs(await seedHuman(companyId, "admin"));
    assert.equal((await createSample()).status, 201);
    const created = await counts(companyId);

    const res = await removeSample();
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.removed, { customers: 1, projects: 1, tasks: 3, notes: 1, keptProjects: 0, keptCustomers: 0 });
    const after = await counts(companyId);
    assert.equal(after.customers.length + after.projects.length + after.tasks.length + after.notes.length, 0);

    const audit = await auditFor(companyId);
    assert.ok(audit.some((row) => row.action === "customer.created" && row.targetId === created.customers[0].id));
    assert.ok(audit.some((row) => row.action === "customer.deleted" && row.targetId === created.customers[0].id));
    assert.deepEqual((await sampleStatus()).json, { hasSample: false, canOffer: true });
});
