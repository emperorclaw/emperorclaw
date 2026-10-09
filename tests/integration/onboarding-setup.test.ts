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


maybe("starter knowledge creates an unshared filing guide without touching same-name agent notes", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId);
    const { createScopedResource } = await import("@/lib/resources");
    const custom = "# My private filing policy\nPreserve this agent-specific policy.";
    const scoped = await createScopedResource({
        companyId, scopeType: "agent", scopeId: agent.id, provider: "knowledge", resourceType: "knowledge_base",
        name: "workspace-filing-guide", displayName: "Agent filing policy", path: "Agents/Playbooks", configText: custom,
        status: "active", ownership: "managed", isShared: false, createdByType: "system", createdById: null,
    } as Parameters<typeof createScopedResource>[0]);
    const { seedStarterKnowledge, upgradeStarterDoctrine } = await import("@/lib/starter-knowledge");
    const first = await seedStarterKnowledge({ companyId, companyName: "Acme" });
    assert.ok(first.created > 0);
    assert.equal((await seedStarterKnowledge({ companyId, companyName: "Acme" })).created, 0);
    const db = await getDb();
    const { scopedResources, companies } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const rows = await db.select().from(scopedResources).where(and(eq(scopedResources.companyId, companyId), eq(scopedResources.name, "workspace-filing-guide")));
    assert.equal(rows.length, 2);
    const companyGuide = rows.find(row => row.scopeType === "company")!;
    assert.equal(companyGuide.path, "Agents/Playbooks");
    assert.equal(companyGuide.isShared, false, "references must not inflate every prompt");
    assert.match(companyGuide.configText!, /Storage/);
    // Force an old-version upgrade with only the agent-specific name present.
    await db.delete(scopedResources).where(eq(scopedResources.id, companyGuide.id));
    await db.update(companies).set({ starterDoctrineJson: { version: 1, hashes: {} } }).where(eq(companies.id, companyId));
    assert.equal((await upgradeStarterDoctrine({ companyId, companyName: "Acme" })).created, 1);
    const [preserved] = await db.select().from(scopedResources).where(eq(scopedResources.id, scoped.id));
    assert.equal(preserved.configText, custom);
    assert.equal(preserved.scopeId, agent.id);
});
