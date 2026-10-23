/**
 * Exploits from the security review of the access-control work, one test per
 * finding. Each one demonstrated a real gap before its fix.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function world() {
    await resetDb();
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Review Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const work = await seedTwoTenantsOfWork(companyId);
    const agentIn = await seedAgent(companyId, { name: "Agent In", scopeJson: { mode: "restricted", customerIds: [work.customerIn.id], projectIds: [] } });
    const agentOut = await seedAgent(companyId, { name: "Agent Out" });
    const scope = { mode: "restricted", agentIds: [agentIn.id], customerIds: [work.customerIn.id] };
    const restricted = await seedHuman(companyId, "member", { scope });
    return { companyId, ...work, agentIn, agentOut, scope, restricted };
}

async function note(companyId: string, scopeType: string, scopeId: string | null, name: string) {
    const { createScopedResource } = await import("@/lib/resources");
    return createScopedResource({ companyId, provider: "knowledge", resourceType: "knowledge_base", scopeType: scopeType as "company", scopeId, name, configText: name });
}

maybe("1. MCP approval decisions respect the restricted member's scope", async () => {
    const w = await world();
    const db = await getDb();
    const { approvals, approvalTaskLinks } = await getSchema();
    const [approval] = await db.insert(approvals).values({ companyId: w.companyId, projectId: w.projectOut.id, rationale: "out" }).returning();
    await db.insert(approvalTaskLinks).values({ companyId: w.companyId, approvalId: approval.id, taskId: w.taskOut.id });
    actAs(w.restricted);
    const route = await import("@/app/api/mcp/approvals/[id]/route");
    const res = await call(route.PATCH, `/api/mcp/approvals/${approval.id}`, { method: "PATCH", params: { id: approval.id }, body: { status: "approved" } });
    assert.equal(res.status, 404, "a restricted member decided an out-of-scope approval");
    actAs(null);
});

maybe("2. knowledge proposals: list, create and merge stay inside the member's scope", async () => {
    const w = await world();
    const { createResourceProposal } = await import("@/lib/resources");
    const outProposal = await createResourceProposal({ companyId: w.companyId, scopeType: "project", scopeId: w.projectOut.id, title: "OUT-PROPOSAL", proposedText: "x" });
    const outNote = await note(w.companyId, "project", w.projectOut.id, "out-note");
    actAs(w.restricted);
    const list = await call((await import("@/app/api/resources/proposals/route")).GET as never, "/api/resources/proposals");
    assert.equal(list.text.includes("OUT-PROPOSAL"), false, "listed an out-of-scope proposal");
    const create = await call((await import("@/app/api/resources/proposals/route")).POST as never, "/api/resources/proposals", { method: "POST", body: { title: "t", action: "update", targetResourceId: outNote.id } });
    assert.equal(create.status, 403, "proposed an edit to an out-of-scope note");
    const merge = await call((await import("@/app/api/resources/proposals/[id]/route")).PATCH as never, `/api/resources/proposals/${outProposal.id}`, { method: "PATCH", params: { id: outProposal.id }, body: { status: "merged" } });
    assert.equal(merge.status, 404, "merged an out-of-scope proposal");
    actAs(null);
});

maybe("3. knowledge graph and backlinks hide neighbours outside the scope", async () => {
    const w = await world();
    const inNote = await note(w.companyId, "company", null, "in-note");
    const outNote = await note(w.companyId, "project", w.projectOut.id, "OUT-NEIGHBOUR");
    const db = await getDb();
    const { resourceLinks } = await getSchema();
    await db.insert(resourceLinks).values([
        { companyId: w.companyId, sourceResourceId: inNote.id, targetResourceId: outNote.id, linkText: "OUT-LINK-TEXT" },
        { companyId: w.companyId, sourceResourceId: outNote.id, targetResourceId: inNote.id, linkText: "OUT-BACK-TEXT" },
    ]);
    actAs(w.restricted);
    const graph = await call((await import("@/app/api/resources/[id]/graph/route")).GET as never, `/api/resources/${inNote.id}/graph`, { params: { id: inNote.id } });
    assert.equal(graph.status, 200);
    assert.equal(graph.text.includes(outNote.id), false, "graph leaked an out-of-scope neighbour");
    const backlinks = await call((await import("@/app/api/resources/[id]/backlinks/route")).GET as never, `/api/resources/${inNote.id}/backlinks`, { params: { id: inNote.id } });
    assert.equal(backlinks.text.includes(outNote.id), false, "backlinks leaked an out-of-scope note");
    actAs(null);
});

maybe("4. an MCP token cannot rewrite the shared LLM price table", async () => {
    const w = await world();
    const token = bearer(await seedMcpToken(w.companyId, w.agentIn.id));
    const route = await import("@/app/api/mcp/pricing/route");
    const res = await call(route.POST, "/api/mcp/pricing", { method: "POST", headers: token, body: { provider: "deepseek", model: "deepseek-v4-flash", label: "free", inputPricePer1k: 0, outputPricePer1k: 0 } });
    assert.equal(res.status, 403);
    const db = await getDb();
    const { llmPricing } = await getSchema();
    assert.equal((await db.select().from(llmPricing)).length, 0, "pricing row was written");
});

maybe("5. scoped agents: pipelines, incidents, schedules, action runs, and the websocket", async () => {
    const w = await world();
    const db = await getDb();
    const { pipelines, incidents, schedules, actionRuns } = await getSchema();
    const auth = bearer(await seedMcpToken(w.companyId, w.agentIn.id));
    const [pipeline] = await db.insert(pipelines).values({ companyId: w.companyId, name: "out-pipe", projectId: w.projectOut.id }).returning();
    const [incident] = await db.insert(incidents).values({ companyId: w.companyId, projectId: w.projectOut.id, severity: "high", reasonCode: "x", summary: "s" }).returning();
    const [schedule] = await db.insert(schedules).values({ companyId: w.companyId, name: "OUT-SCHEDULE", cronExpression: "* * * * *", targetProjectId: w.projectOut.id }).returning();
    const [run] = await db.insert(actionRuns).values({ companyId: w.companyId, projectId: w.projectOut.id }).returning();

    const pipe = await call((await import("@/app/api/mcp/pipelines/[id]/route")).GET, `/api/mcp/pipelines/${pipeline.id}`, { headers: auth, params: { id: pipeline.id } });
    assert.equal(pipe.status, 404, "read an out-of-scope pipeline");
    const runs = await call((await import("@/app/api/mcp/pipelines/[id]/runs/route")).GET, `/api/mcp/pipelines/${pipeline.id}/runs`, { headers: auth, params: { id: pipeline.id } });
    assert.equal(runs.status, 404, "read an out-of-scope pipeline's runs");
    const inc = await call((await import("@/app/api/mcp/incidents/[id]/route")).PATCH, `/api/mcp/incidents/${incident.id}`, { method: "PATCH", headers: { ...auth, "Idempotency-Key": randomUUID() }, params: { id: incident.id }, body: { status: "resolved" } });
    assert.equal(inc.status, 404, "resolved an out-of-scope incident");
    const list = await call((await import("@/app/api/mcp/schedules/route")).GET, "/api/mcp/schedules", { headers: auth });
    assert.equal(list.text.includes("OUT-SCHEDULE"), false, "listed an out-of-scope schedule");
    const sched = await call((await import("@/app/api/mcp/schedules/[id]/route")).DELETE, `/api/mcp/schedules/${schedule.id}`, { method: "DELETE", headers: { ...auth, "Idempotency-Key": randomUUID() }, params: { id: schedule.id } });
    assert.equal(sched.status, 404, "deleted an out-of-scope schedule");
    const step = await call((await import("@/app/api/mcp/actions/[id]/steps/route")).POST, `/api/mcp/actions/${run.id}/steps`, { method: "POST", headers: auth, params: { id: run.id }, body: { stepType: "x" } });
    assert.equal(step.status, 404, "wrote a step into an out-of-scope action run");

    // Websocket fan-out: an event about the out-of-scope project never reaches the scoped agent's socket.
    const { realtimeSubjectFor } = await import("@/lib/pubsub");
    const { socketReceives } = await import("@/lib/realtime-delivery");
    const { loadAgentScopeContext } = await import("@/lib/agent-scope");
    const subject = await realtimeSubjectFor(w.companyId, { type: "task_updated", task: { id: w.taskOut.id, projectId: w.projectOut.id } });
    const scoped = await loadAgentScopeContext(w.companyId, w.agentIn.id);
    const event = { companyId: w.companyId, audience: null, subject };
    assert.equal(socketReceives(event, { companyId: w.companyId, agentId: w.agentIn.id, ...scoped }), false, "scoped socket got an out-of-scope event");
    assert.equal(socketReceives(event, { companyId: w.companyId, agentId: w.agentOut.id, allowedProjectIds: null, allowedCustomerIds: null }), true, "unscoped agents still get it");
    const viaTaskId = await realtimeSubjectFor(w.companyId, { type: "task_note_added", taskId: w.taskOut.id });
    assert.equal(socketReceives({ ...event, subject: viaTaskId }, { companyId: w.companyId, agentId: w.agentIn.id, ...scoped }), false);
    const definition = await realtimeSubjectFor(w.companyId, { type: "recurring_task_definition_updated", definition: { id: w.taskOut.id, projectId: w.projectOut.id } });
    assert.equal(socketReceives({ ...event, subject: definition }, { companyId: w.companyId, agentId: w.agentIn.id, ...scoped }), false, "recurring definition of an out-of-scope project leaked");
    const team = await realtimeSubjectFor(w.companyId, { type: "agent_status" });
    assert.equal(socketReceives({ ...event, subject: team }, { companyId: w.companyId, agentId: w.agentIn.id, ...scoped }), true, "company events still reach scoped agents");
});

maybe("6. a restricted member cannot assign work to agents outside their scope", async () => {
    const w = await world();
    actAs(w.restricted);
    const patch = await call((await import("@/app/api/tasks/[id]/route")).PATCH, `/api/tasks/${w.taskIn.id}`, { method: "PATCH", params: { id: w.taskIn.id }, body: { assignedAgentId: w.agentOut.id } });
    assert.equal(patch.status, 404, "reassigned to an out-of-scope agent");
    const create = await call((await import("@/app/api/tasks/route")).POST, "/api/tasks", { method: "POST", body: { projectId: w.projectIn.id, title: "t", assignee: { type: "agent", id: w.agentOut.id } } });
    assert.equal(create.status, 404, "created work for an out-of-scope agent");
    actAs(null);
});

maybe("7. uploads and new folders stay inside the member's scope", async () => {
    const w = await world();
    actAs(w.restricted);
    const folder = await call((await import("@/app/api/ui/folders/route")).POST, "/api/ui/folders", { method: "POST", body: { name: "f", projectId: w.projectOut.id } });
    assert.equal(folder.status, 404, "created a folder in an out-of-scope project");
    const form = new FormData();
    form.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));
    form.set("projectId", w.projectOut.id);
    const upload = await (await import("@/app/api/ui/artifacts/upload/route")).POST(new NextRequest(new Request("http://localhost/api/ui/artifacts/upload", { method: "POST", body: form })));
    assert.equal(upload.status, 404, "uploaded into an out-of-scope project");
    actAs(null);
});

maybe("8. groups: restricted members see and change only groups of their agents", async () => {
    const w = await world();
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(w.companyId, { type: "system", id: null }, { title: "OUT-GROUP", agentIds: [w.agentOut.id] });
    actAs(w.restricted);
    const list = await call((await import("@/app/api/groups/route")).GET as never, "/api/groups");
    assert.equal(list.text.includes("OUT-GROUP"), false, "listed a group with an out-of-scope agent");
    const read = await call((await import("@/app/api/groups/[id]/route")).GET, `/api/groups/${group.id}`, { params: { id: group.id } });
    assert.equal(read.status, 404);
    const chat = await call((await import("@/app/api/chat/route")).GET, `/api/chat?threadId=${group.id}`);
    assert.equal(chat.status, 404, "read an out-of-scope group's messages");
    const archive = await call((await import("@/app/api/groups/[id]/route")).DELETE, `/api/groups/${group.id}`, { method: "DELETE", params: { id: group.id } });
    assert.equal(archive.status, 404, "archived an out-of-scope group");
    const created = await call((await import("@/app/api/groups/route")).POST, "/api/groups", { method: "POST", body: { title: "g", agentIds: [w.agentOut.id] } });
    assert.equal(created.status, 404, "created a group with an out-of-scope agent");
    actAs(null);
});

maybe("9. agent tokens cannot create agents or heartbeat as another agent", async () => {
    const w = await world();
    const auth = bearer(await seedMcpToken(w.companyId, w.agentIn.id));
    const reg = await call((await import("@/app/api/mcp/agents/route")).POST, "/api/mcp/agents", { method: "POST", headers: { ...auth, "Idempotency-Key": randomUUID() }, body: { name: "minion", concurrencyLimit: 99, llmModel: "x" } });
    assert.equal(reg.status, 403, "an agent registered a new (unscoped) agent");
    const client = await mcpClientFor(w.companyId, w.agentIn.id);
    assert.equal((await client.tool("create_agent", { name: "minion2" })).isError, true, "create_agent from an agent connection");
    const hb = await call((await import("@/app/api/mcp/agents/heartbeat/route")).POST, "/api/mcp/agents/heartbeat", { method: "POST", headers: auth, body: { agentId: w.agentOut.id, currentLoad: 0 } });
    assert.equal(hb.status, 403, "heartbeat for another agent");
});

maybe("10. token lifecycle: deleted agents and removed creators", async () => {
    const w = await world();
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const manual = await import("@/app/api/mcp/manual/route");

    // A token bound to a deleted agent stops working everywhere.
    const doomedToken = await seedMcpToken(w.companyId, w.agentOut.id);
    const owner = await seedHuman(w.companyId, "owner");
    actAs(owner);
    const del = await call((await import("@/app/api/agents/[id]/route")).DELETE, `/api/agents/${w.agentOut.id}`, { method: "DELETE", params: { id: w.agentOut.id }, body: { confirmName: "Agent Out" } });
    assert.equal(del.status, 200);
    assert.equal((await call(manual.GET as never, "/api/mcp/manual", { headers: bearer(doomedToken) })).status, 401, "a deleted agent's token still works");

    // A soft-deleted agent (no revoke) is refused centrally too.
    const softToken = await seedMcpToken(w.companyId, w.agentIn.id);
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, w.agentIn.id));
    assert.equal((await call(manual.GET as never, "/api/mcp/manual", { headers: bearer(softToken) })).status, 401);

    // Tokens a removed member minted stop working (screens included).
    const admin = await seedHuman(w.companyId, "admin");
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({ companyId: w.companyId, scope: "read_only", name: "screen", createdByUserId: admin.userId, tokenHash: createHash("sha256").update(raw).digest("hex") });
    const live = await import("@/app/api/mcp/live/route");
    assert.equal((await call(live.GET as never, "/api/mcp/live", { headers: bearer(raw) })).status, 200);
    actAs(owner);
    const removed = await call((await import("@/app/api/instance/members/[userId]/route")).DELETE, `/api/instance/members/${admin.userId}`, { method: "DELETE", params: { userId: admin.userId } });
    assert.equal(removed.status, 200);
    actAs(null);
    assert.equal((await call(live.GET as never, "/api/mcp/live", { headers: bearer(raw) })).status, 401, "a removed member's screen token still works");
});

maybe("11. entities, instance settings and invitations", async () => {
    const w = await world();
    const db = await getDb();
    const { artifacts, instanceSettings } = await getSchema();
    const [file] = await db.insert(artifacts).values({ companyId: w.companyId, projectId: w.projectOut.id, title: "OUT-FILE", kind: "report", contentType: "text/plain", sha256: "x", sizeBytes: 1, createdByType: "agent", visibility: "company" }).returning();
    actAs(w.restricted);
    const entities = await call((await import("@/app/api/ui/entities/route")).GET, `/api/ui/entities?refs=artifact:${file.id}`);
    assert.equal(entities.text.includes("OUT-FILE"), false, "entity card for an out-of-scope file");

    await db.insert(instanceSettings).values({ key: "smtp_host", value: "mail.internal.example" });
    const { clearInstanceSettingsCache } = await import("@/lib/instance");
    clearInstanceSettingsCache();
    actAs(await seedHuman(w.companyId, "viewer"));
    const settings = await call((await import("@/app/api/instance/settings/route")).GET, "/api/instance/settings");
    assert.equal(settings.text.includes("mail.internal.example"), false, "a viewer read the SMTP settings");

    actAs(await seedHuman(w.companyId, "admin"));
    const invite = await call((await import("@/app/api/instance/invitations/route")).POST as never, "/api/instance/invitations", { method: "POST", body: { email: `new-${randomUUID()}@example.com`, role: "admin" } });
    assert.equal(invite.status, 403, "an admin invited an admin");
    actAs(null);
});

maybe("regression: an instance admin without a membership keeps access to the instance company", async () => {
    await resetDb();
    const db = await getDb();
    const { users, companies, sessions } = await getSchema();
    const [admin] = await db.insert(users).values({ email: `ia-${randomUUID()}@example.com`, passwordHash: "x", instanceRole: "instance_admin" }).returning();
    await db.insert(companies).values({ name: "Instance Co", createdByUserId: admin.id });
    const [session] = await db.insert(sessions).values({ userId: admin.id, expiresAt: new Date(Date.now() + 86_400_000) }).returning();
    actAs({ userId: admin.id, sessionId: session.id });
    const res = await call((await import("@/app/api/projects/route")).GET as never, "/api/projects");
    assert.equal(res.status, 200, "instance admin without membership was locked out of the APIs");
    actAs(null);
});
