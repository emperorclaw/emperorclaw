import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

async function createNote(companyId: string, input: Record<string, unknown>) {
    const { createScopedResource } = await import("@/lib/resources");
    return createScopedResource({
        companyId,
        provider: "knowledge",
        resourceType: "knowledge_base",
        ...input,
    } as Parameters<typeof createScopedResource>[0]);
}

/** Connect an in-process MCP client so tool results are exercised end-to-end. */
async function mcpClient(companyId: string, callerAgentId: string | null) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { buildMcpServer } = await import("@/lib/mcp-server");
    const server = await buildMcpServer(companyId, callerAgentId, null);
    const client = new Client({ name: "test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

async function callJson(client: Awaited<ReturnType<typeof mcpClient>>, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args });
    const block = (result.content as { type: string; text: string }[])[0];
    return { result, json: JSON.parse(block.text) as Record<string, unknown>, raw: block.text };
}

maybe("no secret field reaches agents through list or context endpoints", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Lister" });
    const note = await createNote(companyId, {
        scopeType: "company",
        name: "Credentials note",
        configText: "public doctrine body",
        secretText: "sk-live-super-secret",
    });

    // The list projection never even loads the secret column.
    const { listScopedResources } = await import("@/lib/resources");
    const rows = await listScopedResources({ companyId });
    assert.ok(rows.some((row) => row.id === note.id));
    for (const row of rows) assert.equal("secretText" in row, false);

    // REST list + single-resource read are sanitized.
    const listRoute = await import("@/app/api/mcp/resources/route");
    const list = await (await listRoute.GET(makeRequest(`http://localhost/api/mcp/resources?agentId=${agent.name}`, { headers: auth(rawToken) }))).json();
    assert.equal(JSON.stringify(list).includes("sk-live-super-secret"), false);
    for (const resource of list.resources) assert.equal("secretText" in resource, false);

    const idRoute = await import("@/app/api/mcp/resources/[id]/route");
    const params = { params: Promise.resolve({ id: note.id }) };
    const single = await (await idRoute.GET(makeRequest(`http://localhost/api/mcp/resources/${note.id}?agentId=${agent.name}`, { headers: auth(rawToken) }), params)).json();
    assert.equal(JSON.stringify(single).includes("sk-live-super-secret"), false);
    assert.equal("secretText" in single.resource, false);

    // Task context packs are fetched by runtimes too.
    const { tasks, projects } = await import("@/db/schema");
    const { getDb } = await import("./_helper");
    const db = await getDb();
    const [project] = await db.insert(projects).values({ companyId, goal: "Pack", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "work", state: "in_progress" }).returning();
    const contextRoute = await import("@/app/api/mcp/tasks/[id]/context/route");
    const pack = await (await contextRoute.GET(makeRequest(`http://localhost/api/mcp/tasks/${task.id}/context`, { headers: auth(rawToken) }), { params: Promise.resolve({ id: task.id }) })).json();
    assert.equal(JSON.stringify(pack).includes("sk-live-super-secret"), false);

    // MCP tools: list_knowledge returns index fields only, context is sanitized.
    const client = await mcpClient(companyId, agent.id);
    const listed = await callJson(client, "list_knowledge", {});
    assert.equal(listed.raw.includes("sk-live-super-secret"), false);
    assert.equal(listed.raw.includes("public doctrine body"), false, "list_knowledge must not return note bodies");
    const listedResources = listed.json.resources as Record<string, unknown>[];
    for (const resource of listedResources) {
        assert.equal("secretText" in resource, false);
        assert.equal("configText" in resource, false);
    }
    const context = await callJson(client, "get_knowledge_context", {});
    assert.equal(context.raw.includes("sk-live-super-secret"), false);
});

maybe("an agent cannot read another agent's agent-scoped note by id through either path", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const viewer = await seedAgent(companyId, { name: "Viewer" });
    const owner = await seedAgent(companyId, { name: "Owner" });
    const otherNote = await createNote(companyId, {
        scopeType: "agent",
        scopeId: owner.id,
        name: "Owner private note",
        configText: "owner-only secret sauce",
        secretText: "sk-owner",
    });
    const ownNote = await createNote(companyId, {
        scopeType: "agent",
        scopeId: viewer.id,
        name: "Viewer note",
        configText: "viewer sees this",
    });

    // Path 1: get_knowledge_context with an explicit out-of-scope resourceId.
    const client = await mcpClient(companyId, viewer.id);
    const context = await callJson(client, "get_knowledge_context", { resourceIds: [otherNote.id] });
    const selectedIds = (context.json.resources as { id: string }[]).map((resource) => resource.id);
    assert.equal(selectedIds.includes(otherNote.id), false);
    assert.equal(context.raw.includes("owner-only secret sauce"), false);

    // list_knowledge must not enumerate it either.
    const listed = await callJson(client, "list_knowledge", { scopeType: "agent", scopeId: owner.id });
    const listedIds = (listed.json.resources as { id: string }[]).map((resource) => resource.id);
    assert.equal(listedIds.includes(otherNote.id), false);
    assert.equal(listed.raw.includes("owner-only secret sauce"), false);

    // Path 2: GET /api/mcp/resources/{id}.
    const idRoute = await import("@/app/api/mcp/resources/[id]/route");
    const denied = await idRoute.GET(
        makeRequest(`http://localhost/api/mcp/resources/${otherNote.id}?agentId=${viewer.name}`, { headers: auth(rawToken) }),
        { params: Promise.resolve({ id: otherNote.id }) },
    );
    assert.equal(denied.status, 404);
    const allowed = await idRoute.GET(
        makeRequest(`http://localhost/api/mcp/resources/${ownNote.id}?agentId=${viewer.name}`, { headers: auth(rawToken) }),
        { params: Promise.resolve({ id: ownNote.id }) },
    );
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).resource.id, ownNote.id);
});

maybe("free-text search matches a word that only appears in the note body", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const unique = `zorptastic${randomUUID().slice(0, 8)}`;
    const note = await createNote(companyId, {
        scopeType: "company",
        name: "Quarterly plan",
        configText: `# Quarterly plan\n\nThe strategy hinges on the ${unique} initiative.`,
    });

    const { listScopedResources } = await import("@/lib/resources");
    const byBody = await listScopedResources({ companyId, search: unique });
    assert.deepEqual(byBody.map((row) => row.id), [note.id]);

    const byName = await listScopedResources({ companyId, search: "Quarterly" });
    assert.ok(byName.some((row) => row.id === note.id));

    // The MCP list_knowledge tool uses the same search.
    const client = await mcpClient(companyId, null);
    const listed = await callJson(client, "list_knowledge", { search: unique });
    assert.deepEqual((listed.json.resources as { id: string }[]).map((resource) => resource.id), [note.id]);
});
