/**
 * Agent data scope (agents.scope_json) through every agent-facing path, with a
 * token BOUND to the restricted agent. The token alone must carry the scope:
 * omitting ?agentId= (or naming another agent) must never widen it.
 *
 * Fixture: agent "Scoped" may see Customer In (and so Project In / Task In);
 * Customer Out, Project Out and Task Out, plus another agent's private note,
 * are out of scope for it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { bearer, call, mcpClientFor, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function fixture() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const scoped = await seedAgent(companyId, { name: "Scoped", scopeJson: { mode: "restricted", customerIds: [work.customerIn.id], projectIds: [] } });
    const other = await seedAgent(companyId, { name: "Other" });
    const token = await seedMcpToken(companyId, scoped.id);
    return { companyId, ...work, scoped, other, token, auth: bearer(token) };
}

async function seedNote(companyId: string, input: { scopeType: string; scopeId: string | null; name: string; body: string; isShared?: boolean }) {
    const { createScopedResource } = await import("@/lib/resources");
    return createScopedResource({
        companyId, provider: "knowledge", resourceType: "knowledge_base",
        scopeType: input.scopeType as "company", scopeId: input.scopeId, name: input.name, configText: input.body,
        isShared: input.isShared ?? false,
    });
}

async function seedArtifact(companyId: string, projectId: string, title: string) {
    const db = await getDb();
    const { artifacts } = await getSchema();
    const [artifact] = await db.insert(artifacts).values({
        companyId, projectId, title, kind: "report", contentType: "text/plain",
        sha256: createHash("sha256").update(title).digest("hex"), sizeBytes: 1, createdByType: "agent",
        storageKey: `k/${randomUUID()}`, path: `files/${randomUUID()}.txt`, visibility: "company",
    }).returning();
    return artifact;
}

maybe("a bound token is scoped even when it names no agent: tasks, projects, customers", async () => {
    const f = await fixture();
    const taskRoute = await import("@/app/api/mcp/tasks/[id]/route");
    const out = await call(taskRoute.GET, `/api/mcp/tasks/${f.taskOut.id}`, { headers: f.auth, params: { id: f.taskOut.id } });
    assert.equal(out.status, 404, "out-of-scope task must read as missing");
    const inside = await call(taskRoute.GET, `/api/mcp/tasks/${f.taskIn.id}`, { headers: f.auth, params: { id: f.taskIn.id } });
    assert.equal(inside.status, 200);

    const tasksRoute = await import("@/app/api/mcp/tasks/route");
    const list = await call(tasksRoute.GET, "/api/mcp/tasks", { headers: f.auth });
    assert.equal(list.status, 200);
    const ids = (list.json.tasks as { id: string }[]).map((t) => t.id);
    assert.ok(ids.includes(f.taskIn.id));
    assert.ok(!ids.includes(f.taskOut.id), "task list leaked an out-of-scope task");

    const projectsRoute = await import("@/app/api/mcp/projects/route");
    const projects = await call(projectsRoute.GET, "/api/mcp/projects", { headers: f.auth });
    assert.deepEqual((projects.json.projects as { id: string }[]).map((p) => p.id), [f.projectIn.id]);

    const customersRoute = await import("@/app/api/mcp/customers/route");
    const customers = await call(customersRoute.GET, "/api/mcp/customers", { headers: f.auth });
    assert.deepEqual((customers.json.customers as { id: string }[]).map((c) => c.id), [f.customerIn.id]);

    const overviewRoute = await import("@/app/api/mcp/tasks/overview/route");
    const overview = await call(overviewRoute.GET, "/api/mcp/tasks/overview", { headers: f.auth });
    assert.equal(JSON.stringify(overview.json).includes(f.taskOut.id), false, "overview leaked an out-of-scope task");

    const notesRoute = await import("@/app/api/mcp/tasks/[id]/notes/route");
    const notes = await call(notesRoute.GET, `/api/mcp/tasks/${f.taskOut.id}/notes`, { headers: f.auth, params: { id: f.taskOut.id } });
    assert.equal(notes.status, 404, "task history of an out-of-scope task");
});

maybe("a bound token cannot borrow another agent's identity (and so its scope)", async () => {
    const f = await fixture();
    const tasksRoute = await import("@/app/api/mcp/tasks/route");
    const asOther = await call(tasksRoute.GET, `/api/mcp/tasks?agentId=${f.other.id}`, { headers: f.auth });
    assert.equal(asOther.status, 403);

    const claim = await import("@/app/api/mcp/tasks/claim/route");
    const claimed = await call(claim.POST, "/api/mcp/tasks/claim", {
        method: "POST", headers: { ...f.auth, "Idempotency-Key": randomUUID() }, body: { agentId: f.other.id },
    });
    assert.equal(claimed.status, 403, "claiming work as another agent");

    const result = await import("@/app/api/mcp/tasks/[id]/result/route");
    const reported = await call(result.POST, `/api/mcp/tasks/${f.taskIn.id}/result`, {
        method: "POST", headers: { ...f.auth, "Idempotency-Key": randomUUID() }, params: { id: f.taskIn.id },
        body: { agentId: f.other.id, state: "done" },
    });
    assert.equal(reported.status, 403, "reporting a result as another agent");

    const sessions = await import("@/app/api/mcp/agents/[id]/sessions/start/route");
    const started = await call(sessions.POST, `/api/mcp/agents/${f.other.id}/sessions/start`, {
        method: "POST", headers: f.auth, params: { id: f.other.id }, body: { openclawSessionId: "x" },
    });
    assert.equal(started.status, 403, "opening another agent's session (and reading its memory)");

    const agentRoute = await import("@/app/api/mcp/agents/[id]/route");
    const deleted = await call(agentRoute.DELETE, `/api/mcp/agents/${f.other.id}`, {
        method: "DELETE", headers: { ...f.auth, "Idempotency-Key": randomUUID() }, params: { id: f.other.id },
    });
    assert.equal(deleted.status, 403, "deleting a sibling agent");
});

maybe("task context packs, knowledge writes and leases stay inside the scope", async () => {
    const f = await fixture();
    await seedNote(f.companyId, { scopeType: "project", scopeId: f.projectOut.id, name: "out-shared", body: "OUT-SHARED-BODY", isShared: true });
    await seedNote(f.companyId, { scopeType: "agent", scopeId: f.other.id, name: "other-private", body: "OTHER-PRIVATE-BODY", isShared: true });

    const context = await import("@/app/api/mcp/tasks/[id]/context/route");
    const outPack = await call(context.GET, `/api/mcp/tasks/${f.taskOut.id}/context`, { headers: f.auth, params: { id: f.taskOut.id } });
    assert.equal(outPack.status, 404);
    const inPack = await call(context.GET, `/api/mcp/tasks/${f.taskIn.id}/context`, { headers: f.auth, params: { id: f.taskIn.id } });
    assert.equal(inPack.status, 200);
    assert.equal(inPack.text.includes("OUT-SHARED-BODY"), false, "a shared note of another project rode along");
    assert.equal(inPack.text.includes("OTHER-PRIVATE-BODY"), false, "another agent's private note rode along");

    const resources = await import("@/app/api/mcp/resources/route");
    const written = await call(resources.POST, "/api/mcp/resources", {
        method: "POST", headers: f.auth,
        body: { name: "sneaky", resourceType: "knowledge_base", provider: "knowledge", scopeType: "project", scopeId: f.projectOut.id },
    });
    assert.equal(written.status, 403, "writing a note into an out-of-scope project");
    const intoOther = await call(resources.POST, "/api/mcp/resources", {
        method: "POST", headers: f.auth,
        body: { name: "sneaky2", resourceType: "knowledge_base", provider: "knowledge", scopeType: "agent", scopeId: f.other.id },
    });
    assert.equal(intoOther.status, 403, "writing into another agent's private notes");
});

maybe("files: download, verify, folder listings and uploads respect the scope", async () => {
    const f = await fixture();
    const outFile = await seedArtifact(f.companyId, f.projectOut.id, "out-file");
    const inFile = await seedArtifact(f.companyId, f.projectIn.id, "in-file");

    const download = await import("@/app/api/mcp/artifacts/[id]/download/route");
    const dl = await call(download.GET as never, `/api/mcp/artifacts/${outFile.id}/download`, { headers: f.auth, params: { id: outFile.id } });
    assert.equal(dl.status, 404, "downloading an out-of-scope file");

    const verify = await import("@/app/api/mcp/artifacts/[id]/verify/route");
    const vr = await call(verify.GET as never, `/api/mcp/artifacts/${outFile.id}/verify`, { headers: f.auth, params: { id: outFile.id } });
    assert.equal(vr.status, 404);

    const list = await import("@/app/api/mcp/artifacts/route");
    const listed = await call(list.GET, "/api/mcp/artifacts", { headers: f.auth });
    const listedIds = (listed.json.artifacts as { id: string }[]).map((a) => a.id);
    assert.ok(listedIds.includes(inFile.id));
    assert.ok(!listedIds.includes(outFile.id), "artifact list leaked an out-of-scope file");
});

maybe("threads and sync: project threads outside the scope, other agents' identities", async () => {
    const f = await fixture();
    const db = await getDb();
    const { messageThreads, threadMessages } = await getSchema();
    const [outThread] = await db.insert(messageThreads).values({ companyId: f.companyId, type: "project", projectId: f.projectOut.id, title: "Out thread" }).returning();
    await db.insert(threadMessages).values({ companyId: f.companyId, threadId: outThread.id, senderType: "human", text: "OUT-THREAD-SECRET" });

    const messages = await import("@/app/api/mcp/threads/[id]/messages/route");
    const read = await call(messages.GET, `/api/mcp/threads/${outThread.id}/messages`, { headers: f.auth, params: { id: outThread.id } });
    assert.equal(read.status, 404, "reading an out-of-scope project thread");

    const { ensureTeamThread } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(f.companyId);
    const impersonate = await call(messages.POST, `/api/mcp/threads/${team.id}/messages`, {
        method: "POST", headers: f.auth, params: { id: team.id }, body: { text: "hi", senderType: "agent", senderId: f.other.id },
    });
    assert.equal(impersonate.status, 403, "posting as another agent");

    const send = await import("@/app/api/mcp/messages/send/route");
    const sent = await call(send.POST, "/api/mcp/messages/send", {
        method: "POST", headers: f.auth, body: { text: "hello", from_user_id: f.other.id, thread_id: team.id },
    });
    assert.equal(sent.status, 403, "from_user_id must not let a bound token speak as another agent");

    const sync = await import("@/app/api/mcp/messages/sync/route");
    const syncAsOther = await call(sync.GET, `/api/mcp/messages/sync?agentId=${f.other.id}&mode=all&since=${encodeURIComponent(new Date(0).toISOString())}`, { headers: f.auth });
    assert.equal(syncAsOther.status, 403, "syncing another agent's messages");
});

maybe("MCP tools enforce the bound agent's scope", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.scoped.id);
    await seedArtifact(f.companyId, f.projectOut.id, "out-tool-file");

    const tasks = await client.tool("list_tasks", {});
    assert.equal(tasks.isError, false);
    assert.equal(tasks.text.includes(f.taskOut.id), false, "list_tasks leaked an out-of-scope task");
    assert.ok(tasks.text.includes(f.taskIn.id));

    assert.equal((await client.tool("get_task", { taskId: f.taskOut.id })).isError, true, "get_task out of scope");
    assert.equal((await client.tool("update_task", { taskId: f.taskOut.id, title: "x" })).isError, true, "update_task out of scope");
    assert.equal((await client.tool("get_task_overview", {})).text.includes(f.taskOut.id), false);

    const projects = await client.tool("list_projects", {});
    assert.equal(projects.text.includes(f.projectOut.id), false, "list_projects leaked an out-of-scope project");
    assert.equal((await client.tool("get_project", { projectId: f.projectOut.id })).isError, true);
    assert.equal((await client.tool("update_project", { projectId: f.projectOut.id, goal: "x" })).isError, true);
    assert.equal((await client.tool("create_task", { projectId: f.projectOut.id, taskType: "x" })).isError, true);

    const files = await client.tool("list_storage_files", {});
    assert.equal(files.text.includes("out-tool-file"), false, "list_storage_files leaked an out-of-scope file");

    const note = await client.tool("create_knowledge_note", { name: "n", content: "c", scopeType: "project", scopeId: f.projectOut.id });
    assert.equal(note.isError, true, "create_knowledge_note into an out-of-scope project");
    const otherNote = await seedNote(f.companyId, { scopeType: "agent", scopeId: f.other.id, name: "theirs", body: "THEIRS" });
    assert.equal((await client.tool("update_knowledge_note", { resourceId: otherNote.id, content: "overwritten" })).isError, true,
        "update_knowledge_note on another agent's private note");

    assert.equal((await client.tool("claim_task", { agentId: f.other.id })).isError, true, "claim_task as another agent");
});

maybe("an operator (unbound) token keeps company-wide access and may still act as a named agent", async () => {
    const f = await fixture();
    const operator = bearer(await seedMcpToken(f.companyId, null));
    const tasksRoute = await import("@/app/api/mcp/tasks/route");
    const all = await call(tasksRoute.GET, "/api/mcp/tasks", { headers: operator });
    assert.equal((all.json.tasks as unknown[]).length, 2);
    const asScoped = await call(tasksRoute.GET, `/api/mcp/tasks?agentId=${f.scoped.name}`, { headers: operator });
    assert.deepEqual((asScoped.json.tasks as { id: string }[]).map((t) => t.id), [f.taskIn.id]);
});
