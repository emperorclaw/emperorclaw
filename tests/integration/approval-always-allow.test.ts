/**
 * "Always allow" on an approval card (0.30.1): an owner or admin approves an
 * action ask and sets the requesting agent's own permission for that action
 * to "allowed" in one PATCH. Members and viewers cannot; task closes are not
 * permissions; the company defaults are untouched.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, mcpClientFor, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function world() {
    await resetDb();
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Always Co", createdByUserId: creator.id }).returning();
    const agent = await seedAgent(company.id, { name: "Mailer" });
    return { companyId: company.id, agent, owner: await seedHuman(company.id, "owner") };
}

async function patch(approvalId: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/approvals/[id]/route");
    return call(route.PATCH as never, `/api/approvals/${approvalId}`, { method: "PATCH", body, params: { id: approvalId } });
}

async function card(approvalId: string) {
    const route = await import("@/app/api/approvals/[id]/card/route");
    return (await call(route.GET as never, `/api/approvals/${approvalId}/card`, { params: { id: approvalId } })).json.card as Record<string, unknown>;
}

async function rows(companyId: string) {
    const db = await getDb();
    const { agents, companies, approvals, auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    return {
        agentPolicies: (await db.select().from(agents).where(eq(agents.companyId, companyId)))[0].actionPoliciesJson,
        companyPolicies: (await db.select().from(companies).where(eq(companies.id, companyId)))[0].actionPoliciesJson,
        approvals: await db.select().from(approvals).where(eq(approvals.companyId, companyId)),
        audit: (await db.select().from(auditLog).where(eq(auditLog.companyId, companyId))).filter((r) => r.action === "agent.permission_changed"),
    };
}

const details = { to: "client@example.com", subject: "Quote" };

maybe("owner always-allow approves the ask and sets the agent's permission to allowed", async () => {
    const w = await world();
    const mcp = await mcpClientFor(w.companyId, w.agent.id);
    const asked = JSON.parse((await mcp.tool("check_action", { action: "send_email", details })).text);
    assert.equal(asked.decision, "approval_pending");
    const approvalId = String(asked.approvalId);

    actAs(w.owner);
    try {
        const before = await card(approvalId);
        assert.equal(before.mayAlwaysAllow, true);
        assert.equal(before.alwaysAllowed, false);

        const res = await patch(approvalId, { status: "approved", alwaysAllow: true });
        assert.equal(res.status, 200, res.text);
        const after = await card(approvalId);
        assert.equal(after.status, "approved");
        assert.equal(after.alwaysAllowed, true);
        assert.equal(after.mayAlwaysAllow, false);
    } finally {
        actAs(null);
    }

    const state = await rows(w.companyId);
    assert.deepEqual(state.agentPolicies, { send_email: "allowed" });
    assert.deepEqual(state.companyPolicies ?? {}, {}, "company defaults untouched");
    assert.equal(state.audit.length, 1, "the permission change is recorded");
    assert.equal(state.audit[0].actorId, w.owner.userId);

    // The agent was told, and other emails now go through without a new approval.
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const told = (await db.select().from(threadMessages).where(eq(threadMessages.companyId, w.companyId)))
        .find((m) => (m.metadataJson as Record<string, unknown>).approvalDecision === "approved");
    assert.ok(told && /without asking/.test(told.text), told?.text);

    const again = JSON.parse((await mcp.tool("check_action", { action: "send_email", details: { ...details, subject: "Another" } })).text);
    assert.equal(again.mayProceed, true, JSON.stringify(again));
    assert.equal((await rows(w.companyId)).approvals.length, 1, "no new approval");
});

maybe("members and viewers get 403 for alwaysAllow; the ask stays pending", async () => {
    const w = await world();
    const mcp = await mcpClientFor(w.companyId, w.agent.id);
    const approvalId = String(JSON.parse((await mcp.tool("check_action", { action: "send_email", details })).text).approvalId);
    for (const role of ["member", "viewer"] as const) {
        actAs(await seedHuman(w.companyId, role));
        try {
            assert.notEqual((await card(approvalId)).mayAlwaysAllow, true, `${role} is not offered always-allow`);
            const res = await patch(approvalId, { status: "approved", alwaysAllow: true });
            assert.equal(res.status, 403, `${role}: ${res.text}`);
        } finally {
            actAs(null);
        }
    }
    const state = await rows(w.companyId);
    assert.equal(state.approvals[0].status, "pending");
    assert.deepEqual(state.agentPolicies ?? {}, {});
});

maybe("alwaysAllow is 400 on a task close and with a rejection", async () => {
    const w = await world();
    const db = await getDb();
    const { projects, tasks } = await getSchema();
    const [project] = await db.insert(projects).values({ companyId: w.companyId, goal: "Launch", status: "active" }).returning();
    const [task] = await db.insert(tasks).values({ companyId: w.companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: w.agent.id, inputJson: { title: "Ship" } }).returning();
    const { requestApprovalForTasks } = await import("@/lib/approvals");
    const done = await requestApprovalForTasks({ companyId: w.companyId, taskIds: [task.id], requesterAgentId: w.agent.id, rationale: "Done", actionType: "task_done" });

    actAs(w.owner);
    try {
        assert.equal((await card(done!.id)).mayAlwaysAllow, false);
        assert.equal((await patch(done!.id, { status: "approved", alwaysAllow: true })).status, 400);

        const mcp = await mcpClientFor(w.companyId, w.agent.id);
        const ask = String(JSON.parse((await mcp.tool("check_action", { action: "send_email", details })).text).approvalId);
        assert.equal((await patch(ask, { status: "rejected", alwaysAllow: true })).status, 400);
    } finally {
        actAs(null);
    }
    assert.ok((await rows(w.companyId)).approvals.every((a) => a.status === "pending"));
});
