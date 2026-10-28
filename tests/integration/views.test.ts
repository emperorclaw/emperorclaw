/**
 * Views (dashboards agents build and keep fresh) through every path: the MCP
 * tools, the /api/mcp/views REST twin the Hermes plugin uses, and the human
 * /api/views routes and lib reads behind the pages.
 *
 * Fixture: agent "Scoped" may see Customer In (and Project In); Customer Out
 * and Project Out are outside its scope. Humans of every role, plus a
 * restricted member limited to Customer In.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function fixture() {
    await resetDb();
    const { companyId, rawToken: operatorToken } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const builder = await seedAgent(companyId, { name: "Builder" });
    const scoped = await seedAgent(companyId, { name: "Scoped", scopeJson: { mode: "restricted", customerIds: [work.customerIn.id], projectIds: [] } });
    const scopedToken = await seedMcpToken(companyId, scoped.id);
    const builderToken = await seedMcpToken(companyId, builder.id);
    const member = await seedHuman(companyId, "member");
    const viewer = await seedHuman(companyId, "viewer");
    const restricted = await seedHuman(companyId, "member", { scope: { mode: "restricted", customerIds: [work.customerIn.id], agentIds: [builder.id] } });
    const admin = await seedHuman(companyId, "admin");
    return { companyId, operatorToken, ...work, builder, scoped, scopedToken, builderToken, member, viewer, restricted, admin };
}

const json = <T>(result: { isError: boolean; text: string }): T => {
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text) as T;
};

type ViewOut = { id: string; title: string; version: number; panels: { id: string; type: string; data: unknown; updatedBy: { name: string | null } | null; updatedAt: string | null }[] };

const PANELS = [
    { id: "revenue", type: "metric", title: "Revenue", data: { value: 12400, unit: "EUR", delta: 8.2, deltaLabel: "vs last month" } },
    { id: "orders", type: "line", title: "Orders per day", data: { series: [{ name: "Orders", points: [{ x: "Mon", y: 4 }, { x: "Tue", y: 7 }] }] } },
    { id: "top", type: "table", title: "Top products", data: { columns: [{ key: "name", label: "Product" }, { key: "units", label: "Units", format: "integer" }], rows: [{ name: "Mug", units: 31 }] } },
];

async function seedView(companyId: string, agentId: string | null, input: Record<string, unknown>) {
    const client = await mcpClientFor(companyId, agentId);
    return json<{ view: ViewOut }>(await client.tool("create_view", { title: "View", panels: [], ...input })).view;
}

maybe("an agent creates a view, refreshes one panel without touching the layout, and updates the layout as a new version", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.builder.id);

    const created = json<{ view: ViewOut; url: string }>(await client.tool("create_view", { title: "Products this month", description: "From the shop, hourly", panels: PANELS }));
    assert.equal(created.view.version, 1);
    assert.equal(created.url, `/views/${created.view.id}`);
    assert.deepEqual(created.view.panels.map((p) => p.id), ["revenue", "orders", "top"]);
    assert.equal(created.view.panels[0].updatedBy?.name, "Builder");
    const viewId = created.view.id;

    // update_panel: values only, no version, the layout row is untouched.
    const db = await getDb();
    const { views, viewVersions, viewPanelData, auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [before] = await db.select().from(views).where(eq(views.id, viewId));
    json(await client.tool("update_panel", { viewId, panelId: "revenue", data: { value: 13100, unit: "EUR", trend: [1, 3, 2, 5] } }));
    const [after] = await db.select().from(views).where(eq(views.id, viewId));
    assert.equal(after.version, 1, "a value refresh never versions");
    assert.deepEqual(after.specJson, before.specJson, "update_panel must not rewrite the layout");
    const got = json<{ view: ViewOut }>(await client.tool("get_view", { viewId }));
    assert.deepEqual((got.view.panels[0].data as { value: number }).value, 13100);

    // Data must match the panel's type; unknown panels are named.
    const wrongShape = await client.tool("update_panel", { viewId, panelId: "orders", data: { value: 1 } });
    assert.equal(wrongShape.isError, true);
    assert.match(wrongShape.text, /Invalid line panel/);
    const unknown = await client.tool("update_panel", { viewId, panelId: "nope", data: { value: 1 } });
    assert.equal(unknown.isError, true);
    assert.match(unknown.text, /revenue \(metric\)/);

    // update_view: a new layout is version 2; dropped panels lose their values.
    const updated = json<{ view: ViewOut }>(await client.tool("update_view", {
        viewId, title: "Products — October", panels: [{ id: "revenue", type: "metric", title: "Revenue", w: 6 }, { id: "notes", type: "markdown", title: "Notes", data: { text: "Stock is **low**" } }],
    }));
    assert.equal(updated.view.version, 2);
    assert.deepEqual(updated.view.panels.map((p) => p.id), ["revenue", "notes"]);
    assert.equal((updated.view.panels[0].data as { value: number }).value, 13100, "kept panels keep their values");
    const dataRows = await db.select().from(viewPanelData).where(eq(viewPanelData.viewId, viewId));
    assert.deepEqual(dataRows.map((r) => r.panelId).sort(), ["notes", "revenue"]);

    // An unchanged update_view is not a version.
    const same = json<{ view: ViewOut }>(await client.tool("update_view", { viewId, title: "Products — October" }));
    assert.equal(same.view.version, 2);
    assert.equal((await db.select().from(viewVersions).where(eq(viewVersions.viewId, viewId))).length, 2);

    // Audit: create + update, titles and shape only, never values.
    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, viewId));
    assert.deepEqual(audits.map((a) => a.action).sort(), ["view.created", "view.updated"]);
    const created_ = audits.find((a) => a.action === "view.created")!;
    assert.equal(created_.actorType, "agent");
    assert.deepEqual((created_.payloadJson as { after: Record<string, unknown> }).after, { title: "Products this month", scopeType: "company", scopeId: null, panelCount: 3, version: 1, visibility: "scope", ownerUserId: null });
    assert.equal(JSON.stringify(audits).includes("12400"), false, "panel values leaked into the audit log");
    assert.equal(JSON.stringify(audits).includes("Mug"), false, "panel values leaked into the audit log");

    // archive_view hides it from the list.
    json(await client.tool("archive_view", { viewId }));
    const list = json<{ views: { id: string }[] }>(await client.tool("list_views", {}));
    assert.equal(list.views.some((v) => v.id === viewId), false);
    assert.equal((await client.tool("update_panel", { viewId, panelId: "revenue", data: { value: 1 } })).isError, true, "an archived view takes no updates");
});

maybe("a scoped agent cannot see or write out-of-scope views, and gets the same answer as for a missing one", async () => {
    const f = await fixture();
    const outView = await seedView(f.companyId, f.builder.id, { title: "Out", scopeType: "customer", scopeId: f.customerOut.id, panels: [PANELS[0]] });
    const outProject = await seedView(f.companyId, f.builder.id, { title: "Out project", scopeType: "project", scopeId: f.projectOut.id });
    const inView = await seedView(f.companyId, f.builder.id, { title: "In", scopeType: "customer", scopeId: f.customerIn.id, panels: [PANELS[0]] });
    const companyView = await seedView(f.companyId, f.builder.id, { title: "Company" });
    const client = await mcpClientFor(f.companyId, f.scoped.id);

    const listed = json<{ views: { id: string }[] }>(await client.tool("list_views", {})).views.map((v) => v.id).sort();
    assert.deepEqual(listed, [inView.id, companyView.id].sort());

    const missing = randomUUID();
    const answers: string[] = [];
    for (const id of [outView.id, outProject.id, missing]) {
        for (const [tool, args] of [
            ["get_view", { viewId: id }],
            ["update_panel", { viewId: id, panelId: "revenue", data: { value: 1 } }],
            ["update_view", { viewId: id, title: "Hijacked" }],
            ["archive_view", { viewId: id }],
        ] as const) {
            const res = await client.tool(tool, args);
            assert.equal(res.isError, true, `${tool} on ${id === missing ? "a missing" : "an out-of-scope"} view`);
            answers.push(res.text);
        }
    }
    assert.deepEqual(new Set(answers), new Set(["View not found"]), "no existence oracle: out-of-scope and missing answer alike");

    // Writing into an out-of-scope scope is refused like a missing one.
    const into = await client.tool("create_view", { title: "x", scopeType: "project", scopeId: f.projectOut.id, panels: [] });
    const intoMissing = await client.tool("create_view", { title: "x", scopeType: "project", scopeId: randomUUID(), panels: [] });
    assert.equal(into.isError, true);
    assert.equal(into.text, intoMissing.text);

    // In scope but built by another agent: readable, not writable (and said plainly, since it can read it).
    json(await client.tool("get_view", { viewId: inView.id }));
    const foreign = await client.tool("update_panel", { viewId: inView.id, panelId: "revenue", data: { value: 2 } });
    assert.equal(foreign.isError, true);
    assert.equal(foreign.text, "Only the agent that built this view (or a person) can change it");
    // Its own in-scope view works.
    const mine = json<{ view: ViewOut }>(await client.tool("create_view", { title: "Mine", scopeType: "customer", scopeId: f.customerIn.id, panels: [PANELS[0]] })).view;
    json(await client.tool("update_panel", { viewId: mine.id, panelId: "revenue", data: { value: 2 } }));

    // The untouched out-of-scope view really was untouched.
    const db = await getDb();
    const { views } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(views).where(eq(views.id, outView.id));
    assert.equal(row.title, "Out");
    assert.equal(row.archivedAt, null);
});

maybe("the REST twin (/api/mcp/views) enforces the same scope with a bound token", async () => {
    const f = await fixture();
    const outView = await seedView(f.companyId, f.builder.id, { title: "Out", scopeType: "customer", scopeId: f.customerOut.id, panels: [PANELS[0]] });
    const auth = bearer(f.scopedToken);
    const listRoute = await import("@/app/api/mcp/views/route");
    const viewRoute = await import("@/app/api/mcp/views/[id]/route");
    const panelRoute = await import("@/app/api/mcp/views/[id]/panels/[panelId]/route");
    const archiveRoute = await import("@/app/api/mcp/views/[id]/archive/route");

    const created = await call(listRoute.POST, "/api/mcp/views", {
        method: "POST", headers: { ...auth, "Idempotency-Key": randomUUID() },
        body: { title: "Finance — last 7 days", panels: [{ id: "cash", type: "metric", title: "Cash", data: { value: 5 } }] },
    });
    assert.equal(created.status, 201, created.text);
    const id = (created.json.view as { id: string }).id;

    const put = await call(panelRoute.PUT, `/api/mcp/views/${id}/panels/cash`, { method: "PUT", headers: auth, body: { data: { value: 6 } }, params: { id, panelId: "cash" } });
    assert.equal(put.status, 200, put.text);
    const bad = await call(panelRoute.PUT, `/api/mcp/views/${id}/panels/cash`, { method: "PUT", headers: auth, body: { data: { value: "<script>x</script>" } }, params: { id, panelId: "cash" } });
    assert.equal(bad.status, 400);

    const list = await call(listRoute.GET, "/api/mcp/views", { headers: auth });
    assert.deepEqual((list.json.views as { id: string }[]).map((v) => v.id), [id]);

    for (const target of [outView.id, randomUUID()]) {
        assert.equal((await call(viewRoute.GET, `/api/mcp/views/${target}`, { headers: auth, params: { id: target } })).status, 404);
        assert.equal((await call(viewRoute.PATCH, `/api/mcp/views/${target}`, { method: "PATCH", headers: auth, body: { title: "x" }, params: { id: target } })).status, 404);
        assert.equal((await call(panelRoute.PUT, `/api/mcp/views/${target}/panels/revenue`, { method: "PUT", headers: auth, body: { data: { value: 1 } }, params: { id: target, panelId: "revenue" } })).status, 404);
        assert.equal((await call(archiveRoute.POST, `/api/mcp/views/${target}/archive`, { method: "POST", headers: auth, params: { id: target } })).status, 404);
    }
    // A bound token cannot borrow the unrestricted agent's scope.
    const borrowed = await call(viewRoute.GET, `/api/mcp/views/${outView.id}?agentId=${f.builder.id}`, { headers: auth, params: { id: outView.id } });
    assert.equal(borrowed.status, 403);
});

maybe("restricted members see only in-scope views; viewers read but never write", async () => {
    const f = await fixture();
    const outView = await seedView(f.companyId, f.builder.id, { title: "Out", scopeType: "customer", scopeId: f.customerOut.id });
    const outProject = await seedView(f.companyId, f.builder.id, { title: "Out project", scopeType: "project", scopeId: f.projectOut.id });
    const inProject = await seedView(f.companyId, f.builder.id, { title: "In project", scopeType: "project", scopeId: f.projectIn.id });
    const companyView = await seedView(f.companyId, f.builder.id, { title: "Company", panels: [PANELS[0]] });

    const listRoute = await import("@/app/api/views/route");
    const viewRoute = await import("@/app/api/views/[id]/route");
    const versionsRoute = await import("@/app/api/views/[id]/versions/route");
    const revertRoute = await import("@/app/api/views/[id]/revert/route");

    actAs(f.restricted);
    const list = await call(listRoute.GET, "/api/views");
    assert.deepEqual((list.json.views as { id: string }[]).map((v) => v.id).sort(), [inProject.id, companyView.id].sort());
    for (const target of [outView.id, outProject.id, randomUUID()]) {
        assert.equal((await call(viewRoute.GET, `/api/views/${target}`, { params: { id: target } })).status, 404);
        assert.equal((await call(viewRoute.PATCH, `/api/views/${target}`, { method: "PATCH", body: { pinnedToHome: true }, params: { id: target } })).status, 404);
        assert.equal((await call(versionsRoute.GET, `/api/views/${target}/versions`, { params: { id: target } })).status, 404);
        assert.equal((await call(revertRoute.POST, `/api/views/${target}/revert`, { method: "POST", body: { version: 1 }, params: { id: target } })).status, 404);
    }
    const created = await call(listRoute.POST, "/api/views", { method: "POST", body: { title: "Mine", scopeType: "customer", scopeId: f.customerOut.id } });
    assert.equal(created.status, 400, "a restricted member cannot file a view under another customer");
    assert.equal((await call(viewRoute.PATCH, `/api/views/${inProject.id}`, { method: "PATCH", body: { pinnedToHome: true }, params: { id: inProject.id } })).status, 200);

    // The pages read through the same lib calls.
    const { listViews, loadPinnedViewCards } = await import("@/lib/views");
    const { loadMemberScope } = await import("@/lib/member-scope");
    const scope = await loadMemberScope(f.restricted.userId, f.companyId);
    const caller = { kind: "member" as const, userId: f.restricted.userId, scope, role: "member" as const };
    assert.deepEqual((await listViews(f.companyId, caller)).map((v) => v.id).sort(), [inProject.id, companyView.id].sort());
    assert.deepEqual((await loadPinnedViewCards(f.companyId, caller)).map((v) => v.id), [inProject.id]);

    // Viewer: reads, never writes.
    actAs(f.viewer);
    assert.equal((await call(viewRoute.GET, `/api/views/${companyView.id}`, { params: { id: companyView.id } })).status, 200);
    assert.equal((await call(versionsRoute.GET, `/api/views/${companyView.id}/versions`, { params: { id: companyView.id } })).status, 200);
    assert.equal((await call(listRoute.POST, "/api/views", { method: "POST", body: { title: "x" } })).status, 403);
    assert.equal((await call(viewRoute.PATCH, `/api/views/${companyView.id}`, { method: "PATCH", body: { title: "x" }, params: { id: companyView.id } })).status, 403);
    assert.equal((await call(viewRoute.PATCH, `/api/views/${companyView.id}`, { method: "PATCH", body: { archived: true }, params: { id: companyView.id } })).status, 403);
    assert.equal((await call(revertRoute.POST, `/api/views/${companyView.id}/revert`, { method: "POST", body: { version: 1 }, params: { id: companyView.id } })).status, 403);

    // Member: edit, pin, archive, restore.
    actAs(f.member);
    const renamed = await call(viewRoute.PATCH, `/api/views/${companyView.id}`, { method: "PATCH", body: { title: "Company KPIs", description: "Weekly", pinnedToHome: true }, params: { id: companyView.id } });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal((renamed.json.view as { title: string; version: number; pinned: boolean }).version, 2);
    assert.equal((renamed.json.view as { pinned: boolean }).pinned, true, "pinnedToHome pins it to the caller's own Home");
    const archived = await call(viewRoute.PATCH, `/api/views/${companyView.id}`, { method: "PATCH", body: { archived: true }, params: { id: companyView.id } });
    assert.equal((archived.json.view as { archived: boolean; pinnedToHome: boolean }).archived, true);
    assert.equal((archived.json.view as { pinned: boolean }).pinned, false, "archiving unpins");
    const restored = await call(viewRoute.PATCH, `/api/views/${companyView.id}`, { method: "PATCH", body: { archived: false }, params: { id: companyView.id } });
    assert.equal((restored.json.view as { archived: boolean }).archived, false);
    actAs(null);
});

maybe("versions list newest first and revert brings an old layout back as a new version", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.builder.id);
    const view = await seedView(f.companyId, f.builder.id, { title: "Shop", panels: PANELS });
    json(await client.tool("update_view", { viewId: view.id, title: "Shop v2", panels: [{ id: "revenue", type: "metric", title: "Revenue" }] }));

    const versionsRoute = await import("@/app/api/views/[id]/versions/route");
    const revertRoute = await import("@/app/api/views/[id]/revert/route");
    actAs(f.member);
    const versions = await call(versionsRoute.GET, `/api/views/${view.id}/versions`, { params: { id: view.id } });
    const rows = versions.json.versions as { version: number; title: string; panelCount: number; current: boolean; author: { name: string } }[];
    assert.deepEqual(rows.map((v) => [v.version, v.title, v.panelCount, v.current]), [[2, "Shop v2", 1, true], [1, "Shop", 3, false]]);
    assert.equal(rows[0].author.name, "Builder");

    const reverted = await call(revertRoute.POST, `/api/views/${view.id}/revert`, { method: "POST", body: { version: 1 }, params: { id: view.id } });
    assert.equal(reverted.status, 200, reverted.text);
    const after = reverted.json.view as ViewOut;
    assert.equal(after.version, 3);
    assert.equal(after.title, "Shop");
    assert.deepEqual(after.panels.map((p) => p.id), ["revenue", "orders", "top"]);
    assert.equal((after.panels[0].data as { value: number }).value, 12400, "a panel kept through the revert keeps its values");
    assert.equal(after.panels[1].data, null, "a panel the newer layout dropped comes back empty until the next refresh");
    assert.equal((await call(revertRoute.POST, `/api/views/${view.id}/revert`, { method: "POST", body: { version: 99 }, params: { id: view.id } })).status, 400);

    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, view.id), eq(auditLog.action, "view.reverted")));
    assert.equal(entry.actorType, "human");
    assert.equal((entry.payloadJson as { meta: { fromVersion: number } }).meta.fromVersion, 1);
    actAs(null);
});

maybe("views never cross companies", async () => {
    const f = await fixture();
    const view = await seedView(f.companyId, f.builder.id, { title: "Ours", panels: [PANELS[0]] });
    const other = await seedCompanyWithToken();
    const outsider = await seedAgent(other.companyId, { name: "Outsider" });
    const outsiderToken = await seedMcpToken(other.companyId, outsider.id);
    const client = await mcpClientFor(other.companyId, outsider.id);

    assert.deepEqual(json<{ views: unknown[] }>(await client.tool("list_views", {})).views, []);
    assert.equal((await client.tool("get_view", { viewId: view.id })).text, "View not found");
    assert.equal((await client.tool("update_panel", { viewId: view.id, panelId: "revenue", data: { value: 1 } })).text, "View not found");
    const viewRoute = await import("@/app/api/mcp/views/[id]/route");
    assert.equal((await call(viewRoute.GET, `/api/mcp/views/${view.id}`, { headers: bearer(outsiderToken), params: { id: view.id } })).status, 404);
    // Nor can a view be filed under another company's customer.
    assert.equal((await client.tool("create_view", { title: "x", scopeType: "customer", scopeId: f.customerIn.id, panels: [] })).isError, true);

    const otherAdmin = await seedHuman(other.companyId, "admin");
    actAs(otherAdmin);
    const humanRoute = await import("@/app/api/views/[id]/route");
    assert.equal((await call(humanRoute.GET, `/api/views/${view.id}`, { params: { id: view.id } })).status, 404);
    actAs(null);
});

maybe("malicious or oversize specs are rejected and nothing is stored", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.builder.id);
    const attempts: Record<string, unknown>[] = [
        { title: "<script>alert(1)</script>", panels: [] },
        { title: "x", panels: [{ type: "markdown", title: "Notes", data: { text: "<img src=x onerror=alert(1)>" } }] },
        { title: "x", panels: [{ type: "list", title: "Links", data: { items: [{ title: "a", href: "javascript:alert(document.cookie)" }] } }] },
        { title: "x", panels: [{ type: "list", title: "Links", data: { items: [{ title: "a", href: "//evil.example.com" }] } }] },
        { title: "x", panels: [{ type: "table", title: "T", data: { columns: [{ key: "a", label: "A" }], rows: Array.from({ length: 501 }, () => ({ a: 1 })) } }] },
        { title: "x", panels: Array.from({ length: 41 }, (_, i) => ({ id: `p${i}`, type: "metric", title: "M" })) },
        { title: "x", panels: [{ type: "markdown", title: "Big", data: { text: "a".repeat(19_000) } }, ...Array.from({ length: 14 }, (_, i) => ({ id: `b${i}`, type: "markdown", title: "Big", data: { text: "a".repeat(19_000) } }))] },
    ];
    for (const attempt of attempts) {
        const res = await client.tool("create_view", attempt);
        assert.equal(res.isError, true, `accepted: ${JSON.stringify(attempt).slice(0, 120)}`);
    }
    const db = await getDb();
    const { views } = await getSchema();
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(views).where(eq(views.companyId, f.companyId))).length, 0, "a rejected view left a row behind");

    // A panel refresh past the per-view data budget is refused.
    const view = await seedView(f.companyId, f.builder.id, {
        title: "Budget", panels: Array.from({ length: 3 }, (_, i) => ({ id: `t${i}`, type: "table", title: "T" })),
    });
    const bigTable = { columns: [{ key: "a", label: "A" }], rows: Array.from({ length: 450 }, () => ({ a: "x".repeat(450) })) };
    json(await client.tool("update_panel", { viewId: view.id, panelId: "t0", data: bigTable }));
    json(await client.tool("update_panel", { viewId: view.id, panelId: "t0", data: bigTable }));
    json(await client.tool("update_panel", { viewId: view.id, panelId: "t1", data: bigTable }));
    const overflow = await client.tool("update_panel", { viewId: view.id, panelId: "t2", data: bigTable });
    assert.equal(overflow.isError, true);
    assert.match(overflow.text, /limit is 512 KB/);
});

maybe("agents change only the views they built; people (member and up) change any view they can see", async () => {
    const f = await fixture();
    const other = await seedAgent(f.companyId, { name: "Other" });
    const view = await seedView(f.companyId, f.builder.id, { title: "Builder's", panels: PANELS });
    const client = await mcpClientFor(f.companyId, other.id);
    const NOT_OWNER = "Only the agent that built this view (or a person) can change it";

    // MCP tools: readable, but every write is a 403-style refusal with a clear message.
    json(await client.tool("get_view", { viewId: view.id }));
    for (const [tool, args] of [
        ["update_view", { viewId: view.id, title: "Hijacked" }],
        ["update_panel", { viewId: view.id, panelId: "revenue", data: { value: 1 } }],
        ["archive_view", { viewId: view.id }],
    ] as const) {
        const res = await client.tool(tool, args);
        assert.equal(res.isError, true, tool);
        assert.equal(res.text, NOT_OWNER, tool);
    }
    // revert has no agent tool; the lib refuses it for a foreign agent all the same.
    const { revertView, ViewRefusedError } = await import("@/lib/views");
    const { mcpAccessForAgent } = await import("@/lib/mcp-access");
    const { mcpActor } = await import("@/lib/audit");
    const otherCaller = { kind: "agent" as const, access: await mcpAccessForAgent(f.companyId, other.id), actor: mcpActor(other.id) };
    await assert.rejects(revertView(f.companyId, otherCaller, view.id, 1), (e: unknown) => e instanceof ViewRefusedError && e.status === 403);

    // REST twin: a bound token for Other, and the operator token acting as Other, are both 403.
    const otherToken = await seedMcpToken(f.companyId, other.id);
    const viewRoute = await import("@/app/api/mcp/views/[id]/route");
    const panelRoute = await import("@/app/api/mcp/views/[id]/panels/[panelId]/route");
    const archiveRoute = await import("@/app/api/mcp/views/[id]/archive/route");
    for (const [auth, qs] of [[bearer(otherToken), ""], [bearer(f.operatorToken), `?agentId=${other.id}`]] as const) {
        const patch = await call(viewRoute.PATCH, `/api/mcp/views/${view.id}${qs}`, { method: "PATCH", headers: auth, body: { title: "x" }, params: { id: view.id } });
        assert.equal(patch.status, 403, patch.text);
        assert.equal(patch.json.error, NOT_OWNER);
        assert.equal((await call(panelRoute.PUT, `/api/mcp/views/${view.id}/panels/revenue${qs}`, { method: "PUT", headers: auth, body: { data: { value: 1 } }, params: { id: view.id, panelId: "revenue" } })).status, 403);
        assert.equal((await call(archiveRoute.POST, `/api/mcp/views/${view.id}/archive${qs}`, { method: "POST", headers: auth, params: { id: view.id } })).status, 403);
        assert.equal((await call(viewRoute.GET, `/api/mcp/views/${view.id}${qs}`, { headers: auth, params: { id: view.id } })).status, 200);
    }
    // The operator token acting as the builder may.
    const asBuilder = await call(panelRoute.PUT, `/api/mcp/views/${view.id}/panels/revenue?agentId=${f.builder.id}`, { method: "PUT", headers: bearer(f.operatorToken), body: { data: { value: 7 } }, params: { id: view.id, panelId: "revenue" } });
    assert.equal(asBuilder.status, 200, asBuilder.text);

    const db = await getDb();
    const { views } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [untouched] = await db.select().from(views).where(eq(views.id, view.id));
    assert.equal(untouched.title, "Builder's");
    assert.equal(untouched.archivedAt, null);

    // People: a member edits, reverts and archives an agent's view; an admin restores it.
    const humanView = await import("@/app/api/views/[id]/route");
    const revertRoute = await import("@/app/api/views/[id]/revert/route");
    actAs(f.member);
    assert.equal((await call(humanView.PATCH, `/api/views/${view.id}`, { method: "PATCH", body: { title: "Renamed by a person" }, params: { id: view.id } })).status, 200);
    assert.equal((await call(revertRoute.POST, `/api/views/${view.id}/revert`, { method: "POST", body: { version: 1 }, params: { id: view.id } })).status, 200);
    assert.equal((await call(humanView.PATCH, `/api/views/${view.id}`, { method: "PATCH", body: { archived: true }, params: { id: view.id } })).status, 200);
    actAs(f.admin);
    assert.equal((await call(humanView.PATCH, `/api/views/${view.id}`, { method: "PATCH", body: { archived: false }, params: { id: view.id } })).status, 200);
    actAs(null);

    // A view a person built belongs to no agent: agents read it but cannot change it.
    actAs(f.member);
    const listRoute = await import("@/app/api/views/route");
    const personal = await call(listRoute.POST, "/api/views", { method: "POST", body: { title: "Started by a person", visibility: "scope", panels: [PANELS[0]] } });
    actAs(null);
    const personalId = (personal.json.view as { id: string }).id;
    const builderClient = await mcpClientFor(f.companyId, f.builder.id);
    assert.equal((await builderClient.tool("update_panel", { viewId: personalId, panelId: "revenue", data: { value: 1 } })).text, NOT_OWNER);
});

maybe("the REST twin records the agent an operator token names as the view's builder", async () => {
    const f = await fixture();
    const listRoute = await import("@/app/api/mcp/views/route");
    const created = await call(listRoute.POST, `/api/mcp/views?agentId=${f.builder.id}`, {
        method: "POST", headers: { ...bearer(f.operatorToken), "Idempotency-Key": randomUUID() },
        body: { title: "Built over REST", panels: [PANELS[0]] },
    });
    assert.equal(created.status, 201, created.text);
    const view = created.json.view as { id: string; createdBy: { type: string; id: string; name: string } };
    assert.deepEqual(view.createdBy, { type: "agent", id: f.builder.id, name: "Builder" });
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [entry] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, view.id), eq(auditLog.action, "view.created")));
    assert.equal(entry.actorType, "agent");
    assert.equal(entry.actorId, f.builder.id);
});

maybe("view markdown cannot load images or point links off the safe set", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.builder.id);
    const pixel = await client.tool("create_view", { title: "x", panels: [{ type: "markdown", title: "Notes", data: { text: "Hi ![](https://evil.example.com/p.png)" } }] });
    assert.equal(pixel.isError, true);
    assert.match(pixel.text, /images are not allowed in a view; use a list or table panel with a link instead/);
    const view = await seedView(f.companyId, f.builder.id, { title: "Notes", panels: [{ id: "notes", type: "markdown", title: "Notes" }] });
    for (const text of ["![x](https://evil.example.com/p.png)", "[x](//evil.example.com)", "[x](/\\evil.example.com)", "[x][r]\n\n[r]: //evil.example.com"]) {
        const res = await client.tool("update_panel", { viewId: view.id, panelId: "notes", data: { text } });
        assert.equal(res.isError, true, text);
    }
    json(await client.tool("update_panel", { viewId: view.id, panelId: "notes", data: { text: "See [the shop](https://shop.example.com) or [the board](/projects)" } }));
});

maybe("a company holds at most 200 active views", async () => {
    const f = await fixture();
    const db = await getDb();
    const { views } = await getSchema();
    await db.insert(views).values(Array.from({ length: 200 }, (_, i) => ({
        companyId: f.companyId, title: `V${i}`, scopeType: "company", scopeId: null, specJson: { panels: [] }, version: 1,
        createdByType: "agent", createdById: f.builder.id, updatedByType: "agent", updatedById: f.builder.id,
    })));
    const listRoute = await import("@/app/api/mcp/views/route");
    const refused = await call(listRoute.POST, "/api/mcp/views", { method: "POST", headers: { ...bearer(f.builderToken), "Idempotency-Key": randomUUID() }, body: { title: "One more", panels: [] } });
    assert.equal(refused.status, 409, refused.text);
    assert.match(String(refused.json.error), /200 views, the limit/);
    const client = await mcpClientFor(f.companyId, f.builder.id);
    const tool = await client.tool("create_view", { title: "One more", panels: [] });
    assert.equal(tool.isError, true);
    actAs(f.member);
    const human = await import("@/app/api/views/route");
    assert.equal((await call(human.POST, "/api/views", { method: "POST", body: { title: "One more" } })).status, 409);
    actAs(null);

    // Archiving one frees a slot.
    const { eq } = await import("drizzle-orm");
    const [first] = await db.select({ id: views.id }).from(views).where(eq(views.title, "V0"));
    await db.update(views).set({ archivedAt: new Date() }).where(eq(views.id, first.id));
    json(await client.tool("create_view", { title: "One more", panels: [] }));
});

maybe("update_panel is rate limited per caller and view; a bad panel id encoding is a 400", async () => {
    const f = await fixture();
    const view = await seedView(f.companyId, f.builder.id, { title: "Busy", panels: [PANELS[0]] });
    const panelRoute = await import("@/app/api/mcp/views/[id]/panels/[panelId]/route");
    const auth = bearer(f.builderToken);
    const put = () => call(panelRoute.PUT, `/api/mcp/views/${view.id}/panels/revenue`, { method: "PUT", headers: auth, body: { data: { value: 1 } }, params: { id: view.id, panelId: "revenue" } });
    for (let i = 0; i < 60; i++) assert.equal((await put()).status, 200, `call ${i + 1}`);
    const limited = await put();
    assert.equal(limited.status, 429, limited.text);
    assert.match(String(limited.json.error), /at most 60 a minute/);
    // Another view of the same agent has its own budget.
    const second = await seedView(f.companyId, f.builder.id, { title: "Calm", panels: [PANELS[0]] });
    assert.equal((await call(panelRoute.PUT, `/api/mcp/views/${second.id}/panels/revenue`, { method: "PUT", headers: auth, body: { data: { value: 1 } }, params: { id: second.id, panelId: "revenue" } })).status, 200);

    const bad = await call(panelRoute.PUT, `/api/mcp/views/${second.id}/panels/x`, { method: "PUT", headers: auth, body: { data: { value: 1 } }, params: { id: second.id, panelId: "%E0%A4%A" } });
    assert.equal(bad.status, 400, bad.text);
});

maybe("an idempotent create_view replay returns the cached view only to the same caller", async () => {
    const f = await fixture();
    const listRoute = await import("@/app/api/mcp/views/route");
    const key = randomUUID();
    const body = { title: "Replayed", panels: [] };
    const post = (headers: Record<string, string>, qs = "") => call(listRoute.POST, `/api/mcp/views${qs}`, { method: "POST", headers: { ...headers, "Idempotency-Key": key }, body });

    const first = await post(bearer(f.builderToken));
    assert.equal(first.status, 201, first.text);
    const firstId = (first.json.view as { id: string }).id;
    const replay = await post(bearer(f.builderToken));
    assert.equal(replay.status, 200);
    assert.equal((replay.json.view as { id: string }).id, firstId, "the same caller gets its cached response");

    // Another token with the same key and body: no cached body, its own request runs.
    const otherToken = await post(bearer(f.scopedToken));
    assert.equal(otherToken.status, 201, otherToken.text);
    assert.notEqual((otherToken.json.view as { id: string }).id, firstId);
    // The operator token acting as another agent: also its own request.
    const operatorAsScoped = await post(bearer(f.operatorToken), `?agentId=${f.scoped.id}`);
    assert.equal(operatorAsScoped.status, 201, operatorAsScoped.text);
    const operatorAsBuilder = await post(bearer(f.operatorToken), `?agentId=${f.builder.id}`);
    assert.equal(operatorAsBuilder.status, 201, operatorAsBuilder.text);
    const ids = new Set([firstId, otherToken.json.view, operatorAsScoped.json.view, operatorAsBuilder.json.view].map((v) => typeof v === "string" ? v : (v as { id: string }).id));
    assert.equal(ids.size, 4);
    // And each replays its own.
    const operatorReplay = await post(bearer(f.operatorToken), `?agentId=${f.scoped.id}`);
    assert.equal((operatorReplay.json.view as { id: string }).id, (operatorAsScoped.json.view as { id: string }).id);
});
