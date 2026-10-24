import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

/**
 * The company Timeline read side + route: a Gantt built from the run ledger,
 * task events, approvals and artifacts. A restricted member only sees work
 * inside their scope, including the agents named by events, approvals,
 * artifacts and handoffs; a run in another person's private direct thread never
 * appears (not even as a bar), while the viewer's own does, and neither do the
 * markers of a task whose only run lives there; deleted tasks and projects
 * never appear; people are shown by name, never by email; cross-company data
 * never leaks; malformed or over-wide queries are rejected by the route.
 */
const maybe = dbAvailable ? test : test.skip;

const MIN = 60_000;
const DAY = 24 * 60 * MIN;

async function seedTimeline() {
    await resetDb();
    const db = await getDb();
    const s = await getSchema();
    const { eq } = await import("drizzle-orm");
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms);

    const { companyId, userId: ownerId } = await seedCompanyWithToken();
    await db.update(s.companies).set({ directChatMode: "private" }).where(eq(s.companies.id, companyId));

    const atlas = await seedAgent(companyId, { name: "Atlas" });
    const nova = await seedAgent(companyId, { name: "Nova" });

    await db.insert(s.companyMembers).values({ companyId, userId: ownerId, role: "owner" });

    const [harbor, other] = await db.insert(s.customers).values([
        { companyId, name: "Harbor Dental" },
        { companyId, name: "Other Co" },
    ]).returning();
    const [project] = await db.insert(s.projects).values({ companyId, customerId: harbor.id, goal: "In scope", status: "active" }).returning();
    const [otherProject] = await db.insert(s.projects).values({ companyId, customerId: other.id, goal: "Out of scope", status: "active" }).returning();

    const [scopedUser] = await db.insert(s.users).values({ email: `scoped-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Sam Scoped" }).returning();
    await db.insert(s.companyMembers).values({ companyId, userId: scopedUser.id, role: "member", scopeJson: { mode: "restricted", agentIds: [atlas.id], customerIds: [harbor.id] } });

    const [taskIn] = await db.insert(s.tasks).values({ companyId, projectId: project.id, taskType: "work", assignedAgentId: atlas.id, inputJson: { title: "In-scope task" } }).returning();
    const [taskOut] = await db.insert(s.tasks).values({ companyId, projectId: otherProject.id, taskType: "work", assignedAgentId: atlas.id, inputJson: { title: "Out-of-scope task" } }).returning();

    const run = async (values: Record<string, unknown>) => {
        const [row] = await db.insert(s.agentRuns).values({
            id: randomUUID(), companyId, agentId: atlas.id, runtimeKind: "hermes", triggerKind: "task", ...values,
        } as typeof s.agentRuns.$inferInsert).returning();
        return row;
    };
    const atlasInRun = await run({ taskId: taskIn.id, status: "succeeded", startedAt: ago(5 * MIN), endedAt: ago(3 * MIN), inputTokens: 100, outputTokens: 50, costCents: 10, toolCalls: 2 });
    const atlasOutRun = await run({ taskId: taskOut.id, status: "succeeded", startedAt: ago(6 * MIN), endedAt: ago(4 * MIN) });
    const [novaRun] = await db.insert(s.agentRuns).values({
        id: randomUUID(), companyId, agentId: nova.id, taskId: taskIn.id, triggerKind: "task", status: "succeeded", startedAt: ago(7 * MIN), endedAt: ago(6 * MIN),
    }).returning();

    // Private direct threads: one per person, with the same agent.
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const ownerThread = await ensureDirectThread(companyId, atlas.id, ownerId);
    const [otherUser] = await db.insert(s.users).values({ email: `other-${randomUUID()}@example.com`, passwordHash: "x", displayName: "Other Person" }).returning();
    await db.insert(s.companyMembers).values({ companyId, userId: otherUser.id, role: "member" });
    const otherThread = await ensureDirectThread(companyId, atlas.id, otherUser.id);

    // A chat run (no task) in each private thread, plus a task run in the other person's private thread.
    const [ownerChatRun] = await db.insert(s.agentRuns).values({
        id: randomUUID(), companyId, agentId: atlas.id, threadId: ownerThread.id, triggerKind: "message", taskId: null, status: "succeeded", startedAt: ago(2 * MIN), endedAt: ago(1 * MIN),
    }).returning();
    const [otherChatRun] = await db.insert(s.agentRuns).values({
        id: randomUUID(), companyId, agentId: atlas.id, threadId: otherThread.id, triggerKind: "message", taskId: null, status: "succeeded", startedAt: ago(3 * MIN), endedAt: ago(2 * MIN),
    }).returning();
    const [otherPrivateTaskRun] = await db.insert(s.agentRuns).values({
        id: randomUUID(), companyId, agentId: atlas.id, threadId: otherThread.id, taskId: taskIn.id, triggerKind: "task", status: "succeeded", startedAt: ago(8 * MIN), endedAt: ago(7 * MIN),
    }).returning();

    const { loadTaskViewer } = await import("@/lib/task-story-reads");

    return {
        companyId, now, atlas, nova, taskIn, taskOut, project, ownerId, otherUserId: otherUser.id, otherThread,
        owner: await loadTaskViewer(companyId, ownerId),
        scoped: await loadTaskViewer(companyId, scopedUser.id),
        other: await loadTaskViewer(companyId, otherUser.id),
        atlasInRun, atlasOutRun, novaRun, ownerChatRun, otherChatRun, otherPrivateTaskRun,
    };
}

function window(now: number, days = 7) {
    return { fromMs: now - days * DAY, toMs: now, nowMs: now };
}

maybe("a restricted member sees only work inside their scope", async () => {
    const t = await seedTimeline();
    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const tl = await loadWorkTimeline(t.companyId, t.scoped, window(t.now));
    const ids = new Set(tl.spans.map((s) => s.id));
    assert.ok(ids.has(t.atlasInRun.id), "the in-scope task's run is visible");
    assert.ok(!ids.has(t.atlasOutRun.id), "the out-of-scope customer's run is hidden");
    assert.ok(!ids.has(t.novaRun.id), "an agent outside the member's agent scope is hidden");
    assert.ok(!ids.has(t.ownerChatRun.id), "a chat run in someone else's private thread is hidden");
    assert.ok(!ids.has(t.otherPrivateTaskRun.id), "a task run in someone else's private thread never appears");
    assert.deepEqual(tl.actors.map((a) => a.name).filter((n) => n === "Atlas" || n === "Nova"), ["Atlas"]);
});

maybe("the owner sees their own private chat, never another person's", async () => {
    const t = await seedTimeline();
    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const tl = await loadWorkTimeline(t.companyId, t.owner, window(t.now));
    const ids = new Set(tl.spans.map((s) => s.id));
    const chatRun = tl.spans.find((s) => s.id === t.ownerChatRun.id);
    assert.ok(chatRun, "the owner's own private chat run appears");
    assert.equal(chatRun.kind, "chat");
    assert.ok(chatRun.href, "the chat bar deep-links to the thread");
    assert.ok(!ids.has(t.otherChatRun.id), "another person's private chat run never appears");
    assert.ok(!ids.has(t.otherPrivateTaskRun.id), "another person's private-thread task run never appears");
    assert.ok(ids.has(t.atlasInRun.id) && ids.has(t.atlasOutRun.id) && ids.has(t.novaRun.id));
});

maybe("cross-company data never leaks", async () => {
    const t = await seedTimeline();
    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    // A second company with no runs of its own.
    const other = await seedCompanyWithToken();
    const db = await getDb();
    const s = await getSchema();
    await db.insert(s.companyMembers).values({ companyId: other.companyId, userId: other.userId, role: "owner" });
    const { loadTaskViewer } = await import("@/lib/task-story-reads");
    const foreign = await loadWorkTimeline(other.companyId, await loadTaskViewer(other.companyId, other.userId), window(t.now));
    assert.equal(foreign.spans.length, 0, "the first company's runs are not visible in the second");
    assert.equal(foreign.actors.length, 0);
    // And the first company's view is unaffected.
    const mine = await loadWorkTimeline(t.companyId, t.owner, window(t.now));
    assert.ok(mine.spans.length > 0);
});

maybe("the route rejects a window wider than 31 days", async () => {
    const t = await seedTimeline();
    await actAs(await seedHuman(t.companyId, "owner"));
    try {
        const route = await import("@/app/api/timeline/route");
        const over = await call(route.GET as never, `/api/timeline?from=${t.now - 32 * DAY}&to=${t.now}`);
        assert.equal(over.status, 400);
        const fine = await call(route.GET as never, `/api/timeline?from=${t.now - 7 * DAY}&to=${t.now}`);
        assert.equal(fine.status, 200);
        const body = fine.json as { spans?: unknown[]; actors?: unknown[] };
        assert.ok(Array.isArray(body.spans) && body.spans.length > 0);
    } finally {
        await actAs(null);
    }
});

/** Task-level markers on `taskId` by `agentId`: a note (and an assignment), an approval it requested, and a file it wrote. */
async function seedMarkers(companyId: string, projectId: string, taskId: string, agentId: string, at: Date, assignee?: { type: "agent" | "human"; id: string }) {
    const db = await getDb();
    const s = await getSchema();
    await db.insert(s.taskEvents).values([
        { companyId, taskId, eventType: "task_note", actorType: "agent", actorId: agentId, payloadJson: { note: "progress" }, createdAt: at },
        ...(assignee ? [{ companyId, taskId, eventType: "task_assigned", actorType: "agent", actorId: agentId, payloadJson: { assignee }, createdAt: at }] : []),
    ]);
    const [approval] = await db.insert(s.approvals).values({ companyId, projectId, requesterAgentId: agentId, requestedAt: at }).returning();
    await db.insert(s.approvalTaskLinks).values({ companyId, approvalId: approval.id, taskId });
    await db.insert(s.artifacts).values({ companyId, projectId, taskId, agentId, kind: "file", contentType: "text/plain", title: "out.txt", sha256: "x", sizeBytes: 12, createdByType: "agent", createdById: agentId, createdAt: at });
}

maybe("an out-of-scope agent's notes, approvals, files and handoffs never reach a restricted member", async () => {
    const t = await seedTimeline();
    const db = await getDb();
    const s = await getSchema();
    const at = new Date(t.now - 4 * MIN);
    // Nova (outside the member's agent scope) acts on the in-scope task and hands it to Atlas...
    await seedMarkers(t.companyId, t.project.id, t.taskIn.id, t.nova.id, at, { type: "agent", id: t.atlas.id });
    // ...and Atlas (in scope) hands it back to Nova.
    await db.insert(s.taskEvents).values({ companyId: t.companyId, taskId: t.taskIn.id, eventType: "task_assigned", actorType: "agent", actorId: t.atlas.id, payloadJson: { assignee: { type: "agent", id: t.nova.id } }, createdAt: at });

    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const tl = await loadWorkTimeline(t.companyId, t.scoped, window(t.now));
    assert.ok(!JSON.stringify(tl).includes(t.nova.id), "the hidden agent's id appears nowhere in the response");
    const actorIds = new Set(tl.actors.map((a) => a.id));
    assert.ok(tl.events.every((e) => actorIds.has(e.actorId)), "every marker belongs to a visible row");
    assert.equal(tl.edges.length, 0, "no handoff touches the hidden agent");
    assert.ok(tl.events.some((e) => e.actorId === `agent:${t.atlas.id}` && e.kind === "assigned"), "the in-scope agent's own marker stays");

    // The owner (unrestricted) still sees Nova's markers and both handoffs.
    const full = await loadWorkTimeline(t.companyId, t.owner, window(t.now));
    assert.ok(full.events.some((e) => e.actorId === `agent:${t.nova.id}` && e.kind === "note"));
    assert.equal(full.edges.length, 2);
});

maybe("deleted tasks and projects never appear", async () => {
    const t = await seedTimeline();
    const db = await getDb();
    const s = await getSchema();
    const at = new Date(t.now - 4 * MIN);
    const [deletedTask] = await db.insert(s.tasks).values({ companyId: t.companyId, projectId: t.project.id, taskType: "work", inputJson: { title: "Removed task" }, deletedAt: new Date() }).returning();
    const [deletedProject] = await db.insert(s.projects).values({ companyId: t.companyId, goal: "Removed project", status: "active", deletedAt: new Date() }).returning();
    const [orphanTask] = await db.insert(s.tasks).values({ companyId: t.companyId, projectId: deletedProject.id, taskType: "work", inputJson: { title: "Task of a removed project" } }).returning();
    for (const task of [deletedTask, orphanTask]) {
        await db.insert(s.agentRuns).values({ id: randomUUID(), companyId: t.companyId, agentId: t.atlas.id, taskId: task.id, triggerKind: "task", status: "succeeded", startedAt: new Date(t.now - 5 * MIN), endedAt: at });
        await seedMarkers(t.companyId, task.projectId, task.id, t.atlas.id, at);
    }

    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const tl = await loadWorkTimeline(t.companyId, t.owner, window(t.now));
    const json = JSON.stringify(tl);
    assert.ok(!json.includes(deletedTask.id), "a deleted task's runs and markers are gone");
    assert.ok(!json.includes(orphanTask.id), "a deleted project's tasks are gone");
    assert.ok(!json.includes("Removed"), "no deleted title leaks");
    assert.equal(tl.totals.runs, tl.spans.length);
});

maybe("people are shown by name, never by email", async () => {
    const t = await seedTimeline();
    const db = await getDb();
    const s = await getSchema();
    // The owner (no display name) and the other person (named) both act on the task.
    await db.insert(s.taskEvents).values([
        { companyId: t.companyId, taskId: t.taskIn.id, eventType: "task_note", actorType: "human", actorId: t.ownerId, createdAt: new Date(t.now - 4 * MIN) },
        { companyId: t.companyId, taskId: t.taskIn.id, eventType: "task_note", actorType: "human", actorId: t.otherUserId, createdAt: new Date(t.now - 4 * MIN) },
    ]);
    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const tl = await loadWorkTimeline(t.companyId, t.owner, window(t.now));
    assert.ok(!JSON.stringify(tl).includes("@example.com"), "no email address in the response");
    const humans = tl.actors.filter((a) => a.kind === "human").map((a) => a.name).sort();
    assert.deepEqual(humans, ["Other Person", "Teammate"]);
});

maybe("a task whose only run is in another person's private thread leaves no markers", async () => {
    const t = await seedTimeline();
    const db = await getDb();
    const s = await getSchema();
    const at = new Date(t.now - 4 * MIN);
    const [privateTask] = await db.insert(s.tasks).values({ companyId: t.companyId, projectId: t.project.id, taskType: "work", assignedAgentId: t.atlas.id, inputJson: { title: "Private ask" } }).returning();
    await db.insert(s.agentRuns).values({ id: randomUUID(), companyId: t.companyId, agentId: t.atlas.id, threadId: t.otherThread.id, taskId: privateTask.id, triggerKind: "task", status: "succeeded", startedAt: new Date(t.now - 5 * MIN), endedAt: at });
    await seedMarkers(t.companyId, t.project.id, privateTask.id, t.atlas.id, at, { type: "human", id: t.otherUserId });

    const { loadWorkTimeline } = await import("@/lib/work-timeline-reads");
    const { loadTaskViewer } = await import("@/lib/task-story-reads");
    const tl = await loadWorkTimeline(t.companyId, t.owner, window(t.now));
    assert.ok(!JSON.stringify(tl).includes(privateTask.id), "no bar, marker or edge for the private task");

    // The person who owns that thread still sees it.
    const mine = await loadWorkTimeline(t.companyId, await loadTaskViewer(t.companyId, t.otherUserId), window(t.now));
    assert.ok(mine.spans.some((sp) => sp.taskId === privateTask.id));
    assert.ok(mine.events.some((e) => e.taskId === privateTask.id && e.kind === "note"));
});

maybe("the route rejects malformed filters and out-of-range dates", async () => {
    const t = await seedTimeline();
    await actAs(await seedHuman(t.companyId, "owner"));
    try {
        const route = await import("@/app/api/timeline/route");
        const base = `from=${t.now - DAY}&to=${t.now}`;
        for (const qs of [
            `${base}&projectId=not-a-uuid`,
            `${base}&customerId=${encodeURIComponent("x' OR 1=1")}`,
            `${base}&agentId=nope`,
            `from=0&to=${DAY}`,
            `from=${t.now + 400 * DAY}&to=${t.now + 401 * DAY}`,
            `from=abc&to=${t.now}`,
        ]) {
            const res = await call(route.GET as never, `/api/timeline?${qs}`);
            assert.equal(res.status, 400, qs);
        }
        const ok = await call(route.GET as never, `/api/timeline?${base}&projectId=${t.project.id}`);
        assert.equal(ok.status, 200);
    } finally {
        await actAs(null);
    }
});
