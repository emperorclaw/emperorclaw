import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, resetDb, makeRequest, seedCompanyWithToken, seedAgent, seedPricing, getDb, getSchema } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

maybe("report-usage increments usage, computes cost, and returns it", async () => {
    await resetDb();
    await seedPricing("deepseek-v4-flash", 14, 28);
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { llmModel: "deepseek-v4-flash", monthlyBudgetCents: 0 });

    const { POST } = await import("@/app/api/mcp/agents/report-usage/route");
    const res = await POST(makeRequest("http://localhost/api/mcp/agents/report-usage", {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}` },
        body: { agentId: agent.id, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    }));
    const json = await res.json();

    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.monthlyTokenUsage, 2_000_000);
    // deepseek-v4-flash seeds at 14 in / 28 out (cents per 1M):
    // 1M*14/1e6 + 1M*28/1e6 = 14 + 28 = 42 cents
    assert.equal(json.costCents, 42);
    assert.equal(json.budgetStatus, "active"); // unlimited budget
});

maybe("report-usage pauses the agent when spend crosses 100% of budget", async () => {
    await resetDb();
    await seedPricing("deepseek-v4-flash", 14, 28);
    const { companyId, rawToken } = await seedCompanyWithToken();
    // Budget = 40 cents; a 42-cent report should push it over 100% → paused.
    const agent = await seedAgent(companyId, { llmModel: "deepseek-v4-flash", monthlyBudgetCents: 40 });

    const { POST } = await import("@/app/api/mcp/agents/report-usage/route");
    const res = await POST(makeRequest("http://localhost/api/mcp/agents/report-usage", {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}` },
        body: { agentId: agent.id, inputTokens: 1_000_000, outputTokens: 1_000_000 },
    }));
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.budgetStatus, "paused");

    // And it's persisted, so the bridge's checkBudget() will see it.
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    assert.equal(row.budgetStatus, "paused");
});

maybe("report-usage rejects an invalid token", async () => {
    await resetDb();
    const { POST } = await import("@/app/api/mcp/agents/report-usage/route");
    const res = await POST(makeRequest("http://localhost/api/mcp/agents/report-usage", {
        method: "POST",
        headers: { authorization: "Bearer ec_not_a_real_token" },
        body: { agentId: "whatever", inputTokens: 10 },
    }));
    assert.equal(res.status, 401);
});

maybe("report-usage cannot touch an agent in another company", async () => {
    await resetDb();
    const a = await seedCompanyWithToken();
    const b = await seedCompanyWithToken();
    const victimAgent = await seedAgent(b.companyId);

    const { POST } = await import("@/app/api/mcp/agents/report-usage/route");
    // Company A's token trying to report usage for Company B's agent.
    const res = await POST(makeRequest("http://localhost/api/mcp/agents/report-usage", {
        method: "POST",
        headers: { authorization: `Bearer ${a.rawToken}` },
        body: { agentId: victimAgent.id, inputTokens: 1000, outputTokens: 1000 },
    }));
    // The agent is not found under company A's scope.
    assert.equal(res.status, 404);
});
