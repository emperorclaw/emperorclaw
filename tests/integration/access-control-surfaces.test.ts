/**
 * The remaining human surfaces (dashboard, inbox/attention, palette, task
 * page, badges, notifications, delivery inspector, screen feed) and agent
 * self-management. The stubbed session carries no role/scope copies, as if
 * minted before an admin changed them: everything must come from the DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken, seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function world() {
    await resetDb();
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Surfaces Co", createdByUserId: creator.id }).returning();
    const companyId = company.id;
    const work = await seedTwoTenantsOfWork(companyId);
    const agentIn = await seedAgent(companyId, { name: "Agent In" });
    const agentOut = await seedAgent(companyId, { name: "Agent Out" });
    const scope = { mode: "restricted", agentIds: [agentIn.id], customerIds: [work.customerIn.id] };
    return { companyId, ...work, agentIn, agentOut, scope };
}

/** Render the dashboard server component and return the TeamDashboard props. */
async function dashboardProps() {
    const page = (await import("@/app/(app)/page")).default;
    const element = await page({ searchParams: Promise.resolve({}) }) as unknown as { props: { children: unknown } };
    const children = ([] as unknown[]).concat(element.props.children).filter(Boolean) as { props?: Record<string, unknown> }[];
    return children.find((child) => child?.props?.data)!.props as {
        canAct: boolean; isOwnerOrAdmin: boolean;
        data: { members: { id: string; kind: string }[]; board: { inProgress: { id: string }[] }; throughput: { doneToday: number }; cost: { agents: { key: string }[] } };
    };
}

maybe("dashboard: role and member scope come from the DB", async () => {
    const w = await world();
    const db = await getDb();
    const { tasks, tokenUsageLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(tasks).set({ state: "in_progress", assignedAgentId: w.agentOut.id }).where(eq(tasks.id, w.taskOut.id));
    const [doneOut] = await db.insert(tasks).values({ companyId: w.companyId, projectId: w.projectOut.id, taskType: "work", state: "done" }).returning();
    assert.ok(doneOut);
    await db.insert(tokenUsageLog).values({ companyId: w.companyId, agentId: w.agentOut.id, model: "m", inputTokens: 1, outputTokens: 1, costCents: 5 });

    actAs(await seedHuman(w.companyId, "viewer"));
    assert.equal((await dashboardProps()).canAct, false, "a viewer got the inline actions");

    actAs(await seedHuman(w.companyId, "owner"));
    assert.equal((await dashboardProps()).isOwnerOrAdmin, true, "an owner was not recognised");

    actAs(await seedHuman(w.companyId, "member", { scope: w.scope }));
    const props = await dashboardProps();
    const agentIds = props.data.members.filter((m) => m.kind === "agent").map((m) => m.id);
    assert.deepEqual(agentIds, [w.agentIn.id], "restricted member saw an out-of-scope agent");
    assert.equal(props.data.board.inProgress.some((t) => t.id === w.taskOut.id), false, "board leaked an out-of-scope task");
    assert.equal(props.data.throughput.doneToday, 0, "KPI counted out-of-scope work");
    assert.equal(props.data.cost.agents.some((a) => a.key === `agent:${w.agentOut.id}`), false, "cost leaked an out-of-scope agent");
    actAs(null);
});

maybe("inbox access, badge and palette use the DB role and scope", async () => {
    const w = await world();
    const { attentionAccessForSession } = await import("@/lib/attention");
    const sessionOf = (u: { userId: string; sessionId: string }) => ({ user: { id: u.userId }, sessionId: u.sessionId, expires: "" });

    const owner = await seedHuman(w.companyId, "owner");
    actAs(owner);
    assert.equal((await attentionAccessForSession(sessionOf(owner) as never)).isOwnerOrAdmin, true);
    const viewer = await seedHuman(w.companyId, "viewer");
    actAs(viewer);
    assert.equal((await attentionAccessForSession(sessionOf(viewer) as never)).canAct, false, "a viewer could act in the inbox");

    actAs(await seedHuman(w.companyId, "member", { scope: w.scope }));
    const count = await call((await import("@/app/api/inbox/count/route")).GET as never, "/api/inbox/count");
    assert.equal(count.status, 200);
    const palette = await call((await import("@/app/api/ui/palette/route")).GET as never, "/api/ui/palette");
    assert.equal(palette.text.includes(w.agentOut.id), false, "palette offered an out-of-scope agent");
    assert.equal(palette.text.includes(w.projectOut.id), false, "palette offered an out-of-scope project");
    actAs(null);
});

maybe("task page routes: a restricted member sees a task only through its project's customer", async () => {
    const w = await world();
    actAs(await seedHuman(w.companyId, "member", { scope: w.scope }));
    const live = await import("@/app/api/tasks/[id]/live/route");
    const story = await import("@/app/api/tasks/[id]/story/route");
    assert.equal((await call(live.GET, `/api/tasks/${w.taskOut.id}/live`, { params: { id: w.taskOut.id } })).status, 404);
    assert.equal((await call(story.GET, `/api/tasks/${w.taskOut.id}/story`, { params: { id: w.taskOut.id } })).status, 404);
    assert.equal((await call(story.GET, `/api/tasks/${w.taskIn.id}/story`, { params: { id: w.taskIn.id } })).status, 200);
    actAs(null);
    assert.equal((await call(live.GET, `/api/tasks/${w.taskIn.id}/live`, { params: { id: w.taskIn.id } })).status, 401);

    // Someone who is not a member of this company resolves to "nothing in scope", never "unrestricted".
    const db = await getDb();
    const { users } = await getSchema();
    const [outsider] = await db.insert(users).values({ email: `o-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const { loadTaskViewer, loadTaskStory } = await import("@/lib/task-story-reads");
    const viewer = await loadTaskViewer(w.companyId, outsider.id);
    assert.equal(await loadTaskStory(w.companyId, w.taskIn.id, viewer), null, "a non-member read a task");
});

maybe("badges, notifications, delivery inspector and screen feed respect member scope", async () => {
    const w = await world();
    const db = await getDb();
    const { approvals, approvalTaskLinks, notifications, messageThreads, threadMessages, companyTokens, companyMembers } = await getSchema();
    const [approval] = await db.insert(approvals).values({ companyId: w.companyId, projectId: w.projectOut.id, rationale: "out" }).returning();
    await db.insert(approvalTaskLinks).values({ companyId: w.companyId, approvalId: approval.id, taskId: w.taskOut.id });
    const member = await seedHuman(w.companyId, "member", { scope: w.scope });
    await db.insert(notifications).values([
        { companyId: w.companyId, userId: member.userId, kind: "task", title: "OUT-TASK-NOTICE", sourceType: "task", sourceId: w.taskOut.id },
        { companyId: w.companyId, userId: member.userId, kind: "task", title: "IN-TASK-NOTICE", sourceType: "task", sourceId: w.taskIn.id },
    ]);
    const [dm] = await db.insert(messageThreads).values({ companyId: w.companyId, type: "direct", directAgentId: w.agentOut.id }).returning();
    const [msg] = await db.insert(threadMessages).values({ companyId: w.companyId, threadId: dm.id, senderType: "human", text: "hi", targetAgentId: w.agentOut.id }).returning();

    actAs(member);
    const pending = await call((await import("@/app/api/approvals/pending-count/route")).GET as never, "/api/approvals/pending-count");
    assert.equal(pending.json.count, 0, "badge counted an out-of-scope approval");
    const list = await call((await import("@/app/api/notifications/route")).GET, "/api/notifications");
    assert.equal(list.text.includes("OUT-TASK-NOTICE"), false, "notification about an out-of-scope task");
    assert.ok(list.text.includes("IN-TASK-NOTICE"));
    const delivery = await call((await import("@/app/api/messages/[id]/delivery/route")).GET, `/api/messages/${msg.id}/delivery`, { params: { id: msg.id } });
    assert.equal(delivery.status, 404, "delivery inspector for an out-of-scope agent's message");
    actAs(null);

    // A screen token minted by someone who is now restricted shows only their agents.
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({ companyId: w.companyId, scope: "read_only", name: "screen", createdByUserId: member.userId, tokenHash: createHash("sha256").update(raw).digest("hex") });
    const { eq } = await import("drizzle-orm");
    await db.update(companyMembers).set({ scopeJson: w.scope }).where(eq(companyMembers.id, member.membershipId));
    const feed = await call((await import("@/app/api/mcp/live/route")).GET as never, "/api/mcp/live", { headers: bearer(raw) });
    assert.equal(feed.status, 200);
    assert.deepEqual((feed.json.agents as { id: string }[]).map((a) => a.id), [w.agentIn.id], "screen feed leaked an out-of-scope agent");
});

maybe("an agent cannot change other agents, nor its own budget, model or existence", async () => {
    const w = await world();
    const token = bearer(await seedMcpToken(w.companyId, w.agentIn.id));
    const route = await import("@/app/api/mcp/agents/[id]/route");
    const patch = (id: string, body: Record<string, unknown>) => call(route.PATCH, `/api/mcp/agents/${id}`, {
        method: "PATCH", headers: { ...token, "Idempotency-Key": randomUUID() }, params: { id }, body,
    });
    assert.equal((await patch(w.agentOut.id, { role: "pwned" })).status, 403, "edited another agent");
    assert.equal((await patch(w.agentIn.id, { monthlyBudgetCents: 999999 })).status, 403, "raised its own budget");
    assert.equal((await patch(w.agentIn.id, { modelPolicyJson: { x: 1 } })).status, 403, "changed its own model policy");
    assert.equal((await patch(w.agentIn.id, { role: "Researcher" })).status, 200, "an agent may still edit its own role");
    const del = await call(route.DELETE, `/api/mcp/agents/${w.agentIn.id}`, { method: "DELETE", headers: { ...token, "Idempotency-Key": randomUUID() }, params: { id: w.agentIn.id } });
    assert.equal(del.status, 403, "an agent deleted itself");

    const client = await mcpClientFor(w.companyId, w.agentIn.id);
    assert.equal((await client.tool("update_agent", { agentId: w.agentOut.id, role: "x" })).isError, true, "update_agent on another agent");
    assert.equal((await client.tool("update_agent", { agentId: w.agentIn.id, llmModel: "gpt-x" })).isError, true, "update_agent changed its own model");
    assert.equal((await client.tool("update_agent", { agentId: w.agentIn.id, role: "Analyst" })).isError, false);

    // An operator (unbound) token keeps full control.
    const operator = bearer(await seedMcpToken(w.companyId, null));
    const op = await call(route.PATCH, `/api/mcp/agents/${w.agentOut.id}`, {
        method: "PATCH", headers: { ...operator, "Idempotency-Key": randomUUID() }, params: { id: w.agentOut.id }, body: { monthlyBudgetCents: 100 },
    });
    assert.equal(op.status, 200);
});
