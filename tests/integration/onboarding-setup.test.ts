import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

maybe("the lead agent's first job documents the company, once, and its progress is visible", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const lead = await seedAgent(companyId, { name: "Boss", provider: "hermes" });
    const { startCompanyDocumentation, documentationProgress } = await import("@/lib/onboarding");

    const first = await startCompanyDocumentation({ companyId, agentId: lead.id, website: "https://acme.example" });
    assert.equal(first.created, true);
    const again = await startCompanyDocumentation({ companyId, agentId: lead.id, website: null });
    assert.equal(again.taskId, first.taskId, "a second click reuses the open task");
    assert.equal(again.created, false);

    const db = await getDb();
    const { threadMessages, tasks } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const messages = await db.select().from(threadMessages).where(eq(threadMessages.companyId, companyId));
    assert.equal(messages.length, 1);
    assert.equal(messages[0].targetAgentId, lead.id);
    assert.equal(messages[0].deliveryState, "queued", "runtimes pick it up");
    assert.match(messages[0].text, /https:\/\/acme\.example/);
    assert.ok(messages[0].text.includes(`emperor://task/${first.taskId}`));
    const [task] = await db.select().from(tasks).where(eq(tasks.id, first.taskId));
    assert.equal(task.assignedAgentId, lead.id);

    // Notes the agent writes show up as progress.
    const { createScopedResource } = await import("@/lib/resources");
    await createScopedResource({
        companyId, scopeType: "company", scopeId: null, provider: "knowledge", resourceType: "knowledge_base",
        name: "products-and-services", displayName: "Products & Services", path: "Company", configText: "# Products", status: "active",
        ownership: "managed", isShared: true, changeSummary: "test", createdByType: "agent", createdById: lead.id,
    } as Parameters<typeof createScopedResource>[0]);
    const progress = await documentationProgress(companyId, first.taskId);
    assert.ok(progress);
    assert.equal(progress!.state, "inbox");
    assert.deepEqual(progress!.notesTouched, ["Products & Services"]);
    void userId;
});

maybe("a model key is checked before agents start; unknown providers never block", async () => {
    const { validateLlmKey } = await import("@/lib/onboarding");
    assert.equal((await validateLlmKey("openrouter", "  ")).ok, false);
    assert.equal((await validateLlmKey("someprovider", "abc")).ok, null);
});
