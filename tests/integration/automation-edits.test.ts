/**
 * Automations edited from the app (PATCH /api/pipelines/[id]): a new schedule
 * switches it to Emperor's scheduling with the next slot recomputed, an
 * unreadable cron is refused, edited fields become operator-owned (agent
 * re-registration and MCP PATCH keep them and say so), the runner agent is
 * told once, and only people who may change the automation can edit it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, seedHuman, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;
const agentHeaders = (token: string) => ({ ...bearer(token), "Idempotency-Key": randomUUID() });

async function fixture(pipelineOverrides: Record<string, unknown> = {}) {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const db = await getDb();
    const { pipelines } = await getSchema();
    const quill = await seedAgent(companyId, { name: "Quill" });
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
        scheduledBy: "agent",
        ownerAgentId: quill.id,
        createdByType: "agent",
        createdById: quill.id,
        ...pipelineOverrides,
    }).returning();
    return { companyId, quill, alex, vic, pipeline };
}

async function patchRoute() {
    return (await import("@/app/api/pipelines/[id]/route")).PATCH;
}

async function pipelineRow(id: string) {
    const db = await getDb();
    const { pipelines } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
    return row;
}

/** System messages addressed to an agent about an edit of this automation. */
async function editMessagesFor(agentId: string, pipelineId: string) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const rows = await db.select().from(threadMessages).where(and(eq(threadMessages.targetAgentId, agentId), eq(threadMessages.senderType, "system")));
    return rows.filter((row) => (row.metadataJson as { pipelineEdited?: boolean; pipelineId?: string }).pipelineEdited && (row.metadataJson as { pipelineId?: string }).pipelineId === pipelineId);
}

maybe("a new schedule from the app switches it to Emperor's scheduling and recomputes the next slot", async () => {
    const { pipeline, alex } = await fixture();
    actAs(alex);
    const PATCH = await patchRoute();
    const res = await call(PATCH, `/api/pipelines/${pipeline.id}`, {
        method: "PATCH", body: { schedule: { cron: "30 10 * * 2", timezone: "America/New_York" } }, params: { id: pipeline.id },
    });
    assert.equal(res.status, 200, res.text);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.scheduledBy, "emperor");
    assert.deepEqual(row.triggerConfig, { cron: "30 10 * * 2", timezone: "America/New_York" });
    assert.ok(row.nextRunAt && row.nextRunAt.getTime() > Date.now());
    // Tuesday 10:30 in New York is 14:30 or 15:30 UTC depending on DST.
    assert.equal(row.nextRunAt!.getUTCDay(), 2);
    assert.ok([14, 15].includes(row.nextRunAt!.getUTCHours()));
    assert.equal(row.nextRunAt!.getUTCMinutes(), 30);
    assert.deepEqual(row.operatorFields, ["schedule"]);
    assert.equal(row.operatorEditedBy, alex.userId);
    assert.ok(row.operatorEditedAt);
    assert.match(row.diagramMermaid ?? "", /cron: 30 10 \* \* 2/);

    // In the activity log as the person's edit.
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const entries = await db.select().from(auditLog).where(eq(auditLog.targetId, pipeline.id));
    const edit = entries.find((e) => e.action === "pipeline.updated" && e.actorId === alex.userId);
    assert.ok(edit, "audit entry");
    const payload = edit!.payloadJson as { meta?: { fields?: string }; before?: { cron?: string }; after?: { scheduledBy?: string; cron?: string; timezone?: string } };
    assert.equal(payload.meta?.fields, "schedule");
    assert.equal(payload.before?.cron, "0 9 * * 1");
    assert.deepEqual([payload.after?.scheduledBy, payload.after?.cron, payload.after?.timezone], ["emperor", "30 10 * * 2", "America/New_York"]);
});

maybe("an unreadable cron or an unknown time zone is refused with 400; a schedule faster than 15 minutes with 422", async () => {
    const { pipeline, alex } = await fixture();
    actAs(alex);
    const PATCH = await patchRoute();
    const bad = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { schedule: { cron: "every monday" } }, params: { id: pipeline.id } });
    assert.equal(bad.status, 400, bad.text);
    assert.match(String(bad.json.error), /not a cron expression Emperor can read/);
    const zone = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { schedule: { cron: "0 9 * * *", timezone: "Mars/Olympus" } }, params: { id: pipeline.id } });
    assert.equal(zone.status, 400, zone.text);
    const fast = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { schedule: { cron: "*/5 * * * *" } }, params: { id: pipeline.id } });
    assert.equal(fast.status, 422, fast.text);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.scheduledBy, "agent");
    assert.deepEqual(row.triggerConfig, { cron: "0 9 * * 1", timezone: "Europe/Madrid" });
    assert.deepEqual(row.operatorFields, []);
});

maybe("the name can't be changed, and an active automation keeps its purpose, docs and a step", async () => {
    const { pipeline, alex } = await fixture();
    actAs(alex);
    const PATCH = await patchRoute();
    const renamed = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { name: "Renamed" }, params: { id: pipeline.id } });
    assert.equal(renamed.status, 400, renamed.text);
    const noSteps = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { steps: [] }, params: { id: pipeline.id } });
    assert.equal(noSteps.status, 422, noSteps.text);
    assert.match(String(noSteps.json.error), /at least one declared step/);
    const noPurpose = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { purpose: "  " }, params: { id: pipeline.id } });
    assert.equal(noPurpose.status, 422, noPurpose.text);
    const badStep = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { steps: [{ description: "no name" }] }, params: { id: pipeline.id } });
    assert.equal(badStep.status, 400, badStep.text);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.name, "Weekly leads digest");
    assert.equal((row.stepsJson as unknown[]).length, 2);
});

maybe("agent re-registration and MCP PATCH keep the operator's fields and report them", async () => {
    const { pipeline, alex, quill, companyId } = await fixture();
    actAs(alex);
    const PATCH = await patchRoute();
    const edited = await call(PATCH, `/api/pipelines/${pipeline.id}`, {
        method: "PATCH",
        body: {
            schedule: { cron: "0 10 * * 2", timezone: "Europe/Madrid" },
            steps: [{ name: "Collect leads" }, { name: "Check with Alex", gate: true }, { name: "Write digest", agentRef: "Quill" }],
            docMarkdown: "Person-written docs.",
        },
        params: { id: pipeline.id },
    });
    assert.equal(edited.status, 200, edited.text);
    const before = await pipelineRow(pipeline.id);
    assert.deepEqual(before.operatorFields, ["schedule", "docMarkdown", "steps"]);

    // The agent re-registers on boot with its old definition.
    const token = await seedMcpToken(companyId, quill.id);
    const register = (await import("@/app/api/mcp/pipelines/route")).POST;
    const res = await call(register as never, "/api/mcp/pipelines", {
        method: "POST", headers: agentHeaders(token),
        body: {
            name: "Weekly leads digest", purpose: "A new purpose from the agent.", docMarkdown: "Agent docs.",
            trigger: "cron", triggerConfig: { cron: "0 9 * * 1", timezone: "Europe/Madrid" }, scheduledBy: "agent",
            steps: [{ name: "Collect leads" }, { name: "Write digest" }], status: "active",
        },
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.operatorOwned, ["schedule", "docMarkdown", "steps"]);
    assert.deepEqual(res.json.ignoredFields, ["schedule", "docMarkdown", "steps"]);
    assert.ok((res.json.warnings as string[]).some((w) => /operator-owned/.test(w) && /Emperor keeps the schedule/.test(w)), res.text);
    const after = await pipelineRow(pipeline.id);
    assert.deepEqual(after.triggerConfig, { cron: "0 10 * * 2", timezone: "Europe/Madrid" });
    assert.equal(after.scheduledBy, "emperor");
    assert.equal(after.docMarkdown, "Person-written docs.");
    assert.equal((after.stepsJson as unknown[]).length, 3);
    assert.equal(after.purpose, "A new purpose from the agent.", "not edited in the app: the agent's purpose applies");
    assert.equal(after.nextRunAt?.toISOString(), before.nextRunAt?.toISOString(), "the pending slot is kept");

    // MCP PATCH: same rule.
    const mcpPatch = (await import("@/app/api/mcp/pipelines/[id]/route")).PATCH;
    const patched = await call(mcpPatch as never, `/api/mcp/pipelines/${pipeline.id}`, {
        method: "PATCH", headers: agentHeaders(token), body: { triggerConfig: { cron: "0 8 * * *" }, scheduledBy: "agent", runtimeRef: "flows/digest" }, params: { id: pipeline.id },
    });
    assert.equal(patched.status, 200, patched.text);
    assert.deepEqual(patched.json.ignoredFields, ["schedule"]);
    const final = await pipelineRow(pipeline.id);
    assert.deepEqual(final.triggerConfig, { cron: "0 10 * * 2", timezone: "Europe/Madrid" });
    assert.equal(final.scheduledBy, "emperor");
    assert.equal(final.runtimeRef, "flows/digest");

    // Handing the schedule back to the agent in the app releases it, keeps the
    // stored cron, and tells the agent to fire that cron itself.
    const back = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { scheduledBy: "agent" }, params: { id: pipeline.id } });
    assert.equal(back.status, 200, back.text);
    assert.equal(back.json.agentNotified, true);
    const handedBack = await pipelineRow(pipeline.id);
    assert.deepEqual(handedBack.operatorFields, ["docMarkdown", "steps"]);
    assert.equal(handedBack.scheduledBy, "agent");
    assert.deepEqual(handedBack.triggerConfig, { cron: "0 10 * * 2", timezone: "Europe/Madrid" }, "the stored cron is kept");
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const notices = (await db.select().from(threadMessages).where(eq(threadMessages.targetAgentId, quill.id)))
        .filter((row) => (row.metadataJson as { pipelineScheduleHandedBack?: boolean }).pipelineScheduleHandedBack);
    assert.equal(notices.length, 1);
    assert.match(notices[0].text, /Emperor no longer starts its runs/);
    assert.match(notices[0].text, /0 10 \* \* 2, Europe\/Madrid/);
    assert.equal(notices[0].deliveryState, "queued");
});

maybe("a member who may not hand work to the runner agent can't edit it, and no one is told", async () => {
    const { pipeline, alex, quill, vic, companyId } = await fixture();
    const db = await getDb();
    const { agents, agentAccess } = await getSchema();
    const { eq } = await import("drizzle-orm");
    // Quill is limited to Vic: Alex may not hand it work.
    await db.update(agents).set({ access: "people" }).where(eq(agents.id, quill.id));
    await db.insert(agentAccess).values({ companyId, agentId: quill.id, userId: vic.userId });
    actAs(alex);
    const PATCH = await patchRoute();
    for (const body of [{ steps: [{ name: "Only one" }] }, { docMarkdown: "Changed." }, { schedule: { cron: "0 10 * * 2" } }]) {
        const res = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body, params: { id: pipeline.id } });
        assert.equal(res.status, 403, `${JSON.stringify(body)}: ${res.text}`);
    }
    const row = await pipelineRow(pipeline.id);
    assert.equal((row.stepsJson as unknown[]).length, 2);
    assert.equal(row.docMarkdown, "Reads the CRM, writes a digest.");
    assert.equal(row.scheduledBy, "agent");
    assert.deepEqual(row.operatorFields, []);
    assert.equal((await editMessagesFor(quill.id, pipeline.id)).length, 0);
});

maybe("the Context Pack: null clears pinned sources and tags; unknown resources are refused", async () => {
    const { pipeline, alex, companyId } = await fixture();
    const db = await getDb();
    const { scopedResources } = await getSchema();
    const [note] = await db.insert(scopedResources).values({ companyId, scopeType: "company", provider: "internal", resourceType: "note", name: "Lead SOP" }).returning();
    actAs(alex);
    const PATCH = await patchRoute();
    const set = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { contextResourceIds: [note.id], contextTagFilters: ["#sales"] }, params: { id: pipeline.id } });
    assert.equal(set.status, 200, set.text);
    let row = await pipelineRow(pipeline.id);
    assert.deepEqual(row.contextResourceIds, [note.id]);
    assert.deepEqual(row.contextTagFilters, ["sales"]);

    const { companyId: otherCompany } = await seedCompanyWithToken();
    const [foreign] = await db.insert(scopedResources).values({ companyId: otherCompany, scopeType: "company", provider: "internal", resourceType: "note", name: "Theirs" }).returning();
    for (const ids of [[foreign.id], ["not-an-id"]]) {
        const res = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { contextResourceIds: ids }, params: { id: pipeline.id } });
        assert.equal(res.status, 400, res.text);
    }
    assert.deepEqual((await pipelineRow(pipeline.id)).contextResourceIds, [note.id]);

    const cleared = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { contextResourceIds: null, contextTagFilters: [] }, params: { id: pipeline.id } });
    assert.equal(cleared.status, 200, cleared.text);
    row = await pipelineRow(pipeline.id);
    assert.deepEqual(row.contextResourceIds, []);
    assert.deepEqual(row.contextTagFilters, []);
});

maybe("the runner agent is told once per edit, with the schedule in plain words", async () => {
    const { pipeline, alex, quill } = await fixture();
    actAs(alex);
    const PATCH = await patchRoute();
    const res = await call(PATCH, `/api/pipelines/${pipeline.id}`, {
        method: "PATCH", body: { schedule: { cron: "0 10 * * 2", timezone: "Europe/Madrid" }, purpose: "Summarize leads every Tuesday." }, params: { id: pipeline.id },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.json.agentNotified, true);
    const messages = await editMessagesFor(quill.id, pipeline.id);
    assert.equal(messages.length, 1);
    const [message] = messages;
    assert.equal(message.deliveryState, "queued");
    assert.match(message.text, /edited the automation "Weekly leads digest"/);
    assert.match(message.text, /At 09:00, only on Monday \(0 9 \* \* 1, Europe\/Madrid\) → At 10:00, only on Tuesday \(0 10 \* \* 2, Europe\/Madrid\)/);
    assert.match(message.text, /Purpose updated/);
    assert.match(message.text, /Emperor now keeps this schedule/);

    // Saving the same values again changes nothing and tells no one.
    const same = await call(PATCH, `/api/pipelines/${pipeline.id}`, {
        method: "PATCH", body: { schedule: { cron: "0 10 * * 2", timezone: "Europe/Madrid" }, purpose: "Summarize leads every Tuesday." }, params: { id: pipeline.id },
    });
    assert.equal(same.status, 200, same.text);
    assert.equal(same.json.agentNotified, false);
    assert.equal((await editMessagesFor(quill.id, pipeline.id)).length, 1);
});

maybe("only people who may change the automation can edit it: a viewer gets 403", async () => {
    const { pipeline, vic } = await fixture();
    actAs(vic);
    const PATCH = await patchRoute();
    const res = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { purpose: "Viewer purpose." }, params: { id: pipeline.id } });
    assert.equal(res.status, 403, res.text);
    const row = await pipelineRow(pipeline.id);
    assert.equal(row.purpose, "Summarize last week's leads every Monday.");
    assert.deepEqual(row.operatorFields, []);
});

maybe("a manual automation gets a schedule from the app, and can go back to manual", async () => {
    const { pipeline, alex } = await fixture({ trigger: "manual", triggerConfig: {}, status: "draft" });
    actAs(alex);
    const PATCH = await patchRoute();
    const scheduled = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { schedule: { cron: "0 7 * * *" } }, params: { id: pipeline.id } });
    assert.equal(scheduled.status, 200, scheduled.text);
    let row = await pipelineRow(pipeline.id);
    assert.equal(row.trigger, "cron");
    assert.equal(row.scheduledBy, "emperor");
    assert.equal(row.nextRunAt, null, "a draft has no next run");
    const manual = await call(PATCH, `/api/pipelines/${pipeline.id}`, { method: "PATCH", body: { schedule: null }, params: { id: pipeline.id } });
    assert.equal(manual.status, 200, manual.text);
    row = await pipelineRow(pipeline.id);
    assert.equal(row.trigger, "manual");
    assert.deepEqual(row.triggerConfig, {});
});
