/**
 * Automations (0.27): Run now, who runs it, run origins, runs closing with
 * their task, run_automation over MCP, and Emperor's own scheduler (claim race,
 * catch-up, skip while running, no agent, paused, resume).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;
const agentHeaders = (token: string) => ({ ...bearer(token), "Idempotency-Key": randomUUID() });

/** Runs close off the request path (after the task_updated broadcast): wait for it. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean, timeoutMs = 3000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (ok(value) || Date.now() > deadline) return value;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

async function fixture(pipelineOverrides: Record<string, unknown> = {}) {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { pipelines } = await getSchema();
    const quill = await seedAgent(companyId, { name: "Quill" });
    const scout = await seedAgent(companyId, { name: "Scout" });
    const alex = await seedHuman(companyId, "member");
    const vic = await seedHuman(companyId, "viewer");
    const [pipeline] = await db.insert(pipelines).values({
        companyId,
        name: "Weekly leads digest",
        purpose: "Summarize last week's leads every Monday.",
        docMarkdown: "Reads the CRM, writes a digest.",
        trigger: "cron",
        triggerConfig: { cron: "0 9 * * 1", timezone: "Europe/Madrid" },
        stepsJson: [{ name: "Collect leads" }, { name: "Write digest" }],
        status: "active",
        ownerAgentId: quill.id,
        createdByType: "agent",
        createdById: quill.id,
        ...pipelineOverrides,
    }).returning();
    return { companyId, quill, scout, alex, vic, pipeline };
}

async function runRoute() {
    return (await import("@/app/api/pipelines/[id]/run/route")).POST;
}
async function patchRoute() {
    return (await import("@/app/api/pipelines/[id]/route")).PATCH;
}

async function runsOf(pipelineId: string) {
    const db = await getDb();
    const { pipelineRuns } = await getSchema();
    const { eq, asc } = await import("drizzle-orm");
    return db.select().from(pipelineRuns).where(eq(pipelineRuns.pipelineId, pipelineId)).orderBy(asc(pipelineRuns.startedAt), asc(pipelineRuns.createdAt));
}

async function pipelineRow(id: string) {
    const db = await getDb();
    const { pipelines } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
    return row;
}

async function taskRow(id: string) {
    const db = await getDb();
    const { tasks } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    return row;
}

// ─── Run now ────────────────────────────────────────────────────────────────

maybe("Run now creates a task for the runner and a running run with source manual, by the person", async () => {
    const { pipeline, alex, quill } = await fixture();
    actAs(alex);
    const POST = await runRoute();
    const res = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    assert.equal(res.status, 201, res.text);
    const taskId = res.json.taskId as string;
    const task = await taskRow(taskId);
    assert.equal(task.assignedAgentId, quill.id);
    assert.equal(task.state, "inbox");
    const input = task.inputJson as { title: string; description: string; pipelineRunId: string };
    assert.equal(input.title, "Run automation: Weekly leads digest");
    assert.match(input.description, /Summarize last week's leads/);
    assert.match(input.description, /Collect leads/);
    assert.match(input.description, new RegExp(`/api/mcp/pipelines/${pipeline.id}/runs`));

    const [run] = await runsOf(pipeline.id);
    assert.equal(run.status, "running");
    assert.equal(run.source, "manual");
    assert.equal(run.triggeredByType, "user");
    assert.equal(run.triggeredById, alex.userId);
    assert.equal(run.agentId, quill.id);
    assert.deepEqual((run.statsJson as { taskIds: string[] }).taskIds, [taskId]);
    assert.equal(input.pipelineRunId, run.id);
    assert.match(input.description, new RegExp(run.id));

    const after = await pipelineRow(pipeline.id);
    assert.equal(after.runCount, 1);
    assert.equal(after.lastRunStatus, "running");

    // The run is in the activity log as the person's action.
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const entries = await db.select().from(auditLog).where(eq(auditLog.targetId, pipeline.id));
    assert.ok(entries.some((e) => e.action === "pipeline.run_started" && e.actorId === alex.userId));
});

maybe("Run now: a paused or draft automation answers 409, a viewer 403, no agent 422", async () => {
    const { pipeline, alex, vic, companyId } = await fixture({ status: "paused" });
    const POST = await runRoute();
    actAs(alex);
    const paused = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    assert.equal(paused.status, 409);
    assert.equal(paused.json.code, "not_active");
    assert.match(String(paused.json.error), /paused/);

    actAs(vic);
    const viewer = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    assert.equal(viewer.status, 403);

    const db = await getDb();
    const { pipelines } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(pipelines).set({ status: "active", ownerAgentId: null }).where(eq(pipelines.id, pipeline.id));
    actAs(alex);
    const noAgent = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    assert.equal(noAgent.status, 422);
    assert.equal(noAgent.json.code, "no_agent");
    assert.equal((await runsOf(pipeline.id)).length, 0, "nothing recorded");
    void companyId;
});

maybe("Run now while a run is running: 409 with that run, then force starts another; a chosen agent runs it", async () => {
    const { pipeline, alex, scout } = await fixture();
    const POST = await runRoute();
    actAs(alex);
    const first = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    assert.equal(first.status, 201, first.text);
    const again = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    assert.equal(again.status, 409);
    assert.equal(again.json.code, "already_running");
    assert.equal((again.json.run as { id: string }).id, (first.json.run as { id: string }).id);

    const forced = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: { force: true, agentId: scout.id }, params: { id: pipeline.id } });
    assert.equal(forced.status, 201, forced.text);
    assert.equal(forced.json.agentId, scout.id);
    assert.equal((await taskRow(forced.json.taskId as string)).assignedAgentId, scout.id);
    assert.equal((await runsOf(pipeline.id)).length, 2);
});

maybe("Run now refuses a paused agent and an unknown one", async () => {
    const { pipeline, alex, companyId } = await fixture();
    const paused = await seedAgent(companyId, { name: "Sleepy", budgetStatus: "paused" });
    const POST = await runRoute();
    actAs(alex);
    const sleepy = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: { agentId: paused.id }, params: { id: pipeline.id } });
    assert.equal(sleepy.status, 422);
    assert.equal(sleepy.json.code, "agent_inactive");
    const unknown = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: { agentId: "Nobody" }, params: { id: pipeline.id } });
    assert.equal(unknown.status, 404);
});

// ─── Runs close ─────────────────────────────────────────────────────────────

maybe("the linked task finishing closes the run: done → succeeded with its last note, failed → failed", async () => {
    const { pipeline, alex, quill, companyId } = await fixture();
    const POST = await runRoute();
    actAs(alex);
    const started = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    const taskId = started.json.taskId as string;
    const { addTaskNote, finalizeTaskForAgent, claimNextTaskForAgent } = await import("@/lib/openclaw/tasks");
    await claimNextTaskForAgent({ companyId, agentId: quill.id });
    await addTaskNote({ companyId, taskId, note: "Digest sent: 14 new leads.", actorAgentId: quill.id });
    const done = await finalizeTaskForAgent({ companyId, taskId, agentId: quill.id, state: "done", comment: "done" });
    assert.equal(done.status, 200, JSON.stringify(done));
    const [run] = await eventually(() => runsOf(pipeline.id), (rows) => rows[0]?.status !== "running");
    assert.equal(run.status, "succeeded");
    assert.equal(run.summary, "Digest sent: 14 new leads.");
    assert.ok(run.endedAt);
    assert.equal((await eventually(() => pipelineRow(pipeline.id), (row) => row.lastRunStatus === "succeeded")).lastRunStatus, "succeeded");

    const second = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    const { updateTaskForCompany } = await import("@/lib/openclaw/tasks");
    const failed = await updateTaskForCompany({ companyId, taskId: second.json.taskId as string, state: "failed" });
    assert.equal(failed.status, 200);
    const runs = await eventually(() => runsOf(pipeline.id), (rows) => rows[1]?.status !== "running");
    assert.equal(runs[1].status, "failed");
});

maybe("the agent completes a Run now run by runId through the runs API; agent-reported runs carry source agent or schedule", async () => {
    const { pipeline, alex, quill, companyId } = await fixture();
    const POST = await runRoute();
    actAs(alex);
    const started = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    const runId = (started.json.run as { id: string }).id;
    const token = await seedMcpToken(companyId, quill.id);
    const runs = (await import("@/app/api/mcp/pipelines/[id]/runs/route")).POST;
    const complete = await call(runs, `/api/mcp/pipelines/${pipeline.id}/runs`, { method: "POST", headers: agentHeaders(token), body: { runId, status: "succeeded", summary: "All good" }, params: { id: pipeline.id } });
    assert.equal(complete.status, 200, complete.text);
    assert.equal((complete.json.run as { status: string }).status, "succeeded");

    const reported = await call(runs, `/api/mcp/pipelines/${pipeline.id}/runs`, { method: "POST", headers: agentHeaders(token), body: { status: "succeeded", summary: "own run" }, params: { id: pipeline.id } });
    assert.equal(reported.status, 201, reported.text);
    assert.equal((reported.json.run as { source: string }).source, "agent");
    assert.equal((reported.json.run as { triggeredById: string }).triggeredById, quill.id);
    const scheduled = await call(runs, `/api/mcp/pipelines/${pipeline.id}/runs`, { method: "POST", headers: agentHeaders(token), body: { status: "succeeded", source: "schedule" }, params: { id: pipeline.id } });
    assert.equal((scheduled.json.run as { source: string }).source, "schedule");
    const bad = await call(runs, `/api/mcp/pipelines/${pipeline.id}/runs`, { method: "POST", headers: agentHeaders(token), body: { status: "succeeded", source: "manual" }, params: { id: pipeline.id } });
    assert.equal(bad.status, 400);
});

// ─── Who runs it / who schedules it ─────────────────────────────────────────

maybe("PATCH ownerAgentId: an agent of the company or null; other companies' agents and paused agents are refused", async () => {
    const { pipeline, alex, scout, companyId } = await fixture();
    const PATCH = await patchRoute();
    actAs(alex);
    const set = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { ownerAgentId: scout.id }, params: { id: pipeline.id } });
    assert.equal(set.status, 200, set.text);
    assert.equal((set.json.pipeline as { ownerAgentId: string }).ownerAgentId, scout.id);

    const cleared = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { ownerAgentId: null }, params: { id: pipeline.id } });
    assert.equal((cleared.json.pipeline as { ownerAgentId: string | null }).ownerAgentId, null);

    const { companyId: otherCompany } = await seedCompanyWithToken();
    const stranger = await seedAgent(otherCompany, { name: "Stranger" });
    const foreign = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { ownerAgentId: stranger.id }, params: { id: pipeline.id } });
    assert.equal(foreign.status, 404);
    const paused = await seedAgent(companyId, { name: "Sleepy", budgetStatus: "paused" });
    const sleepy = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { ownerAgentId: paused.id }, params: { id: pipeline.id } });
    assert.equal(sleepy.status, 422);
    const badScheduler = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { scheduledBy: "cron" }, params: { id: pipeline.id } });
    assert.equal(badScheduler.status, 400);
    assert.equal((await pipelineRow(pipeline.id)).ownerAgentId, null);
});

maybe("switching to Emperor's schedule stores the next slot in the automation's timezone; pausing clears it", async () => {
    const { pipeline, alex } = await fixture();
    const PATCH = await patchRoute();
    actAs(alex);
    const res = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { scheduledBy: "emperor" }, params: { id: pipeline.id } });
    assert.equal(res.status, 200, res.text);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.scheduledBy, "emperor");
    assert.ok(row.nextRunAt && row.nextRunAt.getTime() > Date.now());
    // Monday 09:00 in Madrid is 07:00 or 08:00 UTC depending on DST.
    assert.equal(row.nextRunAt!.getUTCDay(), 1);
    assert.ok([7, 8].includes(row.nextRunAt!.getUTCHours()));
    await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { status: "paused" }, params: { id: pipeline.id } });
    assert.equal((await pipelineRow(pipeline.id)).nextRunAt, null);
});

// ─── MCP ────────────────────────────────────────────────────────────────────

maybe("MCP run_automation uses the same service; list_automations shows runner, schedule and next run", async () => {
    const { pipeline, quill, companyId } = await fixture();
    const operator = await mcpClientFor(companyId, null);
    const listed = await operator.tool("list_automations", {});
    assert.equal(listed.isError, false, listed.text);
    const [item] = JSON.parse(listed.text).automations;
    assert.equal(item.name, "Weekly leads digest");
    assert.deepEqual(item.runner, { id: quill.id, name: "Quill" });
    assert.equal(item.schedule.timezone, "Europe/Madrid");
    assert.equal(item.schedule.scheduledBy, "agent");
    assert.ok(item.nextRunAt);

    const started = await operator.tool("run_automation", { automationId: "Weekly leads digest" });
    assert.equal(started.isError, false, started.text);
    const body = JSON.parse(started.text);
    assert.equal(body.run.source, "api");
    assert.equal((await taskRow(body.taskId)).assignedAgentId, quill.id);

    const asAgent = await mcpClientFor(companyId, quill.id);
    const busy = await asAgent.tool("run_automation", { automationId: pipeline.id });
    assert.equal(busy.isError, true);
    assert.match(busy.text, /still running/);
    const forced = await asAgent.tool("run_automation", { automationId: pipeline.id, force: true });
    assert.equal(forced.isError, false, forced.text);
    assert.equal(JSON.parse(forced.text).run.triggeredById, quill.id);
});

// ─── Emperor's scheduler ────────────────────────────────────────────────────

async function emperorScheduled(overrides: Record<string, unknown> = {}) {
    const slot = new Date("2026-11-02T08:00:00Z"); // Monday 09:00 Madrid
    const f = await fixture({ scheduledBy: "emperor", nextRunAt: slot, ...overrides });
    return { ...f, slot };
}

maybe("scheduler: two concurrent ticks fire a due slot once", async () => {
    const { pipeline, slot } = await emperorScheduled();
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    const now = new Date(slot.getTime() + 20_000);
    const [a, b] = await Promise.all([runScheduledPipelines(now), runScheduledPipelines(now)]);
    const started = [...a, ...b].filter((o) => o.pipelineId === pipeline.id && o.outcome === "started");
    assert.equal(started.length, 1);
    const runs = await runsOf(pipeline.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].source, "schedule");
    assert.equal(runs[0].triggeredById, null);
    assert.equal((await pipelineRow(pipeline.id)).nextRunAt?.toISOString(), "2026-11-09T08:00:00.000Z");
});

maybe("scheduler: after downtime the missed slots fire once and the next slot is in the future", async () => {
    const { pipeline, slot } = await emperorScheduled();
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    const threeWeeksLater = new Date(slot.getTime() + 21 * 86_400_000 + 3_600_000);
    await runScheduledPipelines(threeWeeksLater);
    await runScheduledPipelines(new Date(threeWeeksLater.getTime() + 60_000));
    assert.equal((await runsOf(pipeline.id)).length, 1);
    const next = (await pipelineRow(pipeline.id)).nextRunAt!;
    assert.ok(next.getTime() > threeWeeksLater.getTime());
    assert.equal(next.toISOString(), "2026-11-30T08:00:00.000Z");
});

maybe("scheduler: a slot while the previous run is still running records a skipped run", async () => {
    const { pipeline, slot } = await emperorScheduled();
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    await runScheduledPipelines(new Date(slot.getTime() + 1000));
    await runScheduledPipelines(new Date(slot.getTime() + 7 * 86_400_000 + 1000));
    await runScheduledPipelines(new Date(slot.getTime() + 14 * 86_400_000 + 1000));
    await runScheduledPipelines(new Date(slot.getTime() + 21 * 86_400_000 + 1000));
    const runs = await runsOf(pipeline.id);
    assert.deepEqual(runs.map((r) => r.status), ["running", "skipped"], "repeated skips update one row");
    assert.equal(runs[1].summary, "Previous run still running");
    assert.equal((runs[1].statsJson as { repeat: number }).repeat, 3);
    assert.equal(runs[1].endedAt?.toISOString(), new Date(slot.getTime() + 21 * 86_400_000 + 1000).toISOString());
    assert.equal((await pipelineRow(pipeline.id)).lastRunStatus, "running", "a skipped slot leaves the running run as the last");
});

maybe("scheduler: no runner agent fails each slot in one row, then Emperor pauses it after 3 and says why", async () => {
    const { pipeline, slot } = await emperorScheduled({ ownerAgentId: null });
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    const now = new Date(slot.getTime() + 1000);
    await runScheduledPipelines(now);
    await runScheduledPipelines(new Date(now.getTime() + 60_000));
    let runs = await runsOf(pipeline.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed");
    assert.match(runs[0].summary ?? "", /No agent runs this automation/);
    assert.equal((await pipelineRow(pipeline.id)).nextRunAt?.toISOString(), "2026-11-09T08:00:00.000Z");

    await runScheduledPipelines(new Date(slot.getTime() + 7 * 86_400_000 + 1000));
    assert.equal((await pipelineRow(pipeline.id)).status, "active");
    const third = await runScheduledPipelines(new Date(slot.getTime() + 14 * 86_400_000 + 1000));
    assert.deepEqual(third.map((o) => o.outcome), ["paused"]);
    runs = await runsOf(pipeline.id);
    assert.equal(runs.length, 1);
    assert.equal((runs[0].statsJson as { repeat: number }).repeat, 3);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.status, "paused");
    assert.equal(row.nextRunAt, null);
    assert.match(row.pausedReason ?? "", /Paused after 3 scheduled runs could not start: No agent runs this automation/);
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, pipeline.id), eq(auditLog.action, "pipeline.paused")));
    assert.equal(entry.actorType, "system");
});

maybe("scheduler: a deleted runner agent fails the slot with a clear reason", async () => {
    const { pipeline, slot, quill } = await emperorScheduled();
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, quill.id));
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    await runScheduledPipelines(new Date(slot.getTime() + 1000));
    const [run] = await runsOf(pipeline.id);
    assert.equal(run.status, "failed");
    assert.match(run.summary ?? "", /no longer exists/);
});

maybe("scheduler: paused and agent-scheduled automations never fire; resuming recomputes from now", async () => {
    const { pipeline, slot, alex } = await emperorScheduled({ status: "paused" });
    const { pipelines } = await getSchema();
    const db = await getDb();
    const [agentScheduled] = await db.insert(pipelines).values({
        companyId: pipeline.companyId, name: "Agent keeps it", purpose: "x", docMarkdown: "x", trigger: "cron",
        triggerConfig: { cron: "0 9 * * 1" }, stepsJson: [{ name: "a" }], status: "active", ownerAgentId: pipeline.ownerAgentId,
        scheduledBy: "agent", nextRunAt: slot,
    }).returning();
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    await runScheduledPipelines(new Date(slot.getTime() + 1000));
    assert.equal((await runsOf(pipeline.id)).length, 0);
    assert.equal((await runsOf(agentScheduled.id)).length, 0);

    const PATCH = await patchRoute();
    actAs(alex);
    const before = Date.now();
    const resumed = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { status: "active" }, params: { id: pipeline.id } });
    assert.equal(resumed.status, 200, resumed.text);
    const next = (await pipelineRow(pipeline.id)).nextRunAt!;
    assert.ok(next.getTime() > before, "no backlog: the next slot is after the resume");
});

maybe("scheduler: an automation switched to Emperor without a slot gets one first, without firing", async () => {
    const { pipeline } = await fixture({ scheduledBy: "emperor", nextRunAt: null });
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    const now = new Date("2026-11-01T12:00:00Z");
    const outcomes = await runScheduledPipelines(now);
    assert.deepEqual(outcomes.map((o) => o.outcome), ["initialized"]);
    assert.equal((await pipelineRow(pipeline.id)).nextRunAt?.toISOString(), "2026-11-02T08:00:00.000Z");
    assert.equal((await runsOf(pipeline.id)).length, 0);
});

// ─── Hardening (review round) ───────────────────────────────────────────────

maybe("two Run now clicks at once start one run; the other is told a run is running", async () => {
    const { pipeline, alex } = await fixture();
    const POST = await runRoute();
    actAs(alex);
    const results = await Promise.all([1, 2].map(() => call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } })));
    assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
    assert.equal((await runsOf(pipeline.id)).length, 1);
    assert.equal((await pipelineRow(pipeline.id)).runCount, 1);
});

maybe("a failure after the run is recorded closes it as failed, and the next Run now is not blocked", async () => {
    const { pipeline, alex } = await fixture();
    const { pipelineRunTestHooks } = await import("@/lib/pipeline-runs");
    const POST = await runRoute();
    actAs(alex);
    pipelineRunTestHooks.beforeTask = async () => { throw new Error("task service down"); };
    try {
        const res = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
        assert.equal(res.status, 500);
    } finally {
        pipelineRunTestHooks.beforeTask = null;
    }
    const [failed] = await runsOf(pipeline.id);
    assert.equal(failed.status, "failed");
    assert.match(failed.summary ?? "", /task service down/);
    assert.ok(failed.endedAt);
    assert.equal((await pipelineRow(pipeline.id)).lastRunStatus, "failed");
    const again = await call(POST, `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: {}, params: { id: pipeline.id } });
    assert.equal(again.status, 201, again.text);
    const [, second] = await runsOf(pipeline.id);
    assert.equal(second.taskId, again.json.taskId);
});

maybe("scheduler: an unreadable schedule pauses the automation with the reason and one failed run", async () => {
    const { pipeline, slot, alex } = await emperorScheduled({ triggerConfig: { cron: "every monday please" } });
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    const outcomes = await runScheduledPipelines(new Date(slot.getTime() + 1000));
    assert.deepEqual(outcomes.map((o) => o.outcome), ["paused"]);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.status, "paused");
    assert.equal(row.nextRunAt, null);
    assert.match(row.pausedReason ?? "", /^Invalid schedule/);
    const runs = await runsOf(pipeline.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, "failed");
    // Fixed and turned on again: the reason is cleared.
    const db = await getDb();
    const { pipelines } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(pipelines).set({ triggerConfig: { cron: "0 9 * * 1" } }).where(eq(pipelines.id, pipeline.id));
    actAs(alex);
    const resumed = await call(await patchRoute(), `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { status: "active" }, params: { id: pipeline.id } });
    assert.equal(resumed.status, 200, resumed.text);
    assert.equal((await pipelineRow(pipeline.id)).pausedReason, null);
});

maybe("Emperor only keeps schedules of at most every 15 minutes; an agent's own schedule may be faster", async () => {
    const { pipeline, alex, companyId, quill } = await fixture({ triggerConfig: { cron: "*/5 * * * *" } });
    actAs(alex);
    const PATCH = await patchRoute();
    const refused = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { scheduledBy: "emperor" }, params: { id: pipeline.id } });
    assert.equal(refused.status, 422);
    assert.match(String(refused.json.error), /at most every 15 minutes/);
    assert.equal((await pipelineRow(pipeline.id)).scheduledBy, "agent");

    const token = await seedMcpToken(companyId, quill.id);
    const register = (await import("@/app/api/mcp/pipelines/route")).POST;
    const base = { purpose: "p", docMarkdown: "d", trigger: "cron", steps: [{ name: "s" }], status: "active" };
    const fast = await call(register as never, "/api/mcp/pipelines", { method: "POST", headers: agentHeaders(token), body: { ...base, name: "Fast", triggerConfig: { cron: "*/5 * * * *" }, scheduledBy: "emperor" } });
    assert.equal(fast.status, 422, fast.text);
    const own = await call(register as never, "/api/mcp/pipelines", { method: "POST", headers: agentHeaders(token), body: { ...base, name: "Fast", triggerConfig: { cron: "*/5 * * * *" } } });
    assert.equal(own.status, 201, own.text);
});

maybe("scope: a restricted agent cannot give an automation to, or schedule work for, an agent outside its reach", async () => {
    const { companyId, quill, scout } = await fixture();
    const alpha = await seedAgent(companyId, { name: "Alpha", scopeJson: { agentIds: [quill.id] } });
    const token = await seedMcpToken(companyId, alpha.id);
    const register = (await import("@/app/api/mcp/pipelines/route")).POST;
    const base = { purpose: "p", docMarkdown: "d", trigger: "cron", triggerConfig: { cron: "0 9 * * 1" }, steps: [{ name: "s" }], status: "active" };
    const outOfReach = await call(register as never, "/api/mcp/pipelines", { method: "POST", headers: agentHeaders(token), body: { ...base, name: "Hijack", agentId: scout.id, scheduledBy: "emperor" } });
    assert.equal(outOfReach.status, 403, outOfReach.text);
    const inReach = await call(register as never, "/api/mcp/pipelines", { method: "POST", headers: agentHeaders(token), body: { ...base, name: "Fine", agentId: quill.id, scheduledBy: "emperor" } });
    assert.equal(inReach.status, 201, inReach.text);

    // An automation Scout owns: Alpha may not switch it to Emperor's schedule.
    const db = await getDb();
    const { pipelines } = await getSchema();
    const [scouts] = await db.insert(pipelines).values({
        companyId, name: "Scout digest", purpose: "p", docMarkdown: "d", trigger: "cron", triggerConfig: { cron: "0 9 * * 1" },
        stepsJson: [{ name: "s" }], status: "active", ownerAgentId: scout.id,
    }).returning();
    const patch = (await import("@/app/api/mcp/pipelines/[id]/route")).PATCH;
    const switched = await call(patch as never, `/api/mcp/pipelines/${scouts.id}`, { method: "PATCH", headers: agentHeaders(token), body: { scheduledBy: "emperor" }, params: { id: scouts.id } });
    assert.equal(switched.status, 403, switched.text);
    assert.equal((await pipelineRow(scouts.id)).scheduledBy, "agent");
});

maybe("scope: a restricted member can only make an agent they may use the runner", async () => {
    const { pipeline, companyId, quill, scout } = await fixture();
    const ria = await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [quill.id] } });
    actAs(ria);
    const PATCH = await patchRoute();
    const denied = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { ownerAgentId: scout.id }, params: { id: pipeline.id } });
    assert.equal(denied.status, 404);
    const runAsScout = await call(await runRoute(), `/api/pipelines/${pipeline.id}/run`, { method: "POST", body: { agentId: scout.id }, params: { id: pipeline.id } });
    assert.equal(runAsScout.status, 404);
    assert.equal((await pipelineRow(pipeline.id)).ownerAgentId, quill.id);
});

maybe("an agent limited to some projects cannot run an automation whose task would go to the General project", async () => {
    const { pipeline, companyId, quill } = await fixture();
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ scopeJson: { mode: "restricted", customerIds: [], projectIds: [] } }).where(eq(agents.id, quill.id));
    const asQuill = await mcpClientFor(companyId, quill.id);
    const res = await asQuill.tool("run_automation", { automationId: pipeline.id });
    assert.equal(res.isError, true);
    assert.match(res.text, /can't create tasks in the project/);
    assert.equal((await runsOf(pipeline.id)).length, 0);
});

maybe("scheduler: at most 20 runs per company per pass; the rest stay due and start on the next pass", async () => {
    const { companyId, quill } = await fixture({ status: "draft" });
    const db = await getDb();
    const { pipelines, pipelineRuns } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const slot = new Date("2026-11-02T08:00:00Z");
    await db.insert(pipelines).values(Array.from({ length: 22 }, (_, i) => ({
        companyId, name: `Digest ${i}`, purpose: "p", docMarkdown: "d", trigger: "cron",
        triggerConfig: { cron: "0 9 * * 1", timezone: "Europe/Madrid" }, stepsJson: [{ name: "s" }], status: "active",
        ownerAgentId: quill.id, scheduledBy: "emperor", nextRunAt: new Date(slot.getTime() - i * 1000),
    })));
    const { runScheduledPipelines, SCHEDULER_RUNS_PER_COMPANY_PER_TICK } = await import("@/lib/pipeline-runs");
    const now = new Date(slot.getTime() + 1000);
    const first = await runScheduledPipelines(now);
    assert.equal(first.filter((o) => o.outcome === "started").length, SCHEDULER_RUNS_PER_COMPANY_PER_TICK);
    assert.equal(first.filter((o) => o.outcome === "deferred").length, 2);
    const second = await runScheduledPipelines(new Date(now.getTime() + 60_000));
    assert.equal(second.filter((o) => o.outcome === "started").length, 2, "no slot lost");
    assert.equal((await db.select().from(pipelineRuns).where(eq(pipelineRuns.companyId, companyId))).length, 22);
});

// ─── Re-review round ────────────────────────────────────────────────────────

maybe("scheduler: a handoff that fails every slot is one counted row, no run count, then a pause", async () => {
    const { pipeline, slot } = await emperorScheduled();
    const { runScheduledPipelines, pipelineRunTestHooks } = await import("@/lib/pipeline-runs");
    pipelineRunTestHooks.beforeTask = async () => { throw new Error("task service down"); };
    try {
        for (const week of [0, 1, 2]) await runScheduledPipelines(new Date(slot.getTime() + week * 7 * 86_400_000 + 1000));
    } finally {
        pipelineRunTestHooks.beforeTask = null;
    }
    const runs = await runsOf(pipeline.id);
    assert.equal(runs.length, 1, "one row for the whole streak");
    assert.equal(runs[0].status, "failed");
    assert.equal((runs[0].statsJson as { reasonCode: string; repeat: number }).reasonCode, "start_error");
    assert.equal((runs[0].statsJson as { repeat: number }).repeat, 3);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.runCount, 0, "no run reached the agent");
    assert.equal(row.status, "paused");
    assert.match(row.pausedReason ?? "", /Paused after 3 scheduled runs could not start: Could not hand the run to the agent: task service down/);
});

maybe("resuming starts the failure streak over: one more failure does not pause it again", async () => {
    const { pipeline, slot, alex } = await emperorScheduled({ ownerAgentId: null });
    const { runScheduledPipelines } = await import("@/lib/pipeline-runs");
    for (const week of [0, 1, 2]) await runScheduledPipelines(new Date(slot.getTime() + week * 7 * 86_400_000 + 1000));
    assert.equal((await pipelineRow(pipeline.id)).status, "paused");

    actAs(alex);
    const resumed = await call(await patchRoute(), `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { status: "active" }, params: { id: pipeline.id } });
    assert.equal(resumed.status, 200, resumed.text);
    const next = (await pipelineRow(pipeline.id)).nextRunAt!;
    await runScheduledPipelines(new Date(next.getTime() + 1000));
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.status, "active", "a single failure after resuming does not pause");
    const runs = await runsOf(pipeline.id);
    assert.equal(runs.length, 2);
    assert.equal((runs[1].statsJson as { repeat: number }).repeat, 1);
});

maybe("MCP PATCH resending the same status keeps the pending slot; a new schedule moves it", async () => {
    const { pipeline, companyId, quill } = await fixture({ scheduledBy: "emperor" });
    const pending = new Date(Date.now() + 3 * 86_400_000);
    const db = await getDb();
    const { pipelines } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(pipelines).set({ nextRunAt: pending }).where(eq(pipelines.id, pipeline.id));
    const token = await seedMcpToken(companyId, quill.id);
    const patch = (await import("@/app/api/mcp/pipelines/[id]/route")).PATCH;
    const same = await call(patch as never, `/api/mcp/pipelines/${pipeline.id}`, { method: "PATCH", headers: agentHeaders(token), body: { status: "active", scheduledBy: "emperor", triggerConfig: { cron: "0 9 * * 1", timezone: "Europe/Madrid" } }, params: { id: pipeline.id } });
    assert.equal(same.status, 200, same.text);
    assert.equal((await pipelineRow(pipeline.id)).nextRunAt?.toISOString(), pending.toISOString());
    const moved = await call(patch as never, `/api/mcp/pipelines/${pipeline.id}`, { method: "PATCH", headers: agentHeaders(token), body: { triggerConfig: { cron: "0 10 * * 2", timezone: "Europe/Madrid" } }, params: { id: pipeline.id } });
    assert.equal(moved.status, 200, moved.text);
    const nextRunAt = (await pipelineRow(pipeline.id)).nextRunAt!;
    assert.notEqual(nextRunAt.toISOString(), pending.toISOString());
    assert.equal(nextRunAt.getUTCDay(), 2);
});
