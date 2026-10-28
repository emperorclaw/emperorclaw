/**
 * Security review of local Hermes mode (2026-10): an agent's stored model key
 * only ever goes to the endpoint it was given for. Members cannot change the
 * provider, base URL, model or key; an admin who changes the provider or base
 * URL must supply that endpoint's key (or none, explicitly); the MCP update
 * path never moves a stored key to another provider; base URLs and model
 * names are checked before they are stored; the activity log records the
 * endpoint host and that the key changed, never the key.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent } from "./_helper";
import { actAs, call, seedHuman, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

const ORIGINAL_URL = "http://host.docker.internal:11434/v1";
const ORIGINAL_KEY = "sk-original-secret-key";

async function setup() {
    process.env.EMPEROR_CLAW_MASTER_KEY ??= "a".repeat(64);
    await resetDb();
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `creator-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [company] = await db.insert(companies).values({ name: "Key Co", createdByUserId: creator.id }).returning();
    const { encryptSecretPayload } = await import("@/lib/secrets");
    const encrypted = encryptSecretPayload({ apiKey: ORIGINAL_KEY, baseUrl: ORIGINAL_URL })!;
    const agent = await seedAgent(company.id, {
        name: "Local", provider: "hermes", deploymentMode: "local", llmProvider: "custom", llmModel: "llama3.1:8b",
        llmApiKeyEncrypted: encrypted.encryptedSecret, llmApiKeyVersion: encrypted.keyVersion,
    });
    return { companyId: company.id, agentId: agent.id };
}

async function stored(agentId: string) {
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { decryptSecretPayload } = await import("@/lib/secrets");
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    return { row, secret: row.llmApiKeyEncrypted ? decryptSecretPayload(row.llmApiKeyEncrypted) as Record<string, unknown> : null };
}

async function patch(agentId: string, body: Record<string, unknown>) {
    const route = await import("@/app/api/agents/[id]/route");
    return call(route.PATCH, `/api/agents/${agentId}`, { method: "PATCH", body, params: { id: agentId } });
}

maybe("a member cannot change the provider, base URL, model or key (the exfiltration path is closed)", async () => {
    const { companyId, agentId } = await setup();
    const member = await seedHuman(companyId, "member");
    actAs(member);
    try {
        // The reported attack: point the stored key at a host the member controls.
        const attack = await patch(agentId, { llmProvider: "custom", llmBaseUrl: "https://evil.example/v1" });
        assert.equal(attack.status, 403, attack.text);
        for (const body of [{ llmProvider: "openai" }, { llmBaseUrl: "https://evil.example/v1" }, { llmModel: "gpt-4o-mini" }, { llmApiKey: "sk-member" }, { llmApiKey: null }, { llmApiKey: "" }]) {
            const res = await patch(agentId, body);
            assert.equal(res.status, 403, `${JSON.stringify(body)}: ${res.text}`);
        }
        const { row, secret } = await stored(agentId);
        assert.deepEqual(secret, { apiKey: ORIGINAL_KEY, baseUrl: ORIGINAL_URL }, "nothing changed");
        assert.equal(row.llmProvider, "custom");
        assert.equal(row.llmModel, "llama3.1:8b");
        // Other fields stay editable for members.
        const budget = await patch(agentId, { monthlyBudgetCents: 500 });
        assert.equal(budget.status, 200, budget.text);
    } finally {
        actAs(null);
    }
});

maybe("an admin changing the provider or base URL must bring that endpoint's key; the old key never follows", async () => {
    const { companyId, agentId } = await setup();
    const admin = await seedHuman(companyId, "admin");
    actAs(admin);
    try {
        // New base URL, no key: refused, the stored key is untouched.
        const urlOnly = await patch(agentId, { llmBaseUrl: "https://llm.example.com/v1" });
        assert.equal(urlOnly.status, 400, urlOnly.text);
        assert.match(String(urlOnly.json.error), /needs that endpoint's API key/);
        // New provider, no key: refused too.
        const providerOnly = await patch(agentId, { llmProvider: "openai" });
        assert.equal(providerOnly.status, 400, providerOnly.text);
        // A model of another provider changes the provider as well: same rule.
        const db = await getDb();
        const { llmPricing } = await getSchema();
        await db.insert(llmPricing).values({ provider: "openai", model: "gpt-4o-mini", label: "GPT-4o mini", inputPricePer1k: 1, outputPricePer1k: 2 }).onConflictDoNothing();
        const modelHop = await patch(agentId, { llmProvider: "openai", llmModel: "gpt-4o-mini" });
        assert.equal(modelHop.status, 400, modelHop.text);
        assert.deepEqual((await stored(agentId)).secret, { apiKey: ORIGINAL_KEY, baseUrl: ORIGINAL_URL });

        // Explicitly keyless: stored without any key.
        const keyless = await patch(agentId, { llmBaseUrl: "http://192.168.1.50:1234/v1", llmApiKey: null });
        assert.equal(keyless.status, 200, keyless.text);
        let now = await stored(agentId);
        assert.deepEqual(now.secret, { baseUrl: "http://192.168.1.50:1234/v1" });
        assert.ok(!JSON.stringify(now.secret).includes(ORIGINAL_KEY), "the old key is gone");

        // With the new endpoint's key.
        const withKey = await patch(agentId, { llmBaseUrl: "http://10.0.0.7:8000/v1", llmApiKey: "sk-gateway" });
        assert.equal(withKey.status, 200, withKey.text);
        assert.deepEqual((await stored(agentId)).secret, { apiKey: "sk-gateway", baseUrl: "http://10.0.0.7:8000/v1" });

        // Switching to a hosted provider with its key drops the custom base URL.
        const hosted = await patch(agentId, { llmProvider: "openai", llmModel: "gpt-4o-mini", llmApiKey: "sk-openai" });
        assert.equal(hosted.status, 200, hosted.text);
        now = await stored(agentId);
        assert.deepEqual(now.secret, { apiKey: "sk-openai" });
        assert.equal(now.row.llmProvider, "openai");

        // A key rotation on the same endpoint and a model change within it need nothing else.
        assert.equal((await patch(agentId, { llmApiKey: "sk-openai-2" })).status, 200);
        assert.equal((await patch(agentId, { llmModel: "gpt-4o-mini" })).status, 200);
        assert.deepEqual((await stored(agentId)).secret, { apiKey: "sk-openai-2" });

        // Clearing the provider drops the key.
        assert.equal((await patch(agentId, { llmProvider: "" })).status, 200);
        now = await stored(agentId);
        assert.equal(now.row.llmApiKeyEncrypted, null);
        assert.equal(now.row.llmProvider, null);

        // Back to custom requires a base URL.
        assert.equal((await patch(agentId, { llmProvider: "custom", llmModel: "m" })).status, 400);
    } finally {
        actAs(null);
    }
});

maybe("base URLs and model names are checked before they are stored", async () => {
    const { companyId, agentId } = await setup();
    const owner = await seedHuman(companyId, "owner");
    actAs(owner);
    try {
        for (const llmBaseUrl of ["http://169.254.169.254/latest", "http://[::ffff:169.254.169.254]/v1", "http://2852039166/v1", "http://metadata.google.internal./v1", "http://postgres:5432/v1", "http://0.0.0.0:11434/v1"]) {
            const res = await patch(agentId, { llmBaseUrl, llmApiKey: "sk-x" });
            assert.equal(res.status, 400, `${llmBaseUrl}: ${res.text}`);
        }
        for (const llmModel of ["gpt\nset\tmodel.base_url\thttp://evil", "a\tb", "x".repeat(201), "name with spaces", 7]) {
            const res = await patch(agentId, { llmModel });
            assert.equal(res.status, 400, `${JSON.stringify(llmModel)}: ${res.text}`);
        }
        for (const llmModel of ["qwen2.5-coder:32b-instruct-q4_K_M", "deepseek/deepseek-chat", "llama3.1:8b"]) {
            const res = await patch(agentId, { llmModel });
            assert.equal(res.status, 200, `${llmModel}: ${res.text}`);
        }
        assert.deepEqual((await stored(agentId)).secret, { apiKey: ORIGINAL_KEY, baseUrl: ORIGINAL_URL });

        const { POST } = await import("@/app/api/agents/route");
        const created = await call(POST, "/api/agents", { method: "POST", body: { name: "Bad Model", llmModel: "x\ny" } });
        assert.equal(created.status, 400, created.text);
    } finally {
        actAs(null);
    }
});

maybe("MCP updates never move a stored key to another provider and check the model name", async () => {
    const { companyId, agentId } = await setup();
    const token = await seedMcpToken(companyId, null);
    const { PATCH } = await import("@/app/api/mcp/agents/[id]/route");
    const send = (body: Record<string, unknown>) => PATCH(makeRequest(`http://localhost/api/mcp/agents/${agentId}`, {
        method: "PATCH",
        headers: { authorization: `Bearer ${token}`, "idempotency-key": randomUUID() },
        body,
    }), { params: Promise.resolve({ id: agentId }) });

    const hop = await send({ llmProvider: "openai" });
    assert.equal(hop.status, 400, await hop.text());
    const badModel = await send({ llmModel: "m\nset\tx\ty" });
    assert.equal(badModel.status, 400, await badModel.text());
    const sameProvider = await send({ llmModel: "qwen3:4b" });
    assert.equal(sameProvider.status, 200, await sameProvider.text());
    const { row, secret } = await stored(agentId);
    assert.equal(row.llmProvider, "custom");
    assert.equal(row.llmModel, "qwen3:4b");
    assert.deepEqual(secret, { apiKey: ORIGINAL_KEY, baseUrl: ORIGINAL_URL });
});

maybe("the activity log records the endpoint host and a key change, never the key or the URL path", async () => {
    const { companyId, agentId } = await setup();
    const admin = await seedHuman(companyId, "admin");
    actAs(admin);
    try {
        const res = await patch(agentId, { llmBaseUrl: "http://ollama.lan:11434/private/path", llmApiKey: "sk-audited-secret" });
        assert.equal(res.status, 200, res.text);
    } finally {
        actAs(null);
    }
    const db = await getDb();
    const { auditLog } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const rows = await db.select().from(auditLog).where(and(eq(auditLog.companyId, companyId), eq(auditLog.targetId, agentId), eq(auditLog.action, "agent.updated")));
    assert.equal(rows.length, 1);
    const payload = rows[0].payloadJson as { before?: Record<string, unknown>; after?: Record<string, unknown> };
    assert.equal(payload.before?.llmEndpointHost, "host.docker.internal");
    assert.equal(payload.after?.llmEndpointHost, "ollama.lan");
    assert.equal(payload.after?.llmKeyChanged, true);
    const text = JSON.stringify(rows);
    for (const secret of ["sk-audited-secret", ORIGINAL_KEY, "/private/path", "ollama.lan:"]) assert.ok(!text.includes(secret), `${secret} is not in the log`);
});
