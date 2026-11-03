/**
 * Who writes, and who maintains a view (the duplicate-view incident): a
 * company-wide token acting for an agent must name it; a person's MCP
 * connection writes as that person; a view's maintainer is its own column,
 * set by the building agent and changed only by a person.
 *
 * Fixture (private direct-chat mode): agents Builder (unrestricted), Other
 * (unrestricted) and Scoped (Customer In only); people Pat (member, owns the
 * private view), Olga (member), Ada (admin), Sam (member it is shared with).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

const AGENT_ID_REQUIRED = "agentId required: a company-wide token must say which agent is acting (?agentId=<id>)";
const PANELS = [{ id: "leads", type: "table", title: "Leads", data: { columns: [{ key: "email", label: "Email" }], rows: [{ email: "customer@example.com" }] } }];

async function fixture() {
    await resetDb();
    const { companyId, userId: ownerUserId, rawToken: fleetToken } = await seedCompanyWithToken();
    const db = await getDb();
    const { companies, companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    const work = await seedTwoTenantsOfWork(companyId);
    const builder = await seedAgent(companyId, { name: "Builder", provider: "hermes" });
    const other = await seedAgent(companyId, { name: "Other", provider: "hermes" });
    const scoped = await seedAgent(companyId, { name: "Scoped", provider: "hermes", scopeJson: { mode: "restricted", customerIds: [work.customerIn.id], projectIds: [] } });
    const pat = await seedHuman(companyId, "member");
    const olga = await seedHuman(companyId, "member");
    const sam = await seedHuman(companyId, "member");
    const ada = await seedHuman(companyId, "admin");
    // A person's token from Settings → Access tokens: company-wide, created by Ada.
    const operatorToken = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, name: "Ada's Claude Code", scope: "mcp_full", createdByUserId: ada.userId,
        tokenHash: createHash("sha256").update(operatorToken).digest("hex"),
    });
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const patChat = await ensureDirectThread(companyId, builder.id, pat.userId);
    return {
        companyId, ownerUserId, fleetToken, operatorToken, ...work, builder, other, scoped, pat, olga, sam, ada, patChat,
        builderToken: await seedMcpToken(companyId, builder.id),
        otherToken: await seedMcpToken(companyId, other.id),
    };
}

type F = Awaited<ReturnType<typeof fixture>>;
type ViewOut = { id: string; visibility: string; owner: { id: string } | null; maintainer: { id: string; name: string | null } | null; createdBy: { type: string; id: string | null } };

const json = <T>(result: { isError: boolean; text: string }): T => {
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text) as T;
};

const routes = async () => ({
    mcpList: await import("@/app/api/mcp/views/route"),
    mcpView: await import("@/app/api/mcp/views/[id]/route"),
    mcpPanel: await import("@/app/api/mcp/views/[id]/panels/[panelId]/route"),
    mcpArchive: await import("@/app/api/mcp/views/[id]/archive/route"),
    send: await import("@/app/api/mcp/messages/send/route"),
    maintainer: await import("@/app/api/views/[id]/maintainer/route"),
    access: await import("@/app/api/views/[id]/access/route"),
    view: await import("@/app/api/views/[id]/route"),
});

const idem = () => ({ "idempotency-key": randomUUID() });

async function privateView(f: F) {
    const client = await mcpClientFor(f.companyId, f.builder.id);
    return json<{ view: ViewOut }>(await client.tool("create_view", { title: "Pat's leads", panels: PANELS, threadId: f.patChat.id })).view;
}

maybe("a company-wide token writing views or messages over REST without agentId gets 400, and nothing is stored", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { views, threadMessages, approvals } = await getSchema();
    const existing = await privateView(f);
    const params = { id: existing.id };

    const create = await call(r.mcpList.POST, "/api/mcp/views", { method: "POST", headers: { ...bearer(f.fleetToken), ...idem() }, body: { title: "Leads copy", panels: PANELS } });
    assert.equal(create.status, 400);
    assert.deepEqual(create.json, { error: AGENT_ID_REQUIRED });
    for (const res of [
        await call(r.mcpView.PATCH, `/api/mcp/views/${existing.id}`, { method: "PATCH", headers: bearer(f.fleetToken), body: { title: "x" }, params }),
        await call(r.mcpPanel.PUT, `/api/mcp/views/${existing.id}/panels/leads`, { method: "PUT", headers: bearer(f.fleetToken), body: { data: { columns: [], rows: [] } }, params: { id: existing.id, panelId: "leads" } }),
        await call(r.mcpArchive.POST, `/api/mcp/views/${existing.id}/archive`, { method: "POST", headers: bearer(f.fleetToken), body: {}, params }),
    ]) {
        assert.equal(res.status, 400, res.text);
        assert.equal(res.json.error, AGENT_ID_REQUIRED);
    }
    // A person's token on the REST API is refused the same way: REST writes act for an agent.
    assert.equal((await call(r.mcpList.POST, "/api/mcp/views", { method: "POST", headers: { ...bearer(f.operatorToken), ...idem() }, body: { title: "Leads copy", panels: PANELS } })).status, 400);

    // The second authored write: a message naming no sender.
    const send = await call(r.send.POST, "/api/mcp/messages/send", { method: "POST", headers: { ...bearer(f.fleetToken), ...idem() }, body: { text: "hello", thread_type: "team" } });
    assert.equal(send.status, 400);
    assert.match(String(send.json.error), /^agentId required: a company-wide token must say which agent is acting/);

    assert.equal((await db.select().from(views)).length, 1, "only the agent's own view exists");
    assert.equal((await db.select().from(threadMessages)).filter((m) => m.text === "hello").length, 0);
    assert.equal((await db.select().from(approvals)).length, 0, "an anonymous call never reaches the permission gate");

    // Reads keep working without agentId (and still hide the private view).
    const list = await call(r.mcpList.GET, "/api/mcp/views", { headers: bearer(f.fleetToken) });
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.views, []);
    // Naming an unknown agent is still the route's 404, not the 400.
    assert.equal((await call(r.mcpList.POST, "/api/mcp/views?agentId=nobody", { method: "POST", headers: { ...bearer(f.fleetToken), ...idem() }, body: { title: "x", panels: [] } })).status, 404);
});

maybe("a company-wide token naming its agent writes as that agent, which becomes the maintainer", async () => {
    const f = await fixture();
    const r = await routes();
    const created = await call(r.mcpList.POST, `/api/mcp/views?agentId=${f.builder.id}`, { method: "POST", headers: { ...bearer(f.fleetToken), ...idem() }, body: { title: "Pipeline", panels: PANELS } });
    assert.equal(created.status, 201, created.text);
    const view = created.json.view as ViewOut;
    assert.deepEqual(view.createdBy, { type: "agent", id: f.builder.id, name: "Builder" });
    assert.deepEqual(view.maintainer, { id: f.builder.id, name: "Builder" });

    const db = await getDb();
    const { views, auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(views).where(eq(views.id, view.id));
    assert.equal(row.maintainerAgentId, f.builder.id);
    assert.equal(row.createdByType, "agent");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.targetId, view.id));
    assert.equal(audit.actorType, "agent");
    assert.equal(audit.actorId, f.builder.id);

    const sent = await call(r.send.POST, "/api/mcp/messages/send", { method: "POST", headers: { ...bearer(f.fleetToken), ...idem() }, body: { text: "named", thread_type: "team", agentId: f.builder.id } });
    assert.equal(sent.status, 200, sent.text);
});

maybe("a person's MCP connection naming no agent writes as that person; a token recording no person cannot write views", async () => {
    const f = await fixture();
    const db = await getDb();
    const { views, auditLog, companyTokens } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { mcpServerOperatorUserId } = await import("@/lib/mcp-write-actor");
    const [tokenRow] = await db.select().from(companyTokens).where(eq(companyTokens.name, "Ada's Claude Code"));
    assert.equal(mcpServerOperatorUserId(tokenRow), f.ada.userId, "/mcp acts as the token's creator");

    const operator = await mcpClientFor(f.companyId, null, f.ada.userId);
    const view = json<{ view: ViewOut }>(await operator.tool("create_view", { title: "Ada's numbers", panels: PANELS })).view;
    assert.deepEqual([view.createdBy.type, view.createdBy.id], ["human", f.ada.userId]);
    assert.equal(view.owner?.id, f.ada.userId, "the view is the person's");
    assert.equal(view.maintainer, null, "a person builds it: no agent maintains it until one is chosen");
    json(await operator.tool("update_panel", { viewId: view.id, panelId: "leads", data: { columns: [{ key: "email", label: "Email" }], rows: [] } }));
    const [row] = await db.select().from(views).where(eq(views.id, view.id));
    assert.equal(row.createdByType, "human");
    assert.equal(row.createdById, f.ada.userId);
    assert.equal(row.updatedByType, "human");
    const audits = await db.select().from(auditLog).where(eq(auditLog.targetId, view.id));
    assert.ok(audits.length > 0);
    for (const audit of audits) assert.deepEqual([audit.actorType, audit.actorId], ["human", f.ada.userId]);

    // Other tools record the person too (an audited write: a project).
    json(await operator.tool("create_project", { goal: "Ada's project" }));
    const projectAudits = await db.select().from(auditLog).where(eq(auditLog.action, "project.created"));
    assert.deepEqual(projectAudits.map((a) => [a.actorType, a.actorId]), [["human", f.ada.userId]]);

    // No agent and no person: refused, nothing stored.
    const anonymous = await mcpClientFor(f.companyId, null, null);
    const refused = await anonymous.tool("create_view", { title: "Nobody's", panels: [] });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /records no person/);
    assert.equal((await anonymous.tool("update_view", { viewId: view.id, title: "x" })).isError, true);
    assert.equal((await db.select().from(views)).length, 1);
});

maybe("a private view: the maintainer has full access, any other agent gets 404, even after the maintainer changes", async () => {
    const f = await fixture();
    const r = await routes();
    const view = await privateView(f);
    assert.equal(view.visibility, "private");
    assert.equal(view.maintainer?.id, f.builder.id);
    const params = { id: view.id };
    const builder = await mcpClientFor(f.companyId, f.builder.id);
    json(await builder.tool("get_view", { viewId: view.id }));
    json(await builder.tool("update_panel", { viewId: view.id, panelId: "leads", data: { columns: [{ key: "email", label: "Email" }], rows: [] } }));
    assert.equal((await call(r.mcpView.GET, `/api/mcp/views/${view.id}?agentId=${f.builder.id}`, { headers: bearer(f.fleetToken), params })).status, 200);
    for (const [auth, qs] of [[bearer(f.otherToken), ""], [bearer(f.fleetToken), `?agentId=${f.other.id}`]] as const) {
        assert.equal((await call(r.mcpView.GET, `/api/mcp/views/${view.id}${qs}`, { headers: auth, params })).status, 404);
        assert.equal((await call(r.mcpView.PATCH, `/api/mcp/views/${view.id}${qs}`, { method: "PATCH", headers: auth, body: { title: "x" }, params })).status, 404);
    }

    // Pat hands maintenance to Other: Other gets full access, Builder (its creator) loses it.
    actAs(f.pat);
    const changed = await call(r.maintainer.PUT, `/api/views/${view.id}/maintainer`, { method: "PUT", body: { agentId: f.other.id }, params });
    assert.equal(changed.status, 200, changed.text);
    assert.equal((changed.json.view as ViewOut).maintainer?.id, f.other.id);
    actAs(null);
    const other = await mcpClientFor(f.companyId, f.other.id);
    json(await other.tool("get_view", { viewId: view.id }));
    json(await other.tool("update_view", { viewId: view.id, title: "Pat's leads (kept by Other)" }));
    assert.equal((await builder.tool("get_view", { viewId: view.id })).text, "View not found");
    assert.equal((await call(r.mcpView.GET, `/api/mcp/views/${view.id}`, { headers: bearer(f.builderToken), params })).status, 404);

    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, view.id), eq(auditLog.action, "view.maintainer_changed")));
    assert.equal(audit.actorType, "human");
    assert.equal(audit.actorId, f.pat.userId);
    const payload = audit.payloadJson as { before: Record<string, unknown>; after: Record<string, unknown>; meta: Record<string, unknown> };
    assert.equal(payload.before.maintainerAgentId, f.builder.id);
    assert.equal(payload.after.maintainerAgentId, f.other.id);
    assert.equal(payload.meta.toName, "Other");
});

maybe("only the view's owner or an owner/admin who can open it chooses the maintainer", async () => {
    const f = await fixture();
    const r = await routes();
    const view = await privateView(f);
    const params = { id: view.id };
    const put = (agentId: string | null) => call(r.maintainer.PUT, `/api/views/${view.id}/maintainer`, { method: "PUT", body: { agentId }, params });

    // Olga cannot see Pat's private view at all.
    actAs(f.olga);
    assert.equal((await put(f.other.id)).status, 404);
    // Ada (admin) sees only its name: she must not hand its content to an agent.
    actAs(f.ada);
    assert.equal((await put(f.other.id)).status, 403);
    assert.deepEqual((await call(r.maintainer.GET, `/api/views/${view.id}/maintainer`, { params })).json.agents, []);
    // Shared with Sam: Sam can open it but does not choose its maintainer.
    actAs(f.pat);
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "shared", shareUserIds: [f.sam.userId] }, params })).status, 200);
    actAs(f.sam);
    assert.equal((await put(f.other.id)).status, 403);
    // Pat, the owner: lists the agents whose scope covers it, sets one, clears it.
    actAs(f.pat);
    const candidates = await call(r.maintainer.GET, `/api/views/${view.id}/maintainer`, { params });
    assert.equal(candidates.status, 200);
    assert.deepEqual((candidates.json.agents as { name: string }[]).map((a) => a.name).sort(), ["Builder", "Other", "Scoped"], "a company view: every agent's scope covers it");
    assert.equal((await put(f.other.id)).status, 200);
    const cleared = await put(null);
    assert.equal(cleared.status, 200);
    assert.equal((cleared.json.view as ViewOut).maintainer, null);
    // Ada, once she can open it (on a company-open view), may choose it too.
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "scope" }, params })).status, 200);
    actAs(f.ada);
    assert.equal((await put(f.builder.id)).status, 200);
    // Olga, a member who can open the company-open view, is neither owner nor admin.
    actAs(f.olga);
    assert.equal((await put(f.other.id)).status, 403);
    actAs(null);
});

maybe("a maintainer whose scope does not cover the view's scope is refused with 400", async () => {
    const f = await fixture();
    const r = await routes();
    actAs(f.pat);
    const createRoute = await import("@/app/api/views/route");
    const created = await call(createRoute.POST, "/api/views", { method: "POST", body: { title: "Customer Out board", scopeType: "customer", scopeId: f.customerOut.id, visibility: "scope" } });
    assert.equal(created.status, 201, created.text);
    const id = (created.json.view as ViewOut).id;
    const params = { id };
    const candidates = await call(r.maintainer.GET, `/api/views/${id}/maintainer`, { params });
    assert.deepEqual((candidates.json.agents as { name: string }[]).map((a) => a.name).sort(), ["Builder", "Other"], "Scoped cannot see Customer Out");
    const refused = await call(r.maintainer.PUT, `/api/views/${id}/maintainer`, { method: "PUT", body: { agentId: f.scoped.id }, params });
    assert.equal(refused.status, 400);
    assert.match(String(refused.json.error), /scope covers this view's scope/);
    assert.equal((await call(r.maintainer.PUT, `/api/views/${id}/maintainer`, { method: "PUT", body: { agentId: randomUUID() }, params })).status, 400, "an unknown agent");
    assert.equal((await call(r.maintainer.PUT, `/api/views/${id}/maintainer`, { method: "PUT", body: {}, params })).status, 400, "agentId is required");
    assert.equal((await call(r.maintainer.PUT, `/api/views/${id}/maintainer`, { method: "PUT", body: { agentId: f.builder.id }, params })).status, 200);
    actAs(null);
});

maybe("an agent limited to other people is never offered and never accepted as maintainer, admins included", async () => {
    const f = await fixture();
    const r = await routes();
    const db = await getDb();
    const { agentAccess } = await getSchema();
    // Secret works only for Olga (0.20 agent access); its scope covers everything.
    const secret = await seedAgent(f.companyId, { name: "Secret", provider: "hermes", ownerUserId: f.olga.userId, access: "people" });
    await db.insert(agentAccess).values({ agentId: secret.id, userId: f.olga.userId, companyId: f.companyId });
    const view = await privateView(f);
    const params = { id: view.id };
    actAs(f.pat);
    const listed = await call(r.maintainer.GET, `/api/views/${view.id}/maintainer`, { params });
    assert.equal((listed.json.agents as { id: string }[]).some((a) => a.id === secret.id), false, "not offered to Pat");
    const refused = await call(r.maintainer.PUT, `/api/views/${view.id}/maintainer`, { method: "PUT", body: { agentId: secret.id }, params });
    assert.equal(refused.status, 400);
    assert.match(String(refused.json.error), /scope covers this view's scope/, "the same answer as an agent outside the scope");
    // An admin who can open the view is not on Secret's list either.
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "scope" }, params })).status, 200);
    actAs(f.ada);
    assert.equal(((await call(r.maintainer.GET, `/api/views/${view.id}/maintainer`, { params })).json.agents as { id: string }[]).some((a) => a.id === secret.id), false);
    assert.equal((await call(r.maintainer.PUT, `/api/views/${view.id}/maintainer`, { method: "PUT", body: { agentId: secret.id }, params })).status, 400);
    actAs(null);
    const { views } = await getSchema();
    const { eq } = await import("drizzle-orm");
    assert.equal((await db.select().from(views).where(eq(views.id, view.id)))[0].maintainerAgentId, f.builder.id);
});

maybe("an agent cannot change who maintains a view", async () => {
    const f = await fixture();
    const r = await routes();
    const view = await privateView(f);
    const params = { id: view.id };
    for (const [auth, qs] of [[bearer(f.builderToken), ""], [bearer(f.fleetToken), `?agentId=${f.builder.id}`]] as const) {
        const res = await call(r.mcpView.PATCH, `/api/mcp/views/${view.id}${qs}`, { method: "PATCH", headers: auth, body: { maintainerAgentId: f.other.id }, params });
        assert.equal(res.status, 403, res.text);
    }
    // The MCP tool has no such field: an extra argument changes nothing.
    const builder = await mcpClientFor(f.companyId, f.builder.id);
    json(await builder.tool("update_view", { viewId: view.id, title: "Renamed", maintainerAgentId: f.other.id } as Record<string, unknown>));
    // The person-only route needs a session; an agent token is not one.
    actAs(null);
    assert.equal((await call(r.maintainer.PUT, `/api/views/${view.id}/maintainer`, { method: "PUT", headers: bearer(f.builderToken), body: { agentId: f.other.id }, params })).status, 401);
    const db = await getDb();
    const { views } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(views).where(eq(views.id, view.id));
    assert.equal(row.maintainerAgentId, f.builder.id);
});

maybe("migration 0076 backfills the maintainer from created_by for agent-built views only", async () => {
    const f = await fixture();
    const db = await getDb();
    const { views, companies, agents } = await getSchema();
    const { eq, sql } = await import("drizzle-orm");
    const [elsewhere] = await db.insert(companies).values({ name: "Elsewhere", createdByUserId: f.ownerUserId }).returning();
    const [foreignAgent] = await db.insert(agents).values({ companyId: elsewhere.id, name: "Foreign", llmModel: "x", monthlyBudgetCents: 0, budgetStatus: "active" }).returning();
    const base = { companyId: f.companyId, specJson: { panels: [] }, version: 1, scopeType: "company", scopeId: null, updatedByType: "agent", updatedById: f.builder.id };
    const [agentBuilt] = await db.insert(views).values({ ...base, title: "By Builder", createdByType: "agent", createdById: f.builder.id }).returning();
    const [personBuilt] = await db.insert(views).values({ ...base, title: "By Pat", createdByType: "human", createdById: f.pat.userId }).returning();
    const [systemBuilt] = await db.insert(views).values({ ...base, title: "By nobody", createdByType: "system", createdById: null }).returning();
    const [goneAgent] = await db.insert(views).values({ ...base, title: "By a removed agent", createdByType: "agent", createdById: randomUUID() }).returning();
    const [otherCompanyAgent] = await db.insert(views).values({ ...base, title: "Claims a foreign agent", createdByType: "agent", createdById: foreignAgent.id }).returning();
    assert.equal(agentBuilt.maintainerAgentId, null, "inserted as before the migration");

    const migration = readFileSync(path.join(process.cwd(), "src/db/migrations/0076_views-maintainer.sql"), "utf8");
    const backfill = migration.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes('UPDATE "views"'));
    assert.ok(backfill, "the backfill statement");
    await db.execute(sql.raw(backfill!));
    await db.execute(sql.raw(backfill!)); // idempotent

    const maintainerOf = async (id: string) => (await db.select({ m: views.maintainerAgentId }).from(views).where(eq(views.id, id)))[0].m;
    assert.equal(await maintainerOf(agentBuilt.id), f.builder.id);
    assert.equal(await maintainerOf(personBuilt.id), null);
    assert.equal(await maintainerOf(systemBuilt.id), null, "an anonymous view has no maintainer");
    assert.equal(await maintainerOf(goneAgent.id), null);
    assert.equal(await maintainerOf(otherCompanyAgent.id), null);

    // Deleting the agent clears it (ON DELETE SET NULL).
    const temp = await seedAgent(f.companyId, { name: "Temp" });
    const [tempView] = await db.insert(views).values({ ...base, title: "By Temp", createdByType: "agent", createdById: temp.id, maintainerAgentId: temp.id }).returning();
    await db.delete(agents).where(eq(agents.id, temp.id));
    assert.equal(await maintainerOf(tempView.id), null);
});
