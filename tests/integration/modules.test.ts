/**
 * Modules (Settings → Modules, lib/modules.ts): a module that is off answers
 * 403 on its API routes, its MCP tools leave the agents' tool list and are
 * refused, its manual lines go, and its data is kept for when it comes back.
 * Only owners and admins switch modules; one company never affects another.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, seedHuman, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function company() {
    const { companyId, rawToken: operatorToken } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    const builder = await seedAgent(companyId, { name: "Builder" });
    const builderToken = await seedMcpToken(companyId, builder.id);
    return { companyId, operatorToken, owner, builder, builderToken };
}

/** An in-process MCP client as `agentId`: list the tools, or call one. */
async function mcp(companyId: string, agentId: string | null) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { buildMcpServer } = await import("@/lib/mcp-server");
    const server = await buildMcpServer(companyId, agentId, null);
    const client = new Client({ name: "modules-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
        async tools() { return (await client.listTools()).tools.map((t) => t.name); },
        async call(name: string, args: Record<string, unknown>) {
            const result = await client.callTool({ name, arguments: args });
            return { isError: Boolean(result.isError), text: (result.content as { text: string }[])[0]?.text ?? "" };
        },
    };
}

async function setModules(user: { userId: string; sessionId: string }, body: unknown) {
    actAs(user);
    const route = await import("@/app/api/settings/modules/route");
    return call(route.PUT as never, "/api/settings/modules", { method: "PUT", body });
}

async function getModules(user: { userId: string; sessionId: string }) {
    actAs(user);
    const route = await import("@/app/api/settings/modules/route");
    return call(route.GET as never, "/api/settings/modules");
}

maybe("existing companies (nothing stored) have every module on, everywhere", async () => {
    await resetDb();
    const { companyId, owner, builder } = await company();
    const { ALL_MODULES_ON } = await import("@/lib/modules");
    const { moduleEnabled } = await import("@/lib/modules-server");
    const db = await getDb();
    const { companies } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select({ modulesJson: companies.modulesJson }).from(companies).where(eq(companies.id, companyId));
    assert.deepEqual(row.modulesJson, {}, "the migration default stores nothing");
    assert.deepEqual((await getModules(owner)).json.modules, ALL_MODULES_ON);
    for (const key of Object.keys(ALL_MODULES_ON)) assert.equal(await moduleEnabled(companyId, key as never), true, key);
    const tools = await (await mcp(companyId, builder.id)).tools();
    assert.ok(tools.includes("create_view") && tools.includes("request_approval"));
});

maybe("off: API routes answer 403 module_off, MCP tools leave the list and are refused, the manual drops them; on again restores the data", async () => {
    await resetDb();
    const { companyId, owner, builder, builderToken } = await company();
    const { customers } = await getSchema();
    const db = await getDb();
    const [customer] = await db.insert(customers).values({ id: randomUUID(), companyId, name: "Harbor Dental" }).returning();
    const agent = await mcp(companyId, builder.id);
    const created = await agent.call("create_view", { title: "Sales", panels: [{ id: "rev", type: "metric", title: "Revenue", data: { value: 5 } }] });
    assert.equal(created.isError, false, created.text);
    const viewId = (JSON.parse(created.text) as { view: { id: string } }).view.id;

    const res = await setModules(owner, { modules: { customers: false, views: false } });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.json.changed, ["customers", "views"]);

    // Human API routes.
    actAs(owner);
    const customersRoute = await import("@/app/api/customers/route");
    const viewsRoute = await import("@/app/api/views/route");
    const viewRoute = await import("@/app/api/views/[id]/route");
    for (const r of [
        await call(customersRoute.GET as never, "/api/customers"),
        await call(viewsRoute.GET as never, "/api/views"),
        await call(viewRoute.GET as never, `/api/views/${viewId}`, { params: { id: viewId } }),
    ]) {
        assert.equal(r.status, 403);
        assert.equal(r.json.code, "module_off");
        assert.match(String(r.json.error), /module is off .* Settings → Modules/);
    }
    // A module that stays on is untouched.
    const timelineRoute = await import("@/app/api/timeline/route");
    const now = Date.now();
    assert.equal((await call(timelineRoute.GET as never, `/api/timeline?from=${now - 86_400_000}&to=${now}`)).status, 200);

    // Agent REST (the Hermes plugin's path).
    const mcpViews = await import("@/app/api/mcp/views/route");
    const mcpCustomers = await import("@/app/api/mcp/customers/route");
    const restViews = await call(mcpViews.GET as never, "/api/mcp/views", { headers: bearer(builderToken) });
    assert.equal(restViews.status, 403);
    assert.equal(restViews.json.module, "views");
    assert.equal((await call(mcpCustomers.GET as never, "/api/mcp/customers", { headers: bearer(builderToken) })).status, 403);

    // MCP tools: omitted from tools/list, refused when called anyway.
    const offAgent = await mcp(companyId, builder.id);
    const tools = await offAgent.tools();
    for (const name of ["list_views", "get_view", "create_view", "update_view", "update_panel", "archive_view"]) assert.ok(!tools.includes(name), `${name} omitted`);
    assert.ok(tools.includes("create_task") && tools.includes("request_approval"), "other tools stay");
    const refused = await offAgent.call("create_view", { title: "Nope", panels: [] });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /create_view not found/);

    // The manual (tool and REST) leaves the Views lines out.
    const manualTool = await offAgent.call("get_emperor_manual", {});
    assert.ok(!manualTool.text.includes("create_view"));
    const manualRoute = await import("@/app/api/mcp/manual/route");
    const manual = await call(manualRoute.GET as never, "/api/mcp/manual", { headers: bearer(builderToken) });
    assert.equal(manual.status, 200);
    assert.ok(!String(manual.json.manual).includes("create_view") && String(manual.json.manual).includes("request_approval"));

    // Data is kept and comes back when the modules are switched on again.
    const { views } = await getSchema();
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(views).where(eq(views.id, viewId))).length, 1);
    assert.equal((await setModules(owner, { modules: { customers: true, views: true } })).status, 200);
    actAs(owner);
    const back = await call(customersRoute.GET as never, "/api/customers");
    assert.equal(back.status, 200);
    assert.deepEqual((back.json.customers as { id: string }[]).map((c) => c.id), [customer.id]);
    const onAgent = await mcp(companyId, builder.id);
    assert.ok((await onAgent.tools()).includes("create_view"));
    const listed = await onAgent.call("list_views", {});
    assert.equal(listed.isError, false, listed.text);
    assert.deepEqual((JSON.parse(listed.text) as { views: { id: string }[] }).views.map((v) => v.id), [viewId]);
    assert.ok(String((await call(manualRoute.GET as never, "/api/mcp/manual", { headers: bearer(builderToken) })).json.manual).includes("create_view"));
});

maybe("Approval history off hides only its page: approvals keep working for agents and the Inbox", async () => {
    await resetDb();
    const { companyId, owner, builder } = await company();
    assert.equal((await setModules(owner, { modules: { approvals: false } })).status, 200);
    const agent = await mcp(companyId, builder.id);
    assert.ok((await agent.tools()).includes("request_approval"));
    actAs(owner);
    const approvals = await import("@/app/api/approvals/route");
    assert.equal((await call(approvals.GET as never, "/api/approvals")).status, 200, "the Inbox still decides approvals");
});

maybe("Display screens off: a screen's read_only token gets 403 from the live feed; other tokens still read it", async () => {
    await resetDb();
    const { companyId, operatorToken, owner } = await company();
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const screen = `ec_screen_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({ companyId, tokenHash: createHash("sha256").update(screen).digest("hex"), name: "Screen", scope: "read_only", createdByUserId: owner.userId });
    const live = await import("@/app/api/mcp/live/route");
    assert.equal((await call(live.GET as never, "/api/mcp/live", { headers: bearer(screen) })).status, 200);
    assert.equal((await setModules(owner, { modules: { displays: false } })).status, 200);
    const dark = await call(live.GET as never, "/api/mcp/live", { headers: bearer(screen) });
    assert.equal(dark.status, 403);
    assert.equal(dark.json.module, "displays");
    assert.equal((await call(live.GET as never, "/api/mcp/live", { headers: bearer(operatorToken) })).status, 200);
});

maybe("only owners and admins switch modules; members and viewers get 403 and nothing changes", async () => {
    await resetDb();
    const { companyId, owner } = await company();
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const viewer = await seedHuman(companyId, "viewer");
    for (const user of [member, viewer]) {
        assert.equal((await setModules(user, { modules: { views: false } })).status, 403);
        assert.equal((await setModules(user, { template: "operations" })).status, 403);
    }
    assert.equal((await getModules(member)).json.modules && (await getModules(member)).json.modules.views, true);
    assert.equal((await setModules(admin, { modules: { views: false } })).status, 200);
    assert.equal(((await getModules(owner)).json.modules as Record<string, boolean>).views, false);
    // Bad input is rejected.
    assert.equal((await setModules(owner, { modules: { knowledge: false } })).status, 400);
    assert.equal((await setModules(owner, { modules: { views: "off" } })).status, 400);
    assert.equal((await setModules(owner, { template: "enterprise" })).status, 400);
});

maybe("changes are audited with before/after; a template sets only the modules", async () => {
    await resetDb();
    const { companyId, owner } = await company();
    const db = await getDb();
    const { auditLog, companies } = await getSchema();
    const { and, asc, eq } = await import("drizzle-orm");
    const [before] = await db.select().from(companies).where(eq(companies.id, companyId));

    assert.equal((await setModules(owner, { modules: { timeline: false } })).status, 200);
    // Saving the same state again writes no audit row.
    assert.equal((await setModules(owner, { modules: { timeline: false } })).status, 200);
    const product = await setModules(owner, { template: "product" });
    assert.equal(product.status, 200);
    const { templateModules } = await import("@/lib/modules");
    assert.deepEqual(product.json.modules, templateModules("product"));

    const rows = await db.select().from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.action, "company.settings_changed"))).orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    assert.equal(rows.length, 2);
    const first = rows[0].payloadJson as { before: Record<string, unknown>; after: Record<string, unknown>; meta: Record<string, unknown> };
    assert.deepEqual(first.before, { timelineModule: true });
    assert.deepEqual(first.after, { timelineModule: false });
    assert.equal(first.meta.setting, "modules");
    const second = rows[1].payloadJson as { before: Record<string, unknown>; after: Record<string, unknown>; meta: Record<string, unknown> };
    assert.equal(second.meta.template, "product");
    assert.equal(second.before.customersModule, true);
    assert.equal(second.after.customersModule, false);
    assert.equal(second.after.timelineModule, true);

    // Nothing else about the company changed.
    const [after] = await db.select().from(companies).where(eq(companies.id, companyId));
    assert.deepEqual({ ...after, modulesJson: null }, { ...before, modulesJson: null });
});

maybe("one company's modules never affect another's", async () => {
    await resetDb();
    const a = await company();
    const b = await company();
    assert.equal((await setModules(a.owner, { modules: { customers: false, views: false } })).status, 200);
    actAs(b.owner);
    const customersRoute = await import("@/app/api/customers/route");
    assert.equal((await call(customersRoute.GET as never, "/api/customers")).status, 200);
    assert.ok((await (await mcp(b.companyId, b.builder.id)).tools()).includes("create_view"));
    const mcpViews = await import("@/app/api/mcp/views/route");
    assert.equal((await call(mcpViews.GET as never, "/api/mcp/views", { headers: bearer(b.builderToken) })).status, 200);
    assert.equal((await call(mcpViews.GET as never, "/api/mcp/views", { headers: bearer(a.builderToken) })).status, 403);
    // B's owner cannot change A's modules: the route always acts on the caller's company.
    assert.equal((await setModules(b.owner, { modules: { customers: true } })).status, 200);
    actAs(a.owner);
    assert.equal((await call(customersRoute.GET as never, "/api/customers")).status, 403);
});
