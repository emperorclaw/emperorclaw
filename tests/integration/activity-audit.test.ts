import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, seedHuman, seedMcpToken } from "./_access-helper";

/**
 * Activity / audit log (roadmap 11.3): mutations through the UI routes and
 * through MCP record who did them, GET /api/activity is admin-only and
 * company-scoped, pages by (created_at, id), and never stores free text or
 * secrets.
 */
const maybe = dbAvailable ? test : test.skip;
const BASE = "http://localhost";

type AuditRow = { actorType: string; actorId: string | null; action: string; targetType: string; targetId: string; payloadJson: unknown };

async function auditRows(companyId: string): Promise<AuditRow[]> {
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { asc, eq } = await import("drizzle-orm");
    return db.select().from(auditLog).where(eq(auditLog.companyId, companyId)).orderBy(asc(auditLog.createdAt), asc(auditLog.id));
}

async function seedWorld() {
    await resetDb();
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const { companyId, rawToken: companyWideToken } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    const admin = await seedHuman(companyId, "admin");
    const member = await seedHuman(companyId, "member");
    const viewer = await seedHuman(companyId, "viewer");
    const agent = await seedAgent(companyId, { name: "Scout" });
    const agentToken = await seedMcpToken(companyId, agent.id);
    const [project] = await db.insert(projects).values({ companyId, goal: "Website relaunch", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "work", state: "inbox", inputJson: { title: "Fix login" } }).returning();
    return { companyId, owner, admin, member, viewer, agent, agentToken, companyWideToken, project, task };
}

async function companyTokenId(companyId: string, agentId: string | null) {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { and, eq, isNull } = await import("drizzle-orm");
    const [row] = await db.select({ id: companyTokens.id }).from(companyTokens)
        .where(and(eq(companyTokens.companyId, companyId), agentId ? eq(companyTokens.agentId, agentId) : isNull(companyTokens.agentId))).limit(1);
    return row.id;
}

maybe("UI routes record the signed-in person as the actor", async () => {
    const w = await seedWorld();
    const agentRoute = await import("@/app/api/agents/[id]/route");
    const taskRoute = await import("@/app/api/tasks/[id]/route");
    actAs(w.admin);
    const paused = await agentRoute.PATCH(makeRequest(`${BASE}/api/agents/${w.agent.id}`, { method: "PATCH", body: { budgetStatus: "paused", monthlyBudgetCents: 2500 } }), { params: Promise.resolve({ id: w.agent.id }) });
    assert.equal(paused.status, 200);
    const scoped = await agentRoute.PATCH(makeRequest(`${BASE}/api/agents/${w.agent.id}`, { method: "PATCH", body: { scopeJson: { mode: "restricted", projectIds: [w.project.id], customerIds: [] } } }), { params: Promise.resolve({ id: w.agent.id }) });
    assert.equal(scoped.status, 200);
    const moved = await taskRoute.PATCH(makeRequest(`${BASE}/api/tasks/${w.task.id}`, { method: "PATCH", body: { state: "review" } }), { params: Promise.resolve({ id: w.task.id }) });
    assert.equal(moved.status, 200);
    actAs(null);

    const rows = await auditRows(w.companyId);
    const byAction = new Map(rows.map((r) => [r.action, r]));
    for (const action of ["agent.paused", "agent.budget_changed", "agent.scope_changed", "task.state_changed"]) {
        const row = byAction.get(action);
        assert.ok(row, `${action} recorded`);
        assert.equal(row.actorType, "human");
        assert.equal(row.actorId, w.admin.userId);
    }
    assert.deepEqual((byAction.get("task.state_changed")!.payloadJson as { after: unknown }).after, { state: "review" });
    assert.deepEqual((byAction.get("agent.budget_changed")!.payloadJson as { after: unknown }).after, { monthlyBudgetCents: 2500 });
    assert.deepEqual((byAction.get("agent.scope_changed")!.payloadJson as { after: Record<string, unknown> }).after.scopeProjectIds, [w.project.id]);
});

maybe("MCP mutations record the bound agent, a named agent, or system with the token id", async () => {
    const w = await seedWorld();
    const mcpTask = await import("@/app/api/mcp/tasks/[id]/route");
    const call = (token: string, body: Record<string, unknown>) => mcpTask.PATCH(
        makeRequest(`${BASE}/api/mcp/tasks/${w.task.id}`, { method: "PATCH", headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() }, body }),
        { params: Promise.resolve({ id: w.task.id }) },
    );
    assert.equal((await call(w.agentToken, { state: "in_progress" })).status, 200);
    assert.equal((await call(w.companyWideToken, { state: "review" })).status, 200);
    assert.equal((await call(w.companyWideToken, { assignedAgentId: w.agent.id, agentId: "Scout" })).status, 200);

    const moves = (await auditRows(w.companyId)).filter((r) => r.action === "task.state_changed" || r.action === "task.assigned");
    assert.deepEqual(moves.map((r) => r.action), ["task.state_changed", "task.state_changed", "task.assigned"]);
    assert.equal(moves[0].actorType, "agent");
    assert.equal(moves[0].actorId, w.agent.id);
    assert.equal(moves[1].actorType, "system");
    assert.equal(moves[1].actorId, null);
    assert.equal((moves[1].payloadJson as { meta: { tokenId: string } }).meta.tokenId, await companyTokenId(w.companyId, null));
    assert.equal(moves[2].actorType, "agent", "a company-wide token naming an agent acts as that agent");
    assert.equal(moves[2].actorId, w.agent.id);
});

maybe("the MCP server tools record the token's agent too", async () => {
    const w = await seedWorld();
    const { updateAgentForCompany } = await import("@/lib/agents-crud");
    const { mcpActor } = await import("@/lib/audit");
    const tokenId = await companyTokenId(w.companyId, w.agent.id);
    await updateAgentForCompany({ companyId: w.companyId, agentId: w.agent.id, role: "QA", actor: mcpActor(w.agent.id, tokenId) });
    const [row] = (await auditRows(w.companyId)).filter((r) => r.action === "agent.updated");
    assert.equal(row.actorType, "agent");
    assert.deepEqual(row.payloadJson, { before: { role: null }, after: { role: "QA" }, meta: { label: "Scout", tokenId } });
});

maybe("GET /api/activity: owners and admins only; members and viewers get 403", async () => {
    const w = await seedWorld();
    const { recordAudit } = await import("@/lib/audit");
    await recordAudit({ companyId: w.companyId, actor: { type: "human", id: w.owner.userId }, action: "agent.paused", target: { type: "agent", id: w.agent.id }, after: { budgetStatus: "paused" }, meta: { label: "Scout" } });
    const route = await import("@/app/api/activity/route");
    const get = () => route.GET(makeRequest(`${BASE}/api/activity`));
    actAs(w.member);
    assert.equal((await get()).status, 403);
    actAs(w.viewer);
    assert.equal((await get()).status, 403);
    actAs(null);
    assert.equal((await get()).status, 401);
    for (const who of [w.owner, w.admin]) {
        actAs(who);
        const res = await get();
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.items.length, 1);
        assert.equal(body.items[0].sentence.verb, "paused");
        assert.equal(body.items[0].actor.name !== null, true, "the actor's name is resolved");
    }
    actAs(null);
});

maybe("GET /api/activity never shows another company's entries", async () => {
    const w = await seedWorld();
    const { recordAudit } = await import("@/lib/audit");
    await recordAudit({ companyId: w.companyId, actor: { type: "human", id: w.owner.userId }, action: "project.created", target: { type: "project", id: w.project.id }, after: { name: "Website relaunch" } });
    const other = await seedCompanyWithToken();
    const otherAdmin = await seedHuman(other.companyId, "admin");
    const route = await import("@/app/api/activity/route");
    actAs(otherAdmin);
    const body = await (await route.GET(makeRequest(`${BASE}/api/activity`))).json();
    actAs(null);
    assert.deepEqual(body.items, []);
});

maybe("pagination by (created_at, id) returns every row once, newest first, even within one instant", async () => {
    const w = await seedWorld();
    const db = await getDb();
    const { auditLog } = await getSchema();
    const at = new Date("2026-10-01T12:00:00.123Z");
    await db.insert(auditLog).values(Array.from({ length: 7 }, (_, i) => ({
        companyId: w.companyId, actorType: "human", actorId: w.owner.userId, action: "project.updated", targetType: "project", targetId: w.project.id,
        payloadJson: { after: { name: `v${i}` } }, createdAt: i < 5 ? at : new Date(at.getTime() + i * 1000),
    })));
    const route = await import("@/app/api/activity/route");
    actAs(w.admin);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
        const url: string = `${BASE}/api/activity?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
        const body = await (await route.GET(makeRequest(url))).json();
        seen.push(...body.items.map((item: { id: string }) => item.id));
        cursor = body.nextCursor;
        pages += 1;
    } while (cursor && pages < 10);
    const filtered = await (await route.GET(makeRequest(`${BASE}/api/activity?targetType=task`))).json();
    const bad = await route.GET(makeRequest(`${BASE}/api/activity?limit=500`));
    actAs(null);
    assert.equal(pages, 3);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7);
    assert.deepEqual(filtered.items, []);
    assert.equal(bad.status, 400);
});

maybe("payloads never hold chat text, note bodies or tokens", async () => {
    const w = await seedWorld();
    const secret = "ec_live_0123456789abcdefSECRET";
    const { recordAudit } = await import("@/lib/audit");
    await recordAudit({
        companyId: w.companyId, actor: { type: "agent", id: w.agent.id }, action: "task.state_changed", target: { type: "task", id: w.task.id },
        after: { state: "review", text: "please wire the money to my account", token: secret, inputJson: { prompt: "x" } },
        meta: { label: "Fix login", message: "a private chat message", apiKey: secret },
    });
    // A knowledge note through the MCP REST route: title and folder only, never the body.
    const notes = await import("@/app/api/mcp/resources/route");
    const res = await notes.POST(makeRequest(`${BASE}/api/mcp/resources`, {
        method: "POST", headers: { authorization: `Bearer ${w.agentToken}`, "idempotency-key": randomUUID() },
        body: { name: "Pricing rules", resourceType: "knowledge_base", provider: "knowledge", scopeType: "company", configText: `# Rules\nOur key is ${secret}`, folder: "Sales" },
    }));
    assert.equal(res.status, 201);
    // An approval decision with a note: the note is not kept.
    const { createApprovalRequest, resolveApproval } = await import("@/lib/approvals");
    const approval = await createApprovalRequest({ companyId: w.companyId, projectId: w.project.id, taskIds: [w.task.id], requesterAgentId: w.agent.id, rationale: "send it", confidence: 1, actionType: "task_done" });
    await resolveApproval({ companyId: w.companyId, approvalId: approval!.id, resolverUserId: w.owner.userId, status: "approved", resolutionNote: "approved, and here is my password hunter2x" });

    const rows = await auditRows(w.companyId);
    const all = JSON.stringify(rows.map((r) => r.payloadJson));
    for (const forbidden of [secret, "wire the money", "private chat", "# Rules", "hunter2x", "prompt"]) {
        assert.ok(!all.includes(forbidden), `payload leaked: ${forbidden}`);
    }
    const note = rows.find((r) => r.action === "knowledge_note.created");
    assert.ok(note);
    assert.deepEqual((note.payloadJson as { after: unknown }).after, { title: "Pricing rules", path: "Sales" });
    assert.equal(note.actorType, "agent");
    const decision = rows.find((r) => r.action === "approval.approved");
    assert.ok(decision, "approval decision recorded");
    assert.equal(decision.actorId, w.owner.userId);
});

maybe("bulk archive records one entry per task with a shared batch id", async () => {
    const w = await seedWorld();
    const db = await getDb();
    const { tasks } = await getSchema();
    const [second] = await db.insert(tasks).values({ companyId: w.companyId, projectId: w.project.id, taskType: "work", state: "inbox", inputJson: { title: "Write copy" } }).returning();
    const route = await import("@/app/api/tasks/archive/route");
    actAs(w.member);
    const res = await route.POST(makeRequest(`${BASE}/api/tasks/archive`, { method: "POST", body: { taskIds: [w.task.id, second.id] } }));
    actAs(null);
    assert.equal(res.status, 200);
    const archived = (await auditRows(w.companyId)).filter((r) => r.action === "task.archived");
    assert.equal(archived.length, 2);
    const batches = new Set(archived.map((r) => (r.payloadJson as { meta: { batch: string } }).meta.batch));
    assert.equal(batches.size, 1);
    assert.ok(archived.every((r) => r.actorId === w.member.userId));
});
