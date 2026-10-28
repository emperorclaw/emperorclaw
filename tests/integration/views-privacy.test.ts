/**
 * Views phase A (0.19): owner, visibility (private / shared / scope), per-person
 * pins, refresh interval. Every read path must agree with lib/view-access.ts:
 * the human REST routes and the lib reads behind the pages, the MCP tools and
 * their REST twin, Home pins, realtime and search.
 *
 * Fixture (private direct-chat mode): agent Builder (maintains the views) and
 * agent Other; people Pat (owner), Sam (shared), Olga (other member), Ria
 * (restricted to Customer In), Ada (admin), Vic (viewer).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

const SECRET_VALUE = 987654;
const PANELS = [
    { id: "revenue", type: "metric", title: "Revenue", data: { value: SECRET_VALUE, unit: "EUR" } },
    { id: "notes", type: "markdown", title: "Notes", data: { text: "Margin is thin" } },
];

async function fixture() {
    await resetDb();
    const { companyId, rawToken: operatorToken } = await seedCompanyWithToken();
    const db = await getDb();
    const { companies, messageThreads, threadParticipants } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    const work = await seedTwoTenantsOfWork(companyId);
    const builder = await seedAgent(companyId, { name: "Builder", provider: "hermes" });
    const other = await seedAgent(companyId, { name: "Other", provider: "hermes" });
    const pat = await seedHuman(companyId, "member");
    const sam = await seedHuman(companyId, "member");
    const olga = await seedHuman(companyId, "member");
    const ria = await seedHuman(companyId, "member", { scope: { mode: "restricted", customerIds: [work.customerIn.id], agentIds: [builder.id] } });
    const ada = await seedHuman(companyId, "admin");
    const vic = await seedHuman(companyId, "viewer");
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const patChat = await ensureDirectThread(companyId, builder.id, pat.userId);
    const olgaChatWithOther = await ensureDirectThread(companyId, other.id, olga.userId);
    // A group where Builder works with Olga and Ria.
    const [group] = await db.insert(messageThreads).values({ companyId, type: "group", title: "Ops" }).returning();
    await db.insert(threadParticipants).values([
        { threadId: group.id, companyId, participantType: "agent", participantId: builder.id },
        { threadId: group.id, companyId, participantType: "human", participantRef: olga.userId },
        { threadId: group.id, companyId, participantType: "human", participantRef: ria.userId },
    ]);
    return {
        companyId, operatorToken, ...work, builder, other, pat, sam, olga, ria, ada, vic, patChat, olgaChatWithOther, group,
        builderToken: await seedMcpToken(companyId, builder.id),
        otherToken: await seedMcpToken(companyId, other.id),
    };
}

type F = Awaited<ReturnType<typeof fixture>>;

const json = <T>(result: { isError: boolean; text: string }): T => {
    assert.equal(result.isError, false, result.text);
    return JSON.parse(result.text) as T;
};

type ViewOut = { id: string; access: string; visibility: string; owner: { id: string } | null; description: string | null; panels: { id: string }[]; pinned: boolean };

async function privateViewFor(f: F, extra: Record<string, unknown> = {}) {
    const client = await mcpClientFor(f.companyId, f.builder.id);
    return json<{ view: ViewOut }>(await client.tool("create_view", {
        title: "Pat's revenue", description: "Pat's private numbers", panels: PANELS, threadId: f.patChat.id, refreshEveryMinutes: 60, ...extra,
    })).view;
}

async function memberCaller(f: F, who: { userId: string }, role: "owner" | "admin" | "member" | "viewer" = "member") {
    const { loadMemberScope } = await import("@/lib/member-scope");
    return { kind: "member" as const, userId: who.userId, scope: await loadMemberScope(who.userId, f.companyId), role };
}

const routes = async () => ({
    list: await import("@/app/api/views/route"),
    view: await import("@/app/api/views/[id]/route"),
    versions: await import("@/app/api/views/[id]/versions/route"),
    revert: await import("@/app/api/views/[id]/revert/route"),
    access: await import("@/app/api/views/[id]/access/route"),
    owner: await import("@/app/api/views/[id]/owner/route"),
    pin: await import("@/app/api/views/[id]/pin/route"),
    mcpList: await import("@/app/api/mcp/views/route"),
    mcpView: await import("@/app/api/mcp/views/[id]/route"),
    mcpPanel: await import("@/app/api/mcp/views/[id]/panels/[panelId]/route"),
});

maybe("a view built from a person's private chat is theirs and private: nobody else reads it anywhere, admins get metadata only", async () => {
    const f = await fixture();
    const view = await privateViewFor(f);
    assert.equal(view.visibility, "private");
    assert.equal(view.owner?.id, f.pat.userId, "the private chat's person owns it");
    const r = await routes();
    const id = view.id;
    const params = { id };

    // The owner: everything.
    actAs(f.pat);
    const ownList = await call(r.list.GET, "/api/views");
    assert.deepEqual((ownList.json.views as { id: string; access: string }[]).map((v) => [v.id, v.access]), [[id, "full"]]);
    const ownGet = await call(r.view.GET, `/api/views/${id}`, { params });
    assert.equal(ownGet.status, 200);
    assert.equal((ownGet.json.view as ViewOut).panels.length, 2);
    assert.equal((await call(r.versions.GET, `/api/views/${id}/versions`, { params })).status, 200);

    // Another member: it does not exist.
    actAs(f.olga);
    assert.deepEqual((await call(r.list.GET, "/api/views")).json.views, []);
    for (const res of [
        await call(r.view.GET, `/api/views/${id}`, { params }),
        await call(r.versions.GET, `/api/views/${id}/versions`, { params }),
        await call(r.revert.POST, `/api/views/${id}/revert`, { method: "POST", body: { version: 1 }, params }),
        await call(r.view.PATCH, `/api/views/${id}`, { method: "PATCH", body: { title: "x" }, params }),
        await call(r.pin.PUT, `/api/views/${id}/pin`, { method: "PUT", params }),
        await call(r.access.PUT, `/api/views/${id}/access`, { method: "PUT", body: { visibility: "scope" }, params }),
        await call(r.view.DELETE, `/api/views/${id}`, { method: "DELETE", params }),
        await call(r.owner.PUT, `/api/views/${id}/owner`, { method: "PUT", body: { ownerUserId: f.olga.userId }, params }),
    ]) assert.equal(res.status, 404, res.text);
    const { listViews, loadPinnedViewCards, getView } = await import("@/lib/views");
    const olga = await memberCaller(f, f.olga);
    assert.deepEqual(await listViews(f.companyId, olga), []);
    assert.deepEqual(await loadPinnedViewCards(f.companyId, olga), []);
    await assert.rejects(getView(f.companyId, olga, id, { allowMetadata: true }), /View not found/);

    // An admin: the name, owner, maintainer, scope and time; never the content.
    actAs(f.ada);
    const adminList = await call(r.list.GET, "/api/views");
    const row = (adminList.json.views as Record<string, unknown>[]).find((v) => v.id === id)!;
    assert.equal(row.access, "metadata");
    assert.equal(row.title, "Pat's revenue");
    assert.equal((row.owner as { id: string }).id, f.pat.userId);
    assert.deepEqual((row.createdBy as { name: string }).name, "Builder");
    assert.equal(row.description, null);
    assert.equal(row.panelCount, 0);
    assert.equal(row.keyMetric, null);
    assert.equal(row.dataUpdatedAt, null);
    const adminGet = await call(r.view.GET, `/api/views/${id}`, { params });
    assert.equal(adminGet.status, 200);
    assert.equal((adminGet.json.view as ViewOut).access, "metadata");
    assert.deepEqual((adminGet.json.view as ViewOut).panels, []);
    for (const leak of [String(SECRET_VALUE), "Margin is thin", "Pat's private numbers", "Revenue"]) {
        assert.equal(adminList.text.includes(leak), false, `admin list leaked ${leak}`);
        assert.equal(adminGet.text.includes(leak), false, `admin get leaked ${leak}`);
    }
    assert.equal((await call(r.versions.GET, `/api/views/${id}/versions`, { params })).status, 403);
    assert.equal((await call(r.view.PATCH, `/api/views/${id}`, { method: "PATCH", body: { title: "x" }, params })).status, 403);
    assert.equal((await call(r.pin.PUT, `/api/views/${id}/pin`, { method: "PUT", params })).status, 403);
    assert.equal((await call(r.access.PUT, `/api/views/${id}/access`, { method: "PUT", body: { visibility: "scope" }, params })).status, 403, "only the owner decides who sees it");
    actAs(null);

    // Agents: the maintainer reads and writes it; any other agent, or a token acting as none, never sees it.
    const builderClient = await mcpClientFor(f.companyId, f.builder.id);
    json(await builderClient.tool("get_view", { viewId: id }));
    json(await builderClient.tool("update_panel", { viewId: id, panelId: "revenue", data: { value: 1 } }));
    for (const agentId of [f.other.id, null]) {
        const client = await mcpClientFor(f.companyId, agentId);
        assert.equal(json<{ views: { id: string }[] }>(await client.tool("list_views", {})).views.some((v) => v.id === id), false);
        assert.equal((await client.tool("get_view", { viewId: id })).text, "View not found");
    }
    for (const [auth, qs] of [[bearer(f.otherToken), ""], [bearer(f.operatorToken), `?agentId=${f.other.id}`], [bearer(f.operatorToken), ""]] as const) {
        assert.equal((await call(r.mcpView.GET, `/api/mcp/views/${id}${qs}`, { headers: auth, params })).status, 404);
        assert.equal(((await call(r.mcpList.GET, `/api/mcp/views${qs}`, { headers: auth })).json.views as { id: string }[]).some((v) => v.id === id), false);
        assert.equal((await call(r.mcpPanel.PUT, `/api/mcp/views/${id}/panels/revenue${qs}`, { method: "PUT", headers: auth, body: { data: { value: 2 } }, params: { id, panelId: "revenue" } })).status, 404);
    }
    assert.equal((await call(r.mcpView.GET, `/api/mcp/views/${id}`, { headers: bearer(f.builderToken), params })).status, 200);
    // A company-wide token naming the maintainer can read it (token binding is the boundary), and that is recorded.
    assert.equal((await call(r.mcpView.GET, `/api/mcp/views/${id}?agentId=${f.builder.id}`, { headers: bearer(f.operatorToken), params })).status, 200);
    // A refresh right after is not traced again (one trace per view and agent a day).
    assert.equal((await call(r.mcpView.GET, `/api/mcp/views/${id}?agentId=${f.builder.id}`, { headers: bearer(f.operatorToken), params })).status, 200);
    {
        const db = await getDb();
        const { auditLog } = await getSchema();
        const { and, eq } = await import("drizzle-orm");
        const traces = await db.select().from(auditLog).where(and(eq(auditLog.targetId, id), eq(auditLog.action, "view.read_unbound_token")));
        assert.equal(traces.length, 1, "only the unbound read is recorded, not the bound token's");
        assert.equal(traces[0].actorId, f.builder.id);
    }

    // Search does not index views, so a private view's title never surfaces there.
    const { searchCompany } = await import("@/lib/search");
    const found = await searchCompany({ companyId: f.companyId, userId: f.olga.userId, isAdmin: false, scope: null }, { q: "revenue", limit: 20 });
    assert.equal(JSON.stringify(found).includes(id), false);
});

maybe("realtime: a private view's update reaches only the people allowed to open it", async () => {
    const f = await fixture();
    const view = await privateViewFor(f);
    const scopeView = json<{ view: ViewOut }>(await (await mcpClientFor(f.companyId, f.builder.id)).tool("create_view", { title: "Open", panels: PANELS })).view;
    const { Client } = await import("pg");
    const listener = new Client({ connectionString: process.env.POSTGRES_CONNECTION_STRING });
    await listener.connect();
    const received: string[] = [];
    listener.on("notification", (msg) => { if (msg.payload) received.push(msg.payload); });
    await listener.query("LISTEN mcp_events");
    try {
        // Wait out the per-view announce window from the create calls.
        await new Promise((r) => setTimeout(r, 2100));
        received.length = 0;
        const builderClient = await mcpClientFor(f.companyId, f.builder.id);
        json(await builderClient.tool("update_panel", { viewId: view.id, panelId: "revenue", data: { value: 5 } }));
        json(await builderClient.tool("update_panel", { viewId: scopeView.id, panelId: "revenue", data: { value: 5 } }));
        for (let i = 0; i < 100 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
        const { parseRealtimeNotification, humanSocketReceives, socketMayReceive } = await import("@/lib/realtime-delivery").then(async (m) => ({ ...m, ...(await import("@/lib/direct-chat-mode")) }));
        const { resolveHumanRealtimeContext } = await import("@/lib/realtime-human");
        const events = received.map((raw) => parseRealtimeNotification(raw)!).filter((e) => (e.payload as { type?: string }).type === "view_updated");
        const privateEvents = events.filter((e) => (e.payload as { viewId: string }).viewId === view.id);
        const openEvents = events.filter((e) => (e.payload as { viewId: string }).viewId === scopeView.id);
        assert.equal(privateEvents.length, 1, "one personal event: only the owner may open it");
        assert.equal(openEvents.length, 1);
        const [pat, olga, ada] = await Promise.all([f.pat, f.olga, f.ada].map((p) => resolveHumanRealtimeContext(p.userId)));
        assert.equal(humanSocketReceives(privateEvents[0], pat!), true);
        assert.equal(humanSocketReceives(privateEvents[0], olga!), false);
        assert.equal(humanSocketReceives(privateEvents[0], ada!), false, "an admin with metadata access gets no live updates");
        assert.equal(socketMayReceive(privateEvents[0].audience, { agentId: f.other.id }), false, "no other agent socket");
        assert.equal(humanSocketReceives(openEvents[0], olga!), true, "a view open to the scope still reaches everyone");
    } finally {
        await listener.end();
    }
});

maybe("an agent names an owner only from the conversation it answers, and only someone who can see the scope", async () => {
    const f = await fixture();
    const client = await mcpClientFor(f.companyId, f.builder.id);
    const attempt = (args: Record<string, unknown>) => client.tool("create_view", { title: "x", panels: [], ...args });

    // No conversation: no owner, open to the scope.
    const plain = json<{ view: ViewOut }>(await attempt({})).view;
    assert.deepEqual([plain.owner, plain.visibility], [null, "scope"]);
    // An arbitrary person, with or without a thread.
    assert.match((await attempt({ ownerUserId: f.olga.userId })).text, /needs the threadId/);
    assert.match((await attempt({ ownerUserId: f.olga.userId, threadId: f.patChat.id })).text, /ownerUserId must be a person from the conversation/);
    assert.match((await attempt({ ownerUserId: f.sam.userId, threadId: f.group.id })).text, /ownerUserId must be a person from the conversation/);
    // Another agent's private chat, or a thread from another company, is not this agent's conversation.
    assert.match((await attempt({ threadId: f.olgaChatWithOther.id })).text, /not a conversation you are part of/);
    assert.match((await attempt({ threadId: randomUUID() })).text, /not a conversation you are part of/);
    // A person from the group: owner, open to the scope unless the agent asks for private.
    const named = json<{ view: ViewOut }>(await attempt({ ownerUserId: f.olga.userId, threadId: f.group.id })).view;
    assert.deepEqual([named.owner?.id, named.visibility], [f.olga.userId, "scope"]);
    const namedPrivate = json<{ view: ViewOut }>(await attempt({ ownerUserId: f.olga.userId, threadId: f.group.id, visibility: "private" })).view;
    assert.deepEqual([namedPrivate.owner?.id, namedPrivate.visibility], [f.olga.userId, "private"]);
    // A group with no owner named: open to the scope.
    assert.equal(json<{ view: ViewOut }>(await attempt({ threadId: f.group.id })).view.visibility, "scope");
    // The team channel (which the Hermes plugin sends as the turn's thread) names nobody: no owner, open to the scope.
    const { ensureTeamThread } = await import("@/lib/control-plane");
    const team = await ensureTeamThread(f.companyId);
    const fromTeam = json<{ view: ViewOut }>(await attempt({ threadId: team.id })).view;
    assert.deepEqual([fromTeam.owner, fromTeam.visibility], [null, "scope"]);
    // ...but naming an owner there needs the agent to actually work in that thread.
    assert.match((await attempt({ threadId: team.id, ownerUserId: f.olga.userId })).text, /not a conversation you are part of|ownerUserId must be a person/);
    // The owner must see the scope: Ria cannot see Customer Out.
    assert.match((await attempt({ ownerUserId: f.ria.userId, threadId: f.group.id, scopeType: "customer", scopeId: f.customerOut.id })).text, /cannot see this scope/);
    json(await attempt({ ownerUserId: f.ria.userId, threadId: f.group.id, scopeType: "customer", scopeId: f.customerIn.id }));
    // Agents never share with people, and private needs an owner.
    assert.equal((await attempt({ threadId: f.patChat.id, visibility: "shared" })).isError, true);
    assert.match((await attempt({ visibility: "private" })).text, /private view needs the person/);
    // The private chat's owner may be confirmed explicitly; the scope default flips to private.
    const confirmed = json<{ view: ViewOut }>(await attempt({ threadId: f.patChat.id, ownerUserId: f.pat.userId })).view;
    assert.deepEqual([confirmed.owner?.id, confirmed.visibility], [f.pat.userId, "private"]);
    // ...and the agent may not open it to the scope: widening is the owner's call.
    assert.match((await attempt({ threadId: f.patChat.id, visibility: "scope" })).text, /starts private/);

    // The audit traces where an agent's named owner came from, and never counts a private view's panels.
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const [namedAudit] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, named.id), eq(auditLog.action, "view.created")));
    assert.deepEqual((namedAudit.payloadJson as { meta: Record<string, unknown> }).meta, { label: "x", ownerSource: "conversation", threadId: f.group.id });
    const [privateAudit] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, confirmed.id), eq(auditLog.action, "view.created")));
    const privateAfter = (privateAudit.payloadJson as { after: Record<string, unknown> }).after;
    assert.equal("panelCount" in privateAfter || "version" in privateAfter, false, "a private view's audit keeps metadata only");
    const [openAudit] = await db.select().from(auditLog).where(and(eq(auditLog.targetId, plain.id), eq(auditLog.action, "view.created")));
    assert.equal((openAudit.payloadJson as { after: Record<string, unknown> }).after.panelCount, 0, "a view open to the scope keeps today's fields");

    // The REST twin (the Hermes plugin) takes the same fields.
    const r = await routes();
    const created = await call(r.mcpList.POST, "/api/mcp/views", {
        method: "POST", headers: { ...bearer(f.builderToken), "Idempotency-Key": randomUUID() },
        body: { title: "Via REST", panels: [], threadId: f.patChat.id, refreshEveryMinutes: 1440 },
    });
    assert.equal(created.status, 201, created.text);
    const rest = created.json.view as ViewOut & { refreshEveryMinutes: number };
    assert.deepEqual([rest.owner?.id, rest.visibility, rest.refreshEveryMinutes], [f.pat.userId, "private", 1440]);
    const badRefresh = await call(r.mcpView.PATCH, `/api/mcp/views/${rest.id}`, { method: "PATCH", headers: bearer(f.builderToken), body: { refreshEveryMinutes: -1 }, params: { id: rest.id } });
    assert.equal(badRefresh.status, 400);
    const cleared = await call(r.mcpView.PATCH, `/api/mcp/views/${rest.id}`, { method: "PATCH", headers: bearer(f.builderToken), body: { refreshEveryMinutes: null }, params: { id: rest.id } });
    assert.equal((cleared.json.view as { refreshEveryMinutes: number | null }).refreshEveryMinutes, null);
});

maybe("the owner shares a view with people; the scope still caps every share; changes are audited without content", async () => {
    const f = await fixture();
    const view = await privateViewFor(f, { scopeType: "customer", scopeId: f.customerIn.id });
    const r = await routes();
    const params = { id: view.id };

    actAs(f.pat);
    const people = await call(r.access.GET, `/api/views/${view.id}/access`, { params });
    const ids = (people.json.people as { id: string }[]).map((p) => p.id);
    assert.ok(ids.includes(f.sam.userId) && ids.includes(f.ria.userId) && !ids.includes(f.pat.userId));
    const shared = await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "shared", shareUserIds: [f.sam.userId, f.ria.userId] }, params });
    assert.equal(shared.status, 200, shared.text);
    assert.equal((shared.json.view as { sharedCount: number }).sharedCount, 2);
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "shared", shareUserIds: [randomUUID()] }, params })).status, 400);
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "shared", shareUserIds: [] }, params })).status, 400);

    // Shared people read it in full (and list it); others still do not see it.
    for (const who of [f.sam, f.ria]) {
        actAs(who);
        assert.deepEqual((((await call(r.list.GET, "/api/views")).json.views) as { id: string }[]).map((v) => v.id), [view.id]);
        const got = await call(r.view.GET, `/api/views/${view.id}`, { params });
        assert.equal(got.status, 200, got.text);
        assert.equal((got.json.view as ViewOut).access, "full");
        assert.equal((got.json.view as { sharedWith: unknown }).sharedWith, null, "only the owner sees the share list");
        assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "scope" }, params })).status, 403);
    }
    actAs(f.olga);
    assert.equal((await call(r.view.GET, `/api/views/${view.id}`, { params })).status, 404);

    // The scope caps shares: Ria leaves Customer In and loses the view, share or not.
    const db = await getDb();
    const { companyMembers, auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    await db.update(companyMembers).set({ scopeJson: { mode: "restricted", customerIds: [f.customerOut.id], agentIds: [] } })
        .where(and(eq(companyMembers.companyId, f.companyId), eq(companyMembers.userId, f.ria.userId)));
    actAs(f.ria);
    assert.equal((await call(r.view.GET, `/api/views/${view.id}`, { params })).status, 404);
    assert.deepEqual((await call(r.list.GET, "/api/views")).json.views, []);
    // ...and cannot be shared a view outside her scope.
    actAs(f.pat);
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "shared", shareUserIds: [f.ria.userId] }, params })).status, 400);

    // Everyone in scope, then private again (the share list goes).
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "scope" }, params })).status, 200);
    actAs(f.olga);
    assert.equal((await call(r.view.GET, `/api/views/${view.id}`, { params })).status, 200);
    actAs(f.pat);
    assert.equal((await call(r.access.PUT, `/api/views/${view.id}/access`, { method: "PUT", body: { visibility: "private" }, params })).status, 200);
    actAs(f.sam);
    assert.equal((await call(r.view.GET, `/api/views/${view.id}`, { params })).status, 404);
    actAs(null);

    const audits = await db.select().from(auditLog).where(and(eq(auditLog.targetId, view.id), eq(auditLog.action, "view.visibility_changed")));
    assert.equal(audits.length, 3);
    const first = audits.find((a) => (a.payloadJson as { after: { visibility: string } }).after.visibility === "shared")!;
    assert.equal((first.payloadJson as { after: { sharedCount: number } }).after.sharedCount, 2);
    for (const leak of [String(SECRET_VALUE), f.sam.userId, f.ria.userId]) assert.equal(JSON.stringify(audits).includes(leak), false, `audit leaked ${leak}`);
});

maybe("admins transfer and delete a private view without reading it; the owner may too; nobody else", async () => {
    const f = await fixture();
    const view = await privateViewFor(f);
    const second = await privateViewFor(f, { title: "Pat's second" });
    const r = await routes();

    actAs(f.olga);
    assert.equal((await call(r.owner.PUT, `/api/views/${view.id}/owner`, { method: "PUT", body: { ownerUserId: f.olga.userId }, params: { id: view.id } })).status, 404);

    actAs(f.ada);
    assert.equal((await call(r.owner.PUT, `/api/views/${view.id}/owner`, { method: "PUT", body: { ownerUserId: randomUUID() }, params: { id: view.id } })).status, 400);
    const selfTransfer = await call(r.owner.PUT, `/api/views/${view.id}/owner`, { method: "PUT", body: { ownerUserId: f.ada.userId }, params: { id: view.id } });
    assert.equal(selfTransfer.status, 403, "an admin who only sees the name cannot make it theirs");
    assert.equal((await call(r.owner.PUT, `/api/views/${view.id}/owner`, { method: "PUT", body: { ownerUserId: f.pat.userId }, params: { id: view.id } })).status, 400, "the current owner is not a new owner");
    const { listViewTransferPeople } = await import("@/lib/views");
    const candidates = (await listViewTransferPeople(f.companyId, await memberCaller(f, f.ada, "admin"), view.id)).map((p) => p.id);
    assert.ok(candidates.includes(f.olga.userId));
    assert.equal(candidates.includes(f.ada.userId), false, "the admin is not offered to themselves");
    assert.equal(candidates.includes(f.pat.userId), false, "nor the current owner");
    const moved = await call(r.owner.PUT, `/api/views/${view.id}/owner`, { method: "PUT", body: { ownerUserId: f.olga.userId }, params: { id: view.id } });
    assert.equal(moved.status, 200, moved.text);
    // Still metadata for the admin: transferring never opened it.
    assert.equal(((await call(r.view.GET, `/api/views/${view.id}`, { params: { id: view.id } })).json.view as ViewOut).access, "metadata");
    // Both owners hear about it; the admin who did it does not.
    {
        const db = await getDb();
        const { notifications } = await getSchema();
        const { and, eq } = await import("drizzle-orm");
        const rows = await db.select().from(notifications).where(and(eq(notifications.companyId, f.companyId), eq(notifications.kind, "view_transferred")));
        const of = (userId: string) => rows.filter((n) => n.userId === userId).map((n) => n.title);
        assert.equal(of(f.pat.userId).length, 1);
        assert.match(of(f.pat.userId)[0], /^Your view "Pat's revenue" was transferred to .+ by .+$/);
        assert.equal(of(f.olga.userId).length, 1);
        assert.match(of(f.olga.userId)[0], /gave you the view "Pat's revenue"$/);
        assert.equal(of(f.ada.userId).length, 0);
        assert.ok(rows.every((n) => n.link === `/views/${view.id}` && n.sourceType === "view"));
    }

    actAs(f.olga);
    const olgaGet = await call(r.view.GET, `/api/views/${view.id}`, { params: { id: view.id } });
    assert.equal((olgaGet.json.view as ViewOut).access, "full", "the new owner opens it");
    actAs(f.pat);
    assert.equal((await call(r.view.GET, `/api/views/${view.id}`, { params: { id: view.id } })).status, 404, "the old owner no longer does");

    actAs(f.ada);
    const deleted = await call(r.view.DELETE, `/api/views/${view.id}`, { method: "DELETE", params: { id: view.id } });
    assert.equal(deleted.status, 200, deleted.text);
    assert.equal((await call(r.view.GET, `/api/views/${view.id}`, { params: { id: view.id } })).status, 404);
    // A member who is not the owner cannot delete; the owner can.
    actAs(f.sam);
    assert.equal((await call(r.view.DELETE, `/api/views/${second.id}`, { method: "DELETE", params: { id: second.id } })).status, 404);
    actAs(f.pat);
    assert.equal((await call(r.view.DELETE, `/api/views/${second.id}`, { method: "DELETE", params: { id: second.id } })).status, 200);
    actAs(null);

    const db = await getDb();
    const { auditLog } = await getSchema();
    const { inArray } = await import("drizzle-orm");
    const audits = await db.select().from(auditLog).where(inArray(auditLog.targetId, [view.id, second.id]));
    const actions = audits.map((a) => a.action).sort();
    assert.deepEqual(actions.filter((a) => a !== "view.created"), ["view.deleted", "view.deleted", "view.owner_transferred"]);
    assert.equal(JSON.stringify(audits).includes(String(SECRET_VALUE)), false);
    assert.equal(JSON.stringify(audits).includes("Margin is thin"), false);
});

maybe("pins are per person, only for views they can open, and archiving clears them", async () => {
    const f = await fixture();
    const privateView = await privateViewFor(f);
    const open = json<{ view: ViewOut }>(await (await mcpClientFor(f.companyId, f.builder.id)).tool("create_view", { title: "Open to all", panels: PANELS })).view;
    const r = await routes();
    const { loadPinnedViewCards } = await import("@/lib/views");

    actAs(f.pat);
    assert.equal((await call(r.pin.PUT, `/api/views/${privateView.id}/pin`, { method: "PUT", params: { id: privateView.id } })).status, 200);
    assert.equal((await call(r.pin.PUT, `/api/views/${open.id}/pin`, { method: "PUT", params: { id: open.id } })).status, 200);
    actAs(f.vic);
    assert.equal((await call(r.pin.PUT, `/api/views/${open.id}/pin`, { method: "PUT", params: { id: open.id } })).status, 200, "a viewer pins to their own Home");
    actAs(null);

    assert.deepEqual((await loadPinnedViewCards(f.companyId, await memberCaller(f, f.pat))).map((v) => v.id), [privateView.id, open.id], "pin order");
    assert.deepEqual((await loadPinnedViewCards(f.companyId, await memberCaller(f, f.vic, "viewer"))).map((v) => v.id), [open.id]);
    assert.deepEqual(await loadPinnedViewCards(f.companyId, await memberCaller(f, f.olga)), [], "nobody else's Home changes");
    const cards = await loadPinnedViewCards(f.companyId, await memberCaller(f, f.pat));
    assert.equal(cards[0].refreshEveryMinutes, 60);

    // A pin of a view the person can no longer open disappears from Home.
    const db = await getDb();
    const { viewPins, views } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.insert(viewPins).values({ companyId: f.companyId, userId: f.olga.userId, viewId: privateView.id, position: 0 });
    assert.deepEqual(await loadPinnedViewCards(f.companyId, await memberCaller(f, f.olga)), []);

    actAs(f.pat);
    assert.equal((await call(r.pin.DELETE, `/api/views/${privateView.id}/pin`, { method: "DELETE", params: { id: privateView.id } })).status, 200);
    actAs(f.olga);
    assert.equal((await call(r.view.PATCH, `/api/views/${open.id}`, { method: "PATCH", body: { archived: true }, params: { id: open.id } })).status, 200);
    actAs(null);
    assert.deepEqual((await db.select().from(viewPins).where(eq(viewPins.viewId, open.id))), [], "archiving clears everyone's pin");
    // The old column is not read any more.
    await db.update(views).set({ pinnedToHome: true }).where(eq(views.id, open.id));
    assert.deepEqual((await loadPinnedViewCards(f.companyId, await memberCaller(f, f.pat))).map((v) => v.id), []);
});

maybe("migration 0071 gives every current member who could see a pinned view their own pin", async () => {
    const f = await fixture();
    const db = await getDb();
    const { views, viewPins, users } = await getSchema();
    const { eq, sql } = await import("drizzle-orm");
    const base = { companyId: f.companyId, specJson: { panels: [] }, version: 1, createdByType: "agent", createdById: f.builder.id, updatedByType: "agent", updatedById: f.builder.id, pinnedToHome: true };
    const [company] = await db.insert(views).values({ ...base, title: "Company KPIs", scopeType: "company", scopeId: null }).returning();
    const [outCustomer] = await db.insert(views).values({ ...base, title: "Out client", scopeType: "customer", scopeId: f.customerOut.id }).returning();
    const [inProject] = await db.insert(views).values({ ...base, title: "In project", scopeType: "project", scopeId: f.projectIn.id }).returning();
    await db.insert(views).values({ ...base, title: "Unpinned", scopeType: "company", scopeId: null, pinnedToHome: false });
    await db.insert(views).values({ ...base, title: "Archived", scopeType: "company", scopeId: null, archivedAt: new Date() });
    await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, f.vic.userId));

    const migration = readFileSync(path.join(process.cwd(), "src/db/migrations/0071_views-privacy.sql"), "utf8");
    const insert = migration.split("--> statement-breakpoint").map((s) => s.trim()).find((s) => s.includes('INSERT INTO "view_pins"'));
    assert.ok(insert, "the backfill statement");
    await db.delete(viewPins);
    await db.execute(sql.raw(insert!));
    await db.execute(sql.raw(insert!)); // idempotent

    const pins = await db.select({ userId: viewPins.userId, viewId: viewPins.viewId }).from(viewPins);
    const of = (userId: string) => pins.filter((p) => p.userId === userId).map((p) => p.viewId).sort();
    const all = [company.id, outCustomer.id, inProject.id].sort();
    for (const who of [f.pat, f.sam, f.olga, f.ada]) assert.deepEqual(of(who.userId), all);
    assert.deepEqual(of(f.ria.userId), [company.id, inProject.id].sort(), "a restricted member keeps what she could see");
    assert.deepEqual(of(f.vic.userId), [], "deleted people get nothing");
    assert.equal(pins.length, 4 * 3 + 2, "nobody else: unpinned and archived views are not copied");
});

maybe("legacy views (no owner, visibility scope) behave exactly as before", async () => {
    const f = await fixture();
    const db = await getDb();
    const { views } = await getSchema();
    const [legacy] = await db.insert(views).values({
        companyId: f.companyId, title: "Legacy", scopeType: "company", scopeId: null, specJson: { panels: [] }, version: 1,
        createdByType: "agent", createdById: f.builder.id, updatedByType: "agent", updatedById: f.builder.id,
    }).returning();
    assert.equal(legacy.visibility, "scope");
    assert.equal(legacy.ownerUserId, null);
    const r = await routes();
    for (const who of [f.olga, f.ria, f.ada, f.vic]) {
        actAs(who);
        const got = await call(r.view.GET, `/api/views/${legacy.id}`, { params: { id: legacy.id } });
        assert.equal((got.json.view as ViewOut).access, "full");
    }
    // Nobody owns it, so nobody changes who sees it; an admin may give it an owner.
    actAs(f.ada);
    assert.equal((await call(r.access.PUT, `/api/views/${legacy.id}/access`, { method: "PUT", body: { visibility: "private" }, params: { id: legacy.id } })).status, 403);
    assert.equal((await call(r.owner.PUT, `/api/views/${legacy.id}/owner`, { method: "PUT", body: { ownerUserId: f.olga.userId }, params: { id: legacy.id } })).status, 200);
    actAs(null);
    const other = await mcpClientFor(f.companyId, f.other.id);
    json(await other.tool("get_view", { viewId: legacy.id }));
});

maybe("private views never cross companies, not even as metadata", async () => {
    const f = await fixture();
    const view = await privateViewFor(f);
    const otherCo = await seedCompanyWithToken();
    const otherAdmin = await seedHuman(otherCo.companyId, "admin");
    const r = await routes();
    actAs(otherAdmin);
    assert.equal((await call(r.view.GET, `/api/views/${view.id}`, { params: { id: view.id } })).status, 404);
    assert.equal((await call(r.view.DELETE, `/api/views/${view.id}`, { method: "DELETE", params: { id: view.id } })).status, 404);
    assert.equal((await call(r.owner.PUT, `/api/views/${view.id}/owner`, { method: "PUT", body: { ownerUserId: otherAdmin.userId }, params: { id: view.id } })).status, 404);
    assert.deepEqual((await call(r.list.GET, "/api/views")).json.views, []);
    actAs(null);
    const outsider = await seedAgent(otherCo.companyId, { name: "Outsider" });
    const client = await mcpClientFor(otherCo.companyId, outsider.id);
    assert.equal((await client.tool("get_view", { viewId: view.id })).text, "View not found");
    // Nor can an agent use another company's thread to claim an owner.
    assert.match((await client.tool("create_view", { title: "x", panels: [], threadId: f.patChat.id })).text, /not a conversation you are part of/);
});
