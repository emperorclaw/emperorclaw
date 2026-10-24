/**
 * "Agents it can work with" (agents.scope_json.agentIds): which agents an agent
 * sees in its roster, can message and can hand work to. One-way: Alpha's list
 * limits only Alpha. Fixture: Alpha may work with Bravo, not Charlie; Bravo
 * and Charlie are unrestricted (the default).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function world() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const bravo = await seedAgent(companyId, { name: "Bravo" });
    const charlie = await seedAgent(companyId, { name: "Charlie" });
    const alpha = await seedAgent(companyId, { name: "Alpha", scopeJson: { agentIds: [bravo.id] } });
    return {
        companyId, ...work, alpha, bravo, charlie,
        alphaToken: bearer(await seedMcpToken(companyId, alpha.id)),
        charlieToken: bearer(await seedMcpToken(companyId, charlie.id)),
    };
}

const idsOf = (rows: unknown) => (rows as { id: string }[]).map((r) => r.id).sort();

maybe("default is open: an agent without a list sees and reaches everyone", async () => {
    const w = await world();
    const client = await mcpClientFor(w.companyId, w.charlie.id);
    const listed = await client.tool("list_agents", {});
    for (const a of [w.alpha, w.bravo, w.charlie]) assert.ok(listed.text.includes(a.id), `${a.name} missing from an open roster`);
    const res = await call((await import("@/app/api/mcp/agents/route")).GET, "/api/mcp/agents", { headers: w.charlieToken });
    assert.deepEqual(idsOf(res.json.agents), [w.alpha.id, w.bravo.id, w.charlie.id].sort());
});

maybe("roster: a restricted agent lists and reads only itself and its agents", async () => {
    const w = await world();
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    const listed = await client.tool("list_agents", {});
    assert.equal(listed.text.includes(w.charlie.id), false, "list_agents showed an out-of-scope agent");
    assert.ok(listed.text.includes(w.alpha.id) && listed.text.includes(w.bravo.id));
    assert.equal((await client.tool("get_agent", { agentId: w.charlie.id })).isError, true, "get_agent on an out-of-scope agent");
    assert.equal((await client.tool("get_agent", { agentId: w.bravo.id })).isError, false);

    const list = await call((await import("@/app/api/mcp/agents/route")).GET, "/api/mcp/agents", { headers: w.alphaToken });
    assert.deepEqual(idsOf(list.json.agents), [w.alpha.id, w.bravo.id].sort());
    const read = await import("@/app/api/mcp/agents/[id]/route");
    assert.equal((await call(read.GET, `/api/mcp/agents/${w.charlie.id}`, { headers: w.alphaToken, params: { id: w.charlie.id } })).status, 404);
    assert.equal((await call(read.GET, `/api/mcp/agents/${w.bravo.id}`, { headers: w.alphaToken, params: { id: w.bravo.id } })).status, 200);

    // The prompt roster the bridge injects lists only reachable agents.
    const lean = await call((await import("@/app/api/mcp/context/lean/route")).GET, "/api/mcp/context/lean", { headers: w.alphaToken });
    assert.equal(lean.status, 200);
    assert.equal(String(lean.json.roster).includes("Charlie"), false, "prompt roster included an out-of-scope agent");
    assert.ok(String(lean.json.roster).includes("Bravo"));
});

maybe("messaging: no direct or pair message to an out-of-scope agent; in-scope works", async () => {
    const w = await world();
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    const toCharlie = await client.tool("send_message", { text: "hi", targetAgentId: w.charlie.id });
    assert.equal(toCharlie.isError, true);
    assert.match(toCharlie.text, /can't reach Charlie/);
    assert.equal((await client.tool("send_message", { text: "hi", targetAgentId: w.charlie.id, private: true })).isError, true, "pair thread with an out-of-scope agent");
    assert.equal((await client.tool("send_message", { text: "hi", targetAgentId: w.bravo.id })).isError, false, "in-scope messaging must still work");

    const send = await import("@/app/api/mcp/messages/send/route");
    const rest = await call(send.POST, "/api/mcp/messages/send", { method: "POST", headers: w.alphaToken, body: { text: "hi", targetAgentId: w.charlie.id } });
    assert.equal(rest.status, 403);
});

maybe("mentions: the message posts, the out-of-scope mention never routes, the sender is told", async () => {
    const w = await world();
    const { ensureTeamThread } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(w.companyId);
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    const sent = await client.tool("send_message", { text: "@Charlie and @Bravo please look", threadId: team.id });
    assert.equal(sent.isError, false);
    assert.match(sent.text, /can't reach Charlie/);

    const sync = await import("@/app/api/mcp/messages/sync/route");
    const since = encodeURIComponent(new Date(0).toISOString());
    const asCharlie = await call(sync.GET, `/api/mcp/messages/sync?agentId=${w.charlie.id}&mode=all&since=${since}`, { headers: w.charlieToken });
    const forCharlie = (asCharlie.json.messages as { text: string; addressedToYou: boolean; routeReason: string }[]).find((m) => m.text.includes("please look"));
    assert.ok(forCharlie, "team chat stays readable");
    assert.equal(forCharlie!.addressedToYou, false, "an out-of-scope mention woke the agent");
    assert.equal(forCharlie!.routeReason, "out_of_scope");

    const bravoToken = bearer(await seedMcpToken(w.companyId, w.bravo.id));
    const asBravo = await call(sync.GET, `/api/mcp/messages/sync?agentId=${w.bravo.id}&mode=all&since=${since}`, { headers: bravoToken });
    const forBravo = (asBravo.json.messages as { text: string; addressedToYou: boolean }[]).find((m) => m.text.includes("please look"));
    assert.equal(forBravo?.addressedToYou, true, "the in-scope mention must still route");
});

maybe("delegation: no tasks, assignments, pipeline runs or group seats for out-of-scope agents", async () => {
    const w = await world();
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    assert.equal((await client.tool("create_task", { projectId: w.projectIn.id, taskType: "x", assignedAgentId: w.charlie.id })).isError, true, "create_task for an out-of-scope agent");
    assert.equal((await client.tool("update_task", { taskId: w.taskIn.id, assignee: { type: "agent", id: w.charlie.id } })).isError, true, "reassigning to an out-of-scope agent");
    assert.equal((await client.tool("create_group", { title: "g", agentIds: [w.charlie.id] })).isError, true, "a group seat for an out-of-scope agent");

    const assign = await import("@/app/api/mcp/tasks/[id]/assign/route");
    const toCharlie = await call(assign.POST, `/api/mcp/tasks/${w.taskIn.id}/assign`, { method: "POST", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, params: { id: w.taskIn.id }, body: { agentId: w.charlie.id } });
    assert.equal(toCharlie.status, 403);
    const toBravo = await call(assign.POST, `/api/mcp/tasks/${w.taskIn.id}/assign`, { method: "POST", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, params: { id: w.taskIn.id }, body: { agentId: w.bravo.id } });
    assert.equal(toBravo.status, 200, "in-scope assignment must still work");

    const tasks = await import("@/app/api/mcp/tasks/route");
    const created = await call(tasks.POST, "/api/mcp/tasks", { method: "POST", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, body: { projectId: w.projectIn.id, taskType: "x", allowUnderspecified: true, assignedAgentId: w.charlie.id } });
    assert.equal(created.status, 403);

    const db = await getDb();
    const { pipelines } = await getSchema();
    const [pipeline] = await db.insert(pipelines).values({ companyId: w.companyId, name: "p" }).returning();
    const run = await call((await import("@/app/api/mcp/pipelines/[id]/runs/route")).POST, `/api/mcp/pipelines/${pipeline.id}/runs`, { method: "POST", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, params: { id: pipeline.id }, body: { status: "running", agentId: w.charlie.id } });
    assert.equal(run.status, 403, "running a pipeline on an out-of-scope agent");
});

maybe("socket: presence about out-of-scope agents never reaches the restricted agent", async () => {
    const w = await world();
    const { realtimeSubjectFor } = await import("@/lib/pubsub");
    const { socketReceives } = await import("@/lib/realtime-delivery");
    const { loadAgentScopeContext } = await import("@/lib/agent-scope");
    const alphaSocket = { companyId: w.companyId, agentId: w.alpha.id, ...(await loadAgentScopeContext(w.companyId, w.alpha.id)) };
    const bravoSocket = { companyId: w.companyId, agentId: w.bravo.id, ...(await loadAgentScopeContext(w.companyId, w.bravo.id)) };
    const charlieStatus = { companyId: w.companyId, audience: null, subject: await realtimeSubjectFor(w.companyId, { type: "agent_status", agentId: w.charlie.id, status: "offline" }) };
    assert.equal(socketReceives(charlieStatus, alphaSocket), false, "presence of an out-of-scope agent");
    assert.equal(socketReceives(charlieStatus, bravoSocket), true);
    const bravoTyping = { companyId: w.companyId, audience: null, subject: await realtimeSubjectFor(w.companyId, { type: "participant_status", participantId: w.bravo.id, typing: true }) };
    assert.equal(socketReceives(bravoTyping, alphaSocket), true, "presence of an in-scope agent");
});

maybe("one-way: Charlie (unrestricted) still sees and reaches Alpha", async () => {
    const w = await world();
    const client = await mcpClientFor(w.companyId, w.charlie.id);
    assert.ok((await client.tool("list_agents", {})).text.includes(w.alpha.id));
    assert.equal((await client.tool("send_message", { text: "hello Alpha", targetAgentId: w.alpha.id })).isError, false);
});

maybe("only owners and admins edit the list; it is stored as given", async () => {
    const w = await world();
    const route = await import("@/app/api/agents/[id]/route");
    actAs(await seedHuman(w.companyId, "member"));
    const denied = await call(route.PATCH, `/api/agents/${w.charlie.id}`, { method: "PATCH", params: { id: w.charlie.id }, body: { scopeJson: { mode: "all", agentIds: [] } } });
    assert.equal(denied.status, 403);
    actAs(await seedHuman(w.companyId, "admin"));
    const saved = await call(route.PATCH, `/api/agents/${w.charlie.id}`, { method: "PATCH", params: { id: w.charlie.id }, body: { scopeJson: { mode: "all", agentIds: [w.bravo.id] } } });
    assert.equal(saved.status, 200);
    assert.deepEqual((saved.json.agent as { scopeJson: { agentIds?: string[] } }).scopeJson.agentIds, [w.bravo.id]);
    const reopened = await call(route.PATCH, `/api/agents/${w.charlie.id}`, { method: "PATCH", params: { id: w.charlie.id }, body: { scopeJson: { mode: "all", agentIds: null } } });
    assert.equal((reopened.json.agent as { scopeJson: { agentIds?: string[] } }).scopeJson.agentIds, undefined, "\"All agents\" clears the list");
    actAs(null);
});

// ─── Exploits fixed after review ────────────────────────────────────────────

maybe("padded ids: a space before an out-of-scope id never slips past the guard", async () => {
    const w = await world();
    const padded = ` ${w.charlie.id}`;
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    assert.equal((await client.tool("create_task", { projectId: w.projectIn.id, taskType: "x", assignedAgentId: padded })).isError, true, "create_task with a padded id");
    assert.equal((await client.tool("create_task", { projectId: w.projectIn.id, taskType: "x", assignee: { type: "agent", id: padded } })).isError, true, "create_task assignee with a padded id");
    assert.equal((await client.tool("update_task", { taskId: w.taskIn.id, assignedAgentId: padded })).isError, true, "update_task with a padded id");
    assert.equal((await client.tool("update_task", { taskId: w.taskIn.id, assignee: { type: "agent", id: padded } })).isError, true, "update_task assignee with a padded id");

    const tasks = await import("@/app/api/mcp/tasks/route");
    const created = await call(tasks.POST, "/api/mcp/tasks", { method: "POST", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, body: { projectId: w.projectIn.id, taskType: "x", allowUnderspecified: true, assignedAgentId: padded } });
    assert.equal(created.status, 403, "REST create with a padded id");
    const one = await import("@/app/api/mcp/tasks/[id]/route");
    const patched = await call(one.PATCH, `/api/mcp/tasks/${w.taskIn.id}`, { method: "PATCH", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, params: { id: w.taskIn.id }, body: { assignee: { type: "agent", id: padded } } });
    assert.equal(patched.status, 403, "REST update with a padded id");
    const assign = await import("@/app/api/mcp/tasks/[id]/assign/route");
    const assigned = await call(assign.POST, `/api/mcp/tasks/${w.taskIn.id}/assign`, { method: "POST", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, params: { id: w.taskIn.id }, body: { agentId: padded } });
    assert.equal(assigned.status, 403, "REST assign with a padded id");

    // Unknown refs fail closed for a restricted caller instead of passing the guard.
    assert.equal((await client.tool("create_task", { projectId: w.projectIn.id, taskType: "x", assignedAgentId: "no-such-agent" })).isError, true);

    assert.equal((await client.tool("create_group", { title: "g", agentIds: [padded] })).isError, true, "create_group with a padded id");
    const ok = await client.tool("create_group", { title: "ok", agentIds: [w.bravo.id] });
    assert.equal(ok.isError, false);
    const groupId = (JSON.parse(ok.text) as { threadId: string }).threadId;
    assert.equal((await client.tool("add_group_members", { groupId, agentIds: [padded] })).isError, true, "add_group_members with a padded id");
    const groups = await import("@/app/api/mcp/groups/route");
    const rest = await call(groups.POST, "/api/mcp/groups", { method: "POST", headers: w.alphaToken, body: { title: "g2", agentIds: [padded] } });
    assert.equal(rest.status, 403, "REST group create with a padded id");
    const members = await import("@/app/api/mcp/groups/[id]/members/route");
    const added = await call(members.POST, `/api/mcp/groups/${groupId}/members`, { method: "POST", headers: w.alphaToken, params: { id: groupId }, body: { agentIds: [padded] } });
    assert.equal(added.status, 403, "REST add member with a padded id");

    const db = await getDb();
    const schema = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const charlieTasks = await db.select().from(schema.tasks).where(and(eq(schema.tasks.companyId, w.companyId), eq(schema.tasks.assignedAgentId, w.charlie.id)));
    assert.equal(charlieTasks.length, 0, "work reached an out-of-scope agent");
    const charlieSeats = await db.select().from(schema.threadParticipants).where(and(eq(schema.threadParticipants.companyId, w.companyId), eq(schema.threadParticipants.participantId, w.charlie.id)));
    assert.equal(charlieSeats.length, 0, "a group seat reached an out-of-scope agent");
});

maybe("threads POST type=group applies the same reach rule as /groups", async () => {
    const w = await world();
    const threads = await import("@/app/api/mcp/threads/route");
    const denied = await call(threads.POST, "/api/mcp/threads", { method: "POST", headers: w.alphaToken, body: { type: "group", title: "side door", agentIds: [w.charlie.id] } });
    assert.equal(denied.status, 403);
    const allowed = await call(threads.POST, "/api/mcp/threads", { method: "POST", headers: w.alphaToken, body: { type: "group", title: "front door", agentIds: [w.bravo.id] } });
    assert.equal(allowed.status, 201, "in-scope group via threads must still work");
});

maybe("list groups: a restricted agent never sees out-of-scope members", async () => {
    const w = await world();
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(w.companyId, { type: "system", id: null }, { title: "Mixed", agentIds: [w.alpha.id, w.bravo.id, w.charlie.id] });
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    for (const mine of [false, true]) {
        const listed = await client.tool("list_groups", { mine });
        assert.equal(listed.isError, false);
        assert.ok(listed.text.includes(group.id), "the group itself stays listed");
        assert.equal(listed.text.includes(w.charlie.id), false, `list_groups (mine=${mine}) exposed an out-of-scope member`);
        assert.ok(listed.text.includes(w.bravo.id));
    }
    const groups = await import("@/app/api/mcp/groups/route");
    for (const query of ["", "?mine=1"]) {
        const res = await call(groups.GET, `/api/mcp/groups${query}`, { headers: w.alphaToken });
        assert.equal(res.status, 200);
        assert.equal(res.text.includes(w.charlie.id), false, `GET /api/mcp/groups${query} exposed an out-of-scope member`);
        assert.ok(res.text.includes(group.id));
    }
    // An unrestricted agent still sees every member.
    const res = await call(groups.GET, "/api/mcp/groups", { headers: w.charlieToken });
    assert.ok(res.text.includes(w.alpha.id) && res.text.includes(w.charlie.id));
});

maybe("name squat: an in-scope agent named after an out-of-scope id unlocks nothing", async () => {
    const w = await world();
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ name: w.charlie.id }).where(eq(agents.id, w.bravo.id));
    const read = await import("@/app/api/mcp/agents/[id]/route");
    const res = await call(read.GET, `/api/mcp/agents/${w.charlie.id}`, { headers: w.alphaToken, params: { id: w.charlie.id } });
    assert.equal(res.status, 404, "budget read of an out-of-scope agent via a squatted name");
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    assert.equal((await client.tool("create_task", { projectId: w.projectIn.id, taskType: "x", assignedAgentId: w.charlie.id })).isError, true);
    // Names still resolve for in-scope agents.
    const byName = await call(read.GET, "/api/mcp/agents/Alpha", { headers: w.alphaToken, params: { id: "Alpha" } });
    assert.equal(byName.status, 200);
    assert.equal((byName.json.agent as { id: string }).id, w.alpha.id);
});

maybe("scope PATCH without agentIds keeps the agent restricted", async () => {
    const w = await world();
    const route = await import("@/app/api/agents/[id]/route");
    actAs(await seedHuman(w.companyId, "admin"));
    const saved = await call(route.PATCH, `/api/agents/${w.alpha.id}`, { method: "PATCH", params: { id: w.alpha.id }, body: { scopeJson: { mode: "restricted", customerIds: [w.customerIn.id], projectIds: [] } } });
    assert.equal(saved.status, 200);
    assert.deepEqual((saved.json.agent as { scopeJson: { agentIds?: string[] } }).scopeJson.agentIds, [w.bravo.id], "omitting agentIds silently lifted the restriction");
    actAs(null);
});

maybe("project purpose notes are capped and not duplicated", async () => {
    const w = await world();
    const { createProjectForCompany, updateProjectForCompany } = await import("@/lib/projects-crud");
    const PROJECT_PURPOSE_MAX = 4000;
    const project = await createProjectForCompany({ companyId: w.companyId, goal: "Capped", description: "y".repeat(PROJECT_PURPOSE_MAX * 3) });
    await updateProjectForCompany({ companyId: w.companyId, projectId: project.id, description: "Same purpose" });
    await updateProjectForCompany({ companyId: w.companyId, projectId: project.id, description: "Same purpose" });
    const db = await getDb();
    const { projectMemory } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const notes = await db.select().from(projectMemory).where(eq(projectMemory.projectId, project.id));
    assert.equal(notes.length, 2, "an unchanged purpose was saved again");
    for (const note of notes) assert.ok(note.content.length <= PROJECT_PURPOSE_MAX + 20, `purpose note is ${note.content.length} chars`);
});

maybe("project lead and direct threads: a restricted agent can't name an out-of-scope agent", async () => {
    const w = await world();
    const client = await mcpClientFor(w.companyId, w.alpha.id);
    assert.equal((await client.tool("create_project", { goal: "Lead probe", leadAgentId: w.charlie.id })).isError, true, "create_project with an out-of-scope lead");
    const ok = await client.tool("create_project", { goal: "Lead ok", leadAgentId: w.bravo.id });
    assert.equal(ok.isError, false);
    const projectId = JSON.parse(ok.text).project.id as string;
    assert.equal((await client.tool("update_project", { projectId, leadAgentId: ` ${w.charlie.id}` })).isError, true, "update_project with a padded out-of-scope lead");

    const create = await import("@/app/api/mcp/projects/route");
    assert.equal((await call(create.POST, "/api/mcp/projects", { method: "POST", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, body: { goal: "Lead REST", leadAgentId: w.charlie.id } })).status, 403);
    const patch = await import("@/app/api/mcp/projects/[projectId]/route");
    assert.equal((await call(patch.PATCH, `/api/mcp/projects/${projectId}`, { method: "PATCH", headers: { ...w.alphaToken, "Idempotency-Key": randomUUID() }, params: { projectId }, body: { leadAgentId: w.charlie.id } })).status, 403);

    const threads = await import("@/app/api/mcp/threads/route");
    assert.equal((await call(threads.POST, "/api/mcp/threads", { method: "POST", headers: w.alphaToken, body: { type: "direct", agentId: w.charlie.id } })).status, 403);
    assert.equal((await call(threads.POST, "/api/mcp/threads", { method: "POST", headers: w.alphaToken, body: { type: "direct", agentId: w.bravo.id } })).status, 201);
});
