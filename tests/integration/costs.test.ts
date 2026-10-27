import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken, seedPricing } from "./_helper";
import { actAs, call, seedHuman, seedTwoTenantsOfWork } from "./_access-helper";

/**
 * Costs (roadmap 11.2): totals by client / project / model / agent reconcile
 * with the overall total (chat runs in a Chat (no task) bucket); a restricted
 * member only counts their in-scope clients' task runs and their in-scope
 * agents' chat runs, and never sees an out-of-scope agent's name; another
 * company's runs never leak in; the CSV export enforces the same access.
 */
const maybe = dbAvailable ? test : test.skip;
const DAY = 86_400_000;

async function seedRun(companyId: string, values: Record<string, unknown>) {
    const db = await getDb();
    const { agentRuns } = await getSchema();
    await db.insert(agentRuns).values({
        id: randomUUID(), companyId, status: "succeeded", startedAt: new Date(Date.now() - DAY), ...values,
    } as typeof agentRuns.$inferInsert);
}

async function seedWorld() {
    await resetDb();
    await seedPricing("deepseek-chat", 27, 110);
    const { companyId } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const agentIn = await seedAgent(companyId, { name: "Agent In" });
    const agentOut = await seedAgent(companyId, { name: "Agent Out" });
    // Reported cost on the in-scope client's task.
    await seedRun(companyId, { agentId: agentIn.id, taskId: work.taskIn.id, model: "deepseek-chat", provider: "deepseek", inputTokens: 1000, outputTokens: 100, costCents: 12 });
    // Estimated (no runtime cost): 1M in * 27 + 1M out * 110 = 137 cents, by the out-of-scope agent on the in-scope task.
    await seedRun(companyId, { agentId: agentOut.id, taskId: work.taskIn.id, model: "deepseek-chat", provider: "deepseek", inputTokens: 1_000_000, outputTokens: 1_000_000 });
    // Out-of-scope client's task.
    await seedRun(companyId, { agentId: agentOut.id, taskId: work.taskOut.id, model: "deepseek-chat", provider: "deepseek", inputTokens: 10, outputTokens: 10, costCents: 40 });
    // Chat (no task) runs, one per agent; the out-of-scope one is unpriced.
    await seedRun(companyId, { agentId: agentIn.id, threadId: randomUUID(), model: "deepseek-chat", provider: "deepseek", inputTokens: 5, outputTokens: 5, costCents: 3 });
    await seedRun(companyId, { agentId: agentOut.id, threadId: randomUUID(), model: "secret-model", provider: "custom", inputTokens: 500, outputTokens: 500 });
    // A deleted task's run, and one outside the 30-day range.
    await seedRun(companyId, { agentId: agentIn.id, taskId: randomUUID(), model: "deepseek-chat", provider: "deepseek", inputTokens: 1, outputTokens: 1, costCents: 5 });
    await seedRun(companyId, { agentId: agentIn.id, taskId: work.taskIn.id, costCents: 9999, startedAt: new Date(Date.now() - 60 * DAY) });

    // Another company: its runs must never show up.
    const other = await seedCompanyWithToken();
    const otherAgent = await seedAgent(other.companyId, { name: "Other Co Agent" });
    await seedRun(other.companyId, { agentId: otherAgent.id, taskId: work.taskIn.id, costCents: 777, model: "deepseek-chat" });
    await seedRun(other.companyId, { agentId: otherAgent.id, costCents: 888 });

    return { companyId, otherCompanyId: other.companyId, work, agentIn, agentOut };
}

function csvRows(text: string) {
    return text.trim().split("\r\n").map((line) => line.split(","));
}

maybe("owners see every run; every tab's groups add up to the overall total; other companies never leak", async () => {
    const { companyId, work } = await seedWorld();
    const { loadCostsView } = await import("@/lib/costs-reads");
    const { resolveRange, COST_DIMENSIONS, CHAT_KEY, UNKNOWN_TASK_KEY } = await import("@/lib/costs");
    const range = resolveRange("30d", new Date());
    const viewer = { companyId, scope: null };
    for (const dimension of COST_DIMENSIONS) {
        const view = await loadCostsView(viewer, dimension, range, {});
        assert.equal(view.total.runs, 6, dimension);
        assert.ok(Math.abs(view.total.costCents - (12 + 137 + 40 + 3 + 5)) < 1e-9, `${dimension} total`);
        const sum = view.groups.reduce((acc, group) => acc + group.costCents, 0);
        assert.ok(Math.abs(sum - view.total.costCents) < 1e-9, `${dimension} reconciles`);
        assert.equal(view.groups.reduce((acc, group) => acc + group.runs, 0), 6);
    }
    const byClient = await loadCostsView(viewer, "customer", range, {});
    const keys = new Map(byClient.groups.map((group) => [group.key, group]));
    assert.equal(keys.get(CHAT_KEY)?.runs, 2);
    assert.equal(keys.get(UNKNOWN_TASK_KEY)?.costCents, 5);
    assert.ok(Math.abs(keys.get(work.customerIn.id)!.costCents - 149) < 1e-9);
    assert.equal(keys.get(work.customerIn.id)?.label, "Customer In");
    assert.equal(byClient.total.basis.unpriced.runs, 1);
    assert.ok(Math.abs(byClient.total.basis.estimated.costCents - 137) < 1e-9);

    // Drill-down: client -> projects -> tasks.
    const projects = await loadCostsView(viewer, "project", range, { customer: work.customerIn.id });
    assert.deepEqual(projects.groups.map((group) => group.key), [work.projectIn.id]);
    const taskView = await loadCostsView(viewer, "task", range, { project: work.projectIn.id });
    assert.deepEqual(taskView.groups.map((group) => [group.key, group.label]), [[work.taskIn.id, "Task In"]]);
    assert.equal(taskView.filterLabels.project, "Project In");

    const json = JSON.stringify(await loadCostsView(viewer, "agent", range, {}));
    assert.ok(!json.includes("Other Co Agent") && !json.includes("777") && !json.includes("888"), "another company's runs never leak");
});

maybe("a restricted member counts only in-scope clients' task runs and in-scope agents' chat runs", async () => {
    const { companyId, work, agentIn, agentOut } = await seedWorld();
    const { loadCostsView } = await import("@/lib/costs-reads");
    const { resolveRange, CHAT_KEY, OTHER_AGENTS_KEY } = await import("@/lib/costs");
    const scope = { mode: "restricted" as const, agentIds: [agentIn.id], customerIds: [work.customerIn.id] };
    const range = resolveRange("30d", new Date());
    const view = await loadCostsView({ companyId, scope }, "customer", range, {});
    // taskIn (12 + 137) + agentIn chat (3); not taskOut, the other agent's chat, or the deleted task.
    assert.equal(view.total.runs, 3);
    assert.ok(Math.abs(view.total.costCents - 152) < 1e-9);
    assert.deepEqual(view.groups.map((group) => group.key).sort(), [CHAT_KEY, work.customerIn.id].sort());
    const agentsView = await loadCostsView({ companyId, scope }, "agent", range, {});
    const agentKeys = agentsView.groups.map((group) => group.key).sort();
    assert.deepEqual(agentKeys, [agentIn.id, OTHER_AGENTS_KEY].sort());
    const json = JSON.stringify(agentsView);
    assert.ok(!json.includes("Agent Out") && !json.includes(agentOut.id), "out-of-scope agent stays anonymous");
    assert.ok(!json.includes("Customer Out") && !json.includes("secret-model"));
    // A scope with nothing ticked sees nothing.
    const empty = await loadCostsView({ companyId, scope: { mode: "restricted", agentIds: [], customerIds: [] } }, "customer", range, {});
    assert.equal(empty.total.runs, 0);
});

maybe("CSV export: signed-out is refused, viewers may export, restricted members get only their scope", async () => {
    const { companyId, work, agentIn } = await seedWorld();
    const route = await import("@/app/api/costs/export/route");
    actAs(null);
    assert.equal((await call(route.GET, "/api/costs/export?tab=customer&range=30d")).status, 401);

    const viewer = await seedHuman(companyId, "viewer");
    actAs(viewer);
    const res = await call(route.GET, "/api/costs/export?tab=customer&range=30d");
    assert.equal(res.status, 200);
    const rows = csvRows(res.text);
    assert.equal(rows[0][0], "Client");
    assert.equal(rows[rows.length - 1][0], "Total");
    assert.equal(rows[rows.length - 1][2], "6");
    assert.ok(res.text.includes("Chat (no task)"));
    assert.equal((await call(route.GET, "/api/costs/export?tab=budgets")).status, 400);

    const restricted = await seedHuman(companyId, "member", { scope: { mode: "restricted", agentIds: [agentIn.id], customerIds: [work.customerIn.id] } });
    actAs(restricted);
    const scoped = await call(route.GET, "/api/costs/export?tab=project&range=30d");
    assert.equal(scoped.status, 200);
    assert.ok(scoped.text.includes("Project In") && !scoped.text.includes("Project Out"));
    assert.equal(csvRows(scoped.text).at(-1)?.[2], "3");
    // Asking for an out-of-scope client by id returns an empty view, not its numbers.
    const probe = await call(route.GET, `/api/costs/export?tab=project&range=30d&customer=${work.customerOut.id}`);
    assert.equal(csvRows(probe.text).at(-1)?.[2], "0");
    assert.ok(!probe.text.includes("Project Out"));

    // A member of another company sees only their own company.
    const stranger = await seedHuman((await seedCompanyWithToken()).companyId, "owner");
    actAs(stranger);
    const foreign = await call(route.GET, "/api/costs/export?tab=customer&range=30d");
    assert.equal(csvRows(foreign.text).at(-1)?.[2], "0");
    actAs(null);
});

maybe("model pricing is instance-wide: company owners and admins are refused, an instance admin edits it and it is audited", async () => {
    const { companyId } = await seedWorld();
    const route = await import("@/app/api/ui/pricing/route");
    const body = { provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat", inputPricePer1k: 1, outputPricePer1k: 2 };

    for (const role of ["owner", "admin"] as const) {
        actAs(await seedHuman(companyId, role));
        const denied = await call(route.POST, "/api/ui/pricing", { method: "POST", body });
        assert.equal(denied.status, 403, `a company ${role} edited instance-wide pricing`);
        assert.equal((await call(route.GET as never, "/api/ui/pricing")).status, 200, `a company ${role} could not read pricing`);
    }

    const instanceAdmin = await seedHuman(companyId, "member", { instanceRole: "instance_admin" });
    actAs(instanceAdmin);
    const saved = await call(route.POST, "/api/ui/pricing", { method: "POST", body });
    assert.equal(saved.status, 200);
    const pricing = saved.json.pricing as { id: string; inputPricePer1k: number };
    assert.equal(pricing.inputPricePer1k, 1);
    actAs(null);

    const db = await getDb();
    const { auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [entry] = await db.select().from(auditLog).where(eq(auditLog.targetId, pricing.id));
    assert.ok(entry, "the pricing change was not audited");
    assert.equal(entry.action, "pricing.updated");
    assert.equal(entry.targetType, "pricing");
    assert.equal(entry.actorId, instanceAdmin.userId);
    assert.deepEqual(entry.payloadJson, {
        before: { inputPricePer1k: 27, outputPricePer1k: 110 },
        after: { inputPricePer1k: 1, outputPricePer1k: 2 },
        meta: { label: "DeepSeek Chat" },
    });
});
