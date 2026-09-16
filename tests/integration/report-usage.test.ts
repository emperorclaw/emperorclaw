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

async function preflight(rawToken: string, agentId: string) {
    const { GET } = await import("@/app/api/mcp/agents/[id]/route");
    return GET(makeRequest(`http://localhost/api/mcp/agents/${agentId}`, {
        headers: { authorization: `Bearer ${rawToken}` },
    }), { params: Promise.resolve({ id: agentId }) });
}

maybe("budget preflight blocks overspend even when status was manually reactivated", async () => {
    await resetDb();
    await seedPricing("deepseek-v4-flash", 14, 28);
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { monthlyBudgetCents: 10, monthlyCostCents: 11 });
    const res = await preflight(rawToken, agent.id);
    assert.equal(res.status, 200);
    const { agent: result } = await res.json();
    assert.equal(result.executionAllowed, false);
    assert.equal(result.budgetStatus, "paused");
    assert.equal("llmApiKeyEncrypted" in result, false);
});

maybe("budget preflight resets last month's paused agent before dispatch", async () => {
    await resetDb();
    await seedPricing("deepseek-v4-flash", 14, 28);
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { monthlyBudgetCents: 10, monthlyCostCents: 11,
        budgetStatus: "paused", lastResetMonth: "2020-01" });
    const results = await Promise.all([preflight(rawToken, agent.id), preflight(rawToken, agent.id)]);
    for (const res of results) {
        const { agent: result } = await res.json();
        assert.equal(result.executionAllowed, true);
        assert.equal(result.monthlyCostCents, 0);
        assert.equal(result.lastResetMonth, new Date().toISOString().slice(0, 7));
    }
});

maybe("budget preflight rejects missing pricing, invalid auth and foreign agents", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const other = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { monthlyBudgetCents: 10, llmModel: "unknown" });
    assert.equal((await (await preflight(rawToken, agent.id)).json()).agent.executionAllowed, false);
    assert.equal((await preflight(other.rawToken, agent.id)).status, 404);
    assert.equal((await preflight("invalid", agent.id)).status, 401);
});

maybe("report-usage serializes concurrent increments and monthly rollover", async () => {
    await resetDb();
    await seedPricing("deepseek-v4-flash", 14, 28);
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { monthlyBudgetCents: 40, monthlyCostCents: 99,
        lastResetMonth: "2020-01", budgetStatus: "paused" });
    const { POST } = await import("@/app/api/mcp/agents/report-usage/route");
    const results = await Promise.all(Array.from({ length: 10 }, () => POST(makeRequest("http://localhost/api/mcp/agents/report-usage", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` },
        body: { agentId: agent.id, inputTokens: 1_000_000, outputTokens: 0 },
    }))));
    assert.ok(results.every(r => r.status === 200));
    const result = (await (await preflight(rawToken, agent.id)).json()).agent;
    assert.equal(result.monthlyCostCents, 140);
    assert.equal(result.monthlyTokenUsage, 10_000_000);
    assert.equal(result.budgetStatus, "paused");
    const db = await getDb();
    const { tokenUsageLog } = await getSchema();
    const logs = await db.select().from(tokenUsageLog);
    assert.equal(logs.length, 10); // no duplicate monthly summary cost
});

maybe("report-usage rejects unpriced models for capped agents and prices the reported model without changing config", async () => {
    await resetDb();
    await seedPricing("actual-model", 100, 200);
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { monthlyBudgetCents: 1000 });
    const { POST } = await import("@/app/api/mcp/agents/report-usage/route");
    const report = (model: string) => POST(makeRequest("http://localhost/api/mcp/agents/report-usage", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` },
        body: { agentId: agent.id, model, inputTokens: 1_000_000 },
    }));
    assert.equal((await report("unknown")).status, 422);
    const res = await report("actual-model");
    assert.equal(res.status, 200);
    assert.equal((await res.json()).costCents, 100); // omitted output means zero
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    assert.equal(row.llmModel, "deepseek-v4-flash");
});

maybe("report-usage records unpriced usage for uncapped agents instead of wedging them", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId); // no budget → nothing to enforce
    const { POST } = await import("@/app/api/mcp/agents/report-usage/route");
    const res = await POST(makeRequest("http://localhost/api/mcp/agents/report-usage", {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` },
        body: { agentId: agent.id, model: "unknown", inputTokens: 1_000_000 },
    }));
    // Rejecting here used to 422, which made the bridge retain the sample and
    // block every later dispatch — a permanent wedge for a model-less agent.
    assert.equal(res.status, 200);
    assert.equal((await res.json()).costCents, 0);
});
