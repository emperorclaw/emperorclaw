/**
 * Agents choosing the Knowledge & Rules folder: create_knowledge_note /
 * update_knowledge_note `folder`, list_knowledge `folder` filter,
 * list_knowledge_folders, and the REST twins (POST/PATCH /api/mcp/resources,
 * GET /api/mcp/knowledge/folders).
 *
 * Fixture: agent "Scoped" may see Customer In (and Project In); Customer Out
 * and Project Out are outside its scope. "Free" is an unrestricted agent.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { bearer, call, mcpClientFor, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

type FolderNode = { path: string; name: string; directCount: number; totalCount: number; children: FolderNode[] };

async function fixture() {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const scoped = await seedAgent(companyId, { name: "Scoped", scopeJson: { mode: "restricted", customerIds: [work.customerIn.id], projectIds: [] } });
    const free = await seedAgent(companyId, { name: "Free" });
    const scopedToken = await seedMcpToken(companyId, scoped.id);
    return { companyId, ...work, scoped, free, scopedAuth: bearer(scopedToken) };
}

async function seedNote(companyId: string, input: { scopeType: string; scopeId: string | null; name: string; path: string }) {
    const { createScopedResource } = await import("@/lib/resources");
    return createScopedResource({
        companyId, provider: "knowledge", resourceType: "knowledge_base",
        scopeType: input.scopeType, scopeId: input.scopeId, name: input.name, configText: `# ${input.name}`, path: input.path,
    });
}

async function notePath(companyId: string, id: string) {
    const { getScopedResource } = await import("@/lib/resources");
    return (await getScopedResource(companyId, id))?.path;
}

function json<T = Record<string, unknown>>(result: { isError: boolean; text: string }): T {
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text) as T;
}

function flatten(nodes: FolderNode[]): FolderNode[] {
    return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

maybe("create files into an existing folder, and a missing path creates every level", async () => {
    const f = await fixture();
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "existing", path: "Company/Legal" });
    const client = await mcpClientFor(f.companyId, f.free.id);

    const intoExisting = json<{ resource: { id: string; path: string } }>(await client.tool("create_knowledge_note", { name: "nda", content: "# NDA", folder: "Company/Legal" }));
    assert.equal(intoExisting.resource.path, "Company/Legal");

    const created = json<{ resource: { id: string; path: string } }>(await client.tool("create_knowledge_note", {
        name: "minutes", content: "# Minutes", scopeType: "customer", scopeId: f.customerIn.id, folder: " /Customers//Customer In/ Meetings/ ",
    }));
    assert.equal(created.resource.path, "Customers/Customer In/Meetings");
    assert.equal(await notePath(f.companyId, created.resource.id), "Customers/Customer In/Meetings");

    const tree = json<{ totalNotes: number; rootNotes: number; folders: FolderNode[] }>(await client.tool("list_knowledge_folders", {}));
    const byPath = new Map(flatten(tree.folders).map((node) => [node.path, node]));
    assert.equal(byPath.get("Company/Legal")?.directCount, 2);
    assert.equal(byPath.get("Customers")?.totalCount, 1, "missing parent folders appear with rolled-up counts");
    assert.equal(byPath.get("Customers/Customer In/Meetings")?.directCount, 1);
    assert.equal(tree.totalNotes, 3);
    assert.equal(tree.rootNotes, 0);

    const bad = await client.tool("create_knowledge_note", { name: "x", content: "x", folder: "Company/../Secret" });
    assert.equal(bad.isError, true, "traversal is rejected, not silently dropped");
    assert.match(bad.text, /"\.\."/);
});

maybe("without a folder, a customer/project note defaults to its convention folder only when the vault uses it", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.free.id);

    const before = json<{ resource: { path: string } }>(await client.tool("create_knowledge_note", { name: "pref", content: "x", scopeType: "customer", scopeId: f.customerIn.id }));
    assert.equal(before.resource.path, "", "no Customers/ convention yet: root, as before");

    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "template", path: "Customers" });
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "brief", path: "Projects" });
    const customerNote = json<{ resource: { path: string } }>(await client.tool("create_knowledge_note", { name: "pref2", content: "x", scopeType: "customer", scopeId: f.customerIn.id }));
    assert.equal(customerNote.resource.path, "Customers/Customer In");
    const projectNote = json<{ resource: { path: string } }>(await client.tool("create_knowledge_note", { name: "conv", content: "x", scopeType: "project", scopeId: f.projectIn.id }));
    assert.equal(projectNote.resource.path, "Projects/Project In");
    const companyNote = json<{ resource: { path: string } }>(await client.tool("create_knowledge_note", { name: "rule", content: "x" }));
    assert.equal(companyNote.resource.path, "", "company notes keep today's behaviour");
});

maybe("update moves a note, list_knowledge filters by folder", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.free.id);
    const a = await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "a", path: "Ops" });
    const b = await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "b", path: "Ops/Runbooks" });
    const c = await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "c", path: "" });

    const moved = json<{ resource: { path: string } }>(await client.tool("update_knowledge_note", { resourceId: c.id, folder: "Ops/Archive" }));
    assert.equal(moved.resource.path, "Ops/Archive");
    const untouched = json<{ resource: { path: string } }>(await client.tool("update_knowledge_note", { resourceId: a.id, content: "# a2" }));
    assert.equal(untouched.resource.path, "Ops", "omitting folder leaves the note where it is");
    assert.equal((await client.tool("update_knowledge_note", { resourceId: a.id, folder: "../x" })).isError, true);

    const subtree = json<{ resources: { id: string; path: string }[] }>(await client.tool("list_knowledge", { folder: "Ops" }));
    assert.deepEqual(subtree.resources.map((r) => r.id).sort(), [a.id, b.id, c.id].sort());
    const exact = json<{ resources: { id: string }[] }>(await client.tool("list_knowledge", { folder: "/Ops/", recursive: false }));
    assert.deepEqual(exact.resources.map((r) => r.id), [a.id]);

    const toRoot = json<{ resource: { path: string } }>(await client.tool("update_knowledge_note", { resourceId: b.id, folder: "/" }));
    assert.equal(toRoot.resource.path, "");
});

maybe("a scoped agent can neither see nor write into an out-of-scope customer's folder (MCP)", async () => {
    const f = await fixture();
    // By convention: a company note filed under the out-of-scope customer.
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "out-conv", path: "Customers/Customer Out" });
    // By content: a folder whose notes all belong to an out-of-scope project.
    await seedNote(f.companyId, { scopeType: "project", scopeId: f.projectOut.id, name: "out-proj", path: "Deals/Big" });
    await seedNote(f.companyId, { scopeType: "customer", scopeId: f.customerIn.id, name: "in-note", path: "Customers/Customer In" });
    const own = await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "own", path: "Company" });
    const client = await mcpClientFor(f.companyId, f.scoped.id);

    const tree = json<{ folders: FolderNode[] }>(await client.tool("list_knowledge_folders", {}));
    const paths = flatten(tree.folders).map((node) => node.path);
    assert.ok(paths.includes("Customers/Customer In"));
    assert.ok(!paths.includes("Customers/Customer Out"), "convention folder of an out-of-scope customer leaked");
    assert.ok(!paths.includes("Deals/Big") && !paths.includes("Deals"), "folder of an out-of-scope project leaked");

    for (const folder of ["Customers/Customer Out", "customers/customer out/Meetings", "Deals/Big"]) {
        const created = await client.tool("create_knowledge_note", { name: "sneaky", content: "x", folder });
        assert.equal(created.isError, true, `create into ${folder}`);
        assert.match(created.text, /Choose a folder you can use: list_knowledge_folders shows them/);
        assert.equal((await client.tool("update_knowledge_note", { resourceId: own.id, folder })).isError, true, `move into ${folder}`);
        // As a filter an off-limits folder simply matches nothing.
        assert.deepEqual(json<{ resources: unknown[] }>(await client.tool("list_knowledge", { folder })).resources, [], `filter by ${folder}`);
    }
    assert.equal(await notePath(f.companyId, own.id), "Company", "a refused move must not move the note");

    const allowed = json<{ resource: { path: string } }>(await client.tool("create_knowledge_note", {
        name: "ok", content: "x", scopeType: "customer", scopeId: f.customerIn.id, folder: "Customers/Customer In/Meetings",
    }));
    assert.equal(allowed.resource.path, "Customers/Customer In/Meetings");

    // The unrestricted agent still sees everything.
    const freeTree = json<{ folders: FolderNode[] }>(await (await mcpClientFor(f.companyId, f.free.id)).tool("list_knowledge_folders", {}));
    assert.ok(flatten(freeTree.folders).some((node) => node.path === "Deals/Big"));
});

maybe("REST routes accept folder with the same scope rules", async () => {
    const f = await fixture();
    await seedNote(f.companyId, { scopeType: "project", scopeId: f.projectOut.id, name: "out-proj", path: "Deals/Big" });
    const resources = await import("@/app/api/mcp/resources/route");
    const resource = await import("@/app/api/mcp/resources/[id]/route");
    const folders = await import("@/app/api/mcp/knowledge/folders/route");
    const base = { resourceType: "knowledge_base", provider: "knowledge" };

    const created = await call(resources.POST, "/api/mcp/resources", {
        method: "POST", headers: f.scopedAuth, body: { ...base, name: "rest", configText: "# r", folder: "Company/Playbooks//" },
    });
    assert.equal(created.status, 201, created.text);
    const id = (created.json.resource as { id: string; path: string }).id;
    assert.equal((created.json.resource as { path: string }).path, "Company/Playbooks");

    const legacy = await call(resources.POST, "/api/mcp/resources", {
        method: "POST", headers: f.scopedAuth, body: { ...base, name: "legacy", path: "/Company/Legacy/" },
    });
    assert.equal((legacy.json.resource as { path: string }).path, "Company/Legacy", "legacy path still works");

    const invalid = await call(resources.POST, "/api/mcp/resources", {
        method: "POST", headers: f.scopedAuth, body: { ...base, name: "bad", folder: "a/../b" },
    });
    assert.equal(invalid.status, 400);
    for (const folder of ["Customers/Customer Out", "Deals/Big"]) {
        const out = await call(resources.POST, "/api/mcp/resources", {
            method: "POST", headers: f.scopedAuth, body: { ...base, name: "sneaky", folder },
        });
        assert.equal(out.status, 404, `REST create into ${folder}`);
    }

    const moved = await call(resource.PATCH, `/api/mcp/resources/${id}`, {
        method: "PATCH", headers: f.scopedAuth, params: { id }, body: { folder: "Company/Archive" },
    });
    assert.equal(moved.status, 200, moved.text);
    assert.equal((moved.json.resource as { path: string }).path, "Company/Archive");
    const sneakyMove = await call(resource.PATCH, `/api/mcp/resources/${id}`, {
        method: "PATCH", headers: f.scopedAuth, params: { id }, body: { path: "Deals/Big" },
    });
    assert.equal(sneakyMove.status, 404, "legacy path is scope-checked too");
    const rescope = await call(resource.PATCH, `/api/mcp/resources/${id}`, {
        method: "PATCH", headers: f.scopedAuth, params: { id }, body: { scopeType: "project", scopeId: f.projectOut.id },
    });
    assert.equal(rescope.status, 403, "re-scoping a note into an out-of-scope project");
    assert.equal(await notePath(f.companyId, id), "Company/Archive");

    const tree = await call(folders.GET, "/api/mcp/knowledge/folders", { headers: f.scopedAuth });
    assert.equal(tree.status, 200, tree.text);
    const paths = flatten(tree.json.folders as FolderNode[]).map((node) => node.path);
    assert.ok(paths.includes("Company/Archive"));
    assert.ok(!paths.includes("Deals/Big"), "REST folder tree leaked an out-of-scope folder");
});

maybe("folders never cross companies", async () => {
    const f = await fixture();
    const other = await seedCompanyWithToken();
    await seedNote(other.companyId, { scopeType: "company", scopeId: null, name: "theirs", path: "Rivals/Plans" });
    const client = await mcpClientFor(f.companyId, f.free.id);

    const tree = json<{ totalNotes: number; folders: FolderNode[] }>(await client.tool("list_knowledge_folders", {}));
    assert.equal(tree.totalNotes, 0);
    assert.equal(tree.folders.length, 0, "another company's folders leaked");
    const listed = json<{ resources: unknown[] }>(await client.tool("list_knowledge", { folder: "Rivals" }));
    assert.equal(listed.resources.length, 0);

    // Filing into a same-named folder stays inside this company.
    const mine = json<{ resource: { id: string; path: string } }>(await client.tool("create_knowledge_note", { name: "mine", content: "x", folder: "Rivals/Plans" }));
    assert.equal(mine.resource.path, "Rivals/Plans");
    const theirTree = json<{ totalNotes: number }>(await (await mcpClientFor(other.companyId, null)).tool("list_knowledge_folders", {}));
    assert.equal(theirTree.totalNotes, 1);

    const operator = bearer(other.rawToken);
    const folders = await import("@/app/api/mcp/knowledge/folders/route");
    const rest = await call(folders.GET, "/api/mcp/knowledge/folders", { headers: operator });
    assert.equal((rest.json as { totalNotes: number }).totalNotes, 1);
});

maybe("restricted agent: an out-of-scope folder filter is indistinguishable from a missing one", async () => {
    const f = await fixture();
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "out-conv", path: "Customers/Customer Out/Meetings" });
    await seedNote(f.companyId, { scopeType: "project", scopeId: f.projectOut.id, name: "out-proj", path: "Projects/Project Out" });
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "shared", path: "Customers" });
    const client = await mcpClientFor(f.companyId, f.scoped.id);

    const missing = await client.tool("list_knowledge", { folder: "Customers/Nobody Ltd" });
    for (const folder of ["Customers/Customer Out", "Customers/Customer Out/Meetings", "Projects/Project Out", "Clients/Customer Out"]) {
        const out = await client.tool("list_knowledge", { folder });
        assert.deepEqual(out, missing, `filter by ${folder} differs from a missing folder`);
    }
    // A parent filter does not reach into the off-limits subfolder either.
    const parent = json<{ resources: { path: string }[] }>(await client.tool("list_knowledge", { folder: "Customers" }));
    assert.deepEqual(parent.resources.map((r) => r.path), ["Customers"]);

    // REST: same answer for an out-of-scope folder and a missing one.
    const resources = await import("@/app/api/mcp/resources/route");
    const rest = (query: string) => call(resources.GET, `/api/mcp/resources?resourceType=knowledge_base&${query}`, { headers: f.scopedAuth });
    const restMissing = await rest(`folder=${encodeURIComponent("Customers/Nobody Ltd")}`);
    assert.equal(restMissing.status, 200, restMissing.text);
    for (const query of [
        `folder=${encodeURIComponent("Customers/Customer Out")}`,
        `pathPrefix=${encodeURIComponent("customers/customer out")}`,
        `path=${encodeURIComponent("Customers/Customer Out/Meetings")}`,
    ]) {
        const out = await rest(query);
        assert.equal(out.status, restMissing.status, query);
        assert.deepEqual(out.json, restMissing.json, `${query} differs from a missing folder`);
    }
    // Raw path params are validated like `folder`.
    assert.equal((await rest(`path=${encodeURIComponent("a/../b")}`)).status, 400);
    assert.equal((await rest(`pathPrefix=${encodeURIComponent("a/../b")}`)).status, 400);
});

maybe("restricted agent: a write refusal reads the same for an existing out-of-scope folder and a missing one", async () => {
    const f = await fixture();
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "out-conv", path: "Customers/Customer Out" });
    const own = await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "own", path: "Company" });
    const client = await mcpClientFor(f.companyId, f.scoped.id);

    const refusals = new Set<string>();
    for (const folder of ["Customers/Customer Out", "Customers/Nobody Ltd", "Clients/Customer Out", "Clients/Ghost Inc", "Projects/Project Out", "Projects/No Such Goal"]) {
        const created = await client.tool("create_knowledge_note", { name: "sneaky", content: "x", folder });
        assert.equal(created.isError, true, `create into ${folder}`);
        refusals.add(created.text);
        const moved = await client.tool("update_knowledge_note", { resourceId: own.id, folder });
        assert.equal(moved.isError, true, `move into ${folder}`);
        refusals.add(moved.text);
    }
    assert.equal(refusals.size, 1, `refusals differ: ${[...refusals].join(" | ")}`);
    assert.match([...refusals][0], /Choose a folder you can use: list_knowledge_folders shows them/);
    assert.equal(await notePath(f.companyId, own.id), "Company");

    const resources = await import("@/app/api/mcp/resources/route");
    const base = { resourceType: "knowledge_base", provider: "knowledge", configText: "# x" };
    const restRefusals = new Set<string>();
    for (const folder of ["Customers/Customer Out", "Customers/Nobody Ltd"]) {
        const out = await call(resources.POST, "/api/mcp/resources", { method: "POST", headers: f.scopedAuth, body: { ...base, name: "sneaky", folder } });
        restRefusals.add(`${out.status} ${out.text}`);
    }
    assert.equal(restRefusals.size, 1, `REST refusals differ: ${[...restRefusals].join(" | ")}`);

    // Its own customer's folder is still fine.
    const ok = json<{ resource: { path: string } }>(await client.tool("create_knowledge_note", {
        name: "ok", content: "x", scopeType: "customer", scopeId: f.customerIn.id, folder: "Clients/Customer In",
    }));
    assert.equal(ok.resource.path, "Clients/Customer In");
});

maybe("restricted agent: the tree leaves out folders of customers/projects it may not use", async () => {
    const f = await fixture();
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "out-conv", path: "Customers/Customer Out" });
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "stale", path: "Customers/Nobody Ltd" });
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "proj", path: "Projects/Project Out/Briefs" });
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "in", path: "Customers/Customer In" });
    const client = await mcpClientFor(f.companyId, f.scoped.id);

    const tree = json<{ totalNotes: number; truncated: boolean; folders: FolderNode[] }>(await client.tool("list_knowledge_folders", {}));
    const paths = flatten(tree.folders).map((node) => node.path).sort();
    assert.deepEqual(paths, ["Customers", "Customers/Customer In"]);
    assert.equal(tree.totalNotes, 1);
    assert.equal(tree.truncated, false);

    const freeTree = json<{ totalNotes: number }>(await (await mcpClientFor(f.companyId, f.free.id)).tool("list_knowledge_folders", {}));
    assert.equal(freeTree.totalNotes, 4, "an unrestricted agent still sees every folder");
});

maybe("restricted agent: convention matching folds NFKC compatibility forms and case", async () => {
    const f = await fixture();
    await seedNote(f.companyId, { scopeType: "company", scopeId: null, name: "out-conv", path: "Customers/Customer Out" });
    const client = await mcpClientFor(f.companyId, f.scoped.id);
    // Full-width forms (U+FF21..) fold to ASCII under NFKC.
    const wide = (text: string) => text.replace(/[A-Za-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));

    // Full-width spellings of an out-of-scope customer folder are refused / match nothing.
    for (const folder of [`${wide("Customers")}/Customer Out`, `CUSTOMERS/${wide("Customer Out")}`]) {
        const created = await client.tool("create_knowledge_note", { name: "sneaky", content: "x", folder });
        assert.equal(created.isError, true, `create into ${folder}`);
        assert.match(created.text, /Choose a folder you can use/);
        assert.deepEqual(json<{ resources: unknown[] }>(await client.tool("list_knowledge", { folder })).resources, []);
    }
    // ...and the agent's own customer matches whatever the spelling.
    const ok = json<{ resource: { path: string } }>(await client.tool("create_knowledge_note", {
        name: "ok", content: "x", scopeType: "customer", scopeId: f.customerIn.id, folder: `${wide("Customers")}/${wide("Customer In")}`,
    }));
    assert.equal(ok.resource.path.normalize("NFKC"), "Customers/Customer In");
});
