/**
 * The local first run (audit 2026-10): the setup wizard stays open through the
 * launch, established workspaces settle it without a migration, a custom
 * OpenAI-compatible endpoint is checked and stored with the agent, a first
 * task needs no project, and the wake names who assigned it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, call, seedHuman } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function company() {
    await resetDb();
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `creator-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [row] = await db.insert(companies).values({ name: "First Run Co", createdByUserId: creator.id }).returning();
    return row.id;
}

maybe("onboarding: a launch in progress keeps the wizard; an established team settles it once", async () => {
    const companyId = await company();
    const owner = await seedHuman(companyId, "owner");
    const db = await getDb();
    const { agents, users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { settleOnboardingForEstablishedTeam, ESTABLISHED_TEAM_AGE_MS } = await import("@/lib/onboarding");

    // The launch just saved its first agent: not settled, the wizard stays.
    const fresh = await seedAgent(companyId, { name: "Boss", provider: "hermes" });
    assert.equal(await settleOnboardingForEstablishedTeam(owner.userId, companyId), false);
    const [before] = await db.select({ completed: users.onboardingCompletedAt }).from(users).where(eq(users.id, owner.userId));
    assert.equal(before.completed, null);

    // An agent older than a day: an existing workspace, settled once.
    await db.update(agents).set({ createdAt: new Date(Date.now() - ESTABLISHED_TEAM_AGE_MS - 60_000) }).where(eq(agents.id, fresh.id));
    assert.equal(await settleOnboardingForEstablishedTeam(owner.userId, companyId), true);
    const [after] = await db.select({ completed: users.onboardingCompletedAt }).from(users).where(eq(users.id, owner.userId));
    assert.ok(after.completed, "marked completed");

    // A dismissal is never rewritten as a completion.
    const admin = await seedHuman(companyId, "admin");
    const dismissedAt = new Date("2026-01-01T00:00:00.000Z");
    await db.update(users).set({ onboardingDismissedAt: dismissedAt }).where(eq(users.id, admin.userId));
    assert.equal(await settleOnboardingForEstablishedTeam(admin.userId, companyId), true);
    const [adminRow] = await db.select({ completed: users.onboardingCompletedAt, dismissed: users.onboardingDismissedAt }).from(users).where(eq(users.id, admin.userId));
    assert.equal(adminRow.completed, null);
    assert.equal(adminRow.dismissed?.toISOString(), dismissedAt.toISOString());
});

function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; url: string }> {
    return new Promise((resolve) => {
        const server = createServer(handler);
        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            resolve({ server, url: `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/v1` });
        });
    });
}

maybe("custom endpoint check: GET {baseUrl}/models with the key, short timeout, no body echoed", async () => {
    const { validateLlmKey } = await import("@/lib/onboarding");
    const seen: (string | undefined)[] = [];
    const ok = await listen((req, res) => {
        seen.push(req.headers.authorization);
        if (req.url !== "/v1/models") { res.writeHead(404).end(); return; }
        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: [{ id: "llama3.1:8b" }, { id: "qwen3:4b" }] }));
    });
    const denied = await listen((_req, res) => { res.writeHead(401, { "Content-Type": "application/json" }).end(JSON.stringify({ error: { message: "Incorrect API key provided: sk-secret" } })); });
    try {
        const works = await validateLlmKey("custom", "sk-local", { baseUrl: ok.url, model: "llama3.1:8b" });
        assert.equal(works.ok, true);
        assert.equal(seen[0], "Bearer sk-local");
        const keyless = await validateLlmKey("custom", "", { baseUrl: `${ok.url}/`, model: "" });
        assert.equal(keyless.ok, true, "a local server needs no key");
        assert.equal(seen[1], undefined);
        const wrongModel = await validateLlmKey("custom", "", { baseUrl: ok.url, model: "gpt-9" });
        assert.equal(wrongModel.ok, null);
        const rejected = await validateLlmKey("custom", "sk-bad", { baseUrl: denied.url });
        assert.deepEqual(rejected, { ok: false, error: "The endpoint rejected this key." });
        assert.equal((await validateLlmKey("custom", "", { baseUrl: "ftp://x/v1" })).ok, false);
    } finally {
        ok.server.close();
        denied.server.close();
    }
    // Nothing listens there: unknown (the agent's container may reach it), with the Docker hint for localhost.
    const unreachable = await validateLlmKey("custom", "", { baseUrl: "http://localhost:9/v1" });
    assert.equal(unreachable.ok, null);
    assert.match(unreachable.ok === null ? unreachable.error : "", /host\.docker\.internal:9\/v1/);
});

maybe("custom endpoint: a key rotation keeps the stored base URL, and the model is not re-attributed", async () => {
    process.env.EMPEROR_CLAW_MASTER_KEY ??= "a".repeat(64);
    const companyId = await company();
    const owner = await seedHuman(companyId, "owner");
    actAs(owner);
    const { encryptSecretPayload, decryptSecretPayload } = await import("@/lib/secrets");
    const db = await getDb();
    const { agents, llmPricing } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.insert(llmPricing).values({ provider: "deepseek", model: "deepseek-chat", label: "DeepSeek Chat", inputPricePer1k: 14, outputPricePer1k: 28 }).onConflictDoNothing();
    const encrypted = encryptSecretPayload({ baseUrl: "http://host.docker.internal:11434/v1" })!;
    const agent = await seedAgent(companyId, { name: "Local", provider: "hermes", deploymentMode: "local", llmProvider: "custom", llmModel: "llama3.1:8b", llmApiKeyEncrypted: encrypted.encryptedSecret, llmApiKeyVersion: encrypted.keyVersion });

    const route = await import("@/app/api/agents/[id]/route");
    const rotated = await call(route.PATCH, `/api/agents/${agent.id}`, { method: "PATCH", body: { llmApiKey: "sk-new", llmModel: "deepseek-chat" }, params: { id: agent.id } });
    assert.equal(rotated.status, 200, rotated.text);
    const [row] = await db.select().from(agents).where(eq(agents.id, agent.id));
    assert.deepEqual(decryptSecretPayload(row.llmApiKeyEncrypted!), { apiKey: "sk-new", baseUrl: "http://host.docker.internal:11434/v1" });
    assert.equal(row.llmProvider, "custom", "a model name served by the endpoint stays on the custom provider");
    assert.equal(row.llmModel, "deepseek-chat");

    const badUrl = await call(route.PATCH, `/api/agents/${agent.id}`, { method: "PATCH", body: { llmBaseUrl: "localhost:11434" }, params: { id: agent.id } });
    assert.equal(badUrl.status, 400);
    actAs(null);
});

maybe("first task: no project yet, it goes into General (created once); the wake names the person", async () => {
    const companyId = await company();
    const member = await seedHuman(companyId, "member");
    const db = await getDb();
    const { projects, threadMessages, users } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    await db.update(users).set({ displayName: "Priya" }).where(eq(users.id, member.userId));
    const agent = await seedAgent(companyId, { name: "Boss", provider: "hermes" });
    actAs(member);
    const { POST } = await import("@/app/api/tasks/route");

    const refused = await call(POST, "/api/tasks", { method: "POST", body: { title: "First" } });
    assert.equal(refused.status, 400, "without the flag a project is still required");

    const description = "## Goal\nShip the **signup** fix.\n\n- one\n- two";
    const first = await call(POST, "/api/tasks", { method: "POST", body: { title: "First", description, useDefaultProject: true, assignedAgentId: agent.id } });
    assert.equal(first.status, 201, first.text);
    const second = await call(POST, "/api/tasks", { method: "POST", body: { title: "Second", useDefaultProject: true } });
    assert.equal(second.status, 201, second.text);
    const general = await db.select().from(projects).where(and(eq(projects.companyId, companyId), eq(projects.goal, "General")));
    assert.equal(general.length, 1);
    const firstTask = (first.json as { task: { projectId: string } }).task;
    assert.equal(firstTask.projectId, general[0].id);

    const wakes = await db.select().from(threadMessages).where(and(eq(threadMessages.companyId, companyId), eq(threadMessages.targetAgentId, agent.id)));
    assert.equal(wakes.length, 1);
    assert.match(wakes[0].text, /Assigned by: "Priya"/);
    assert.ok(wakes[0].text.includes("> ## Goal\n> Ship the **signup** fix.\n>\n> - one\n> - two"), wakes[0].text);

    // A restricted member keeps choosing among their customers' projects.
    const restricted = await seedHuman(companyId, "member", { scope: { mode: "restricted", customerIds: [], agentIds: [] } });
    actAs(restricted);
    const scoped = await call(POST, "/api/tasks", { method: "POST", body: { title: "Mine", useDefaultProject: true } });
    assert.equal(scoped.status, 400);
    actAs(null);
});

maybe("runtime setup outcome is kept on the agent so a failed hire says so", async () => {
    const companyId = await company();
    const agent = await seedAgent(companyId, { name: "Boss", provider: "hermes", metadataJson: { agentWake: { lastWakeAt: 1, pending: [] } } });
    const { recordRuntimeSetup } = await import("@/lib/hermes-provisioning");
    const { runtimeSetupOf } = await import("@/lib/runtime-setup");
    await recordRuntimeSetup(agent.id, { success: false, message: "Image pull failed and no local copy exists." });
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select({ metadataJson: agents.metadataJson }).from(agents).where(eq(agents.id, agent.id));
    assert.equal(runtimeSetupOf(row.metadataJson)?.status, "failed");
    assert.ok((row.metadataJson as Record<string, unknown>).agentWake, "other metadata is kept");
});
