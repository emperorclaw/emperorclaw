import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
    dbAvailable,
    getDb,
    getSchema,
    makeRequest,
    resetDb,
    seedCompanyWithToken,
    seedPricing,
} from "./_helper";

const maybe = dbAvailable ? test : test.skip;

maybe("agent registration and updates keep provider and model coherent", async () => {
    await resetDb();
    await seedPricing("gpt-5-mini", 10, 20, "openai");
    await seedPricing("claude-sonnet", 12, 24, "anthropic");
    const { rawToken } = await seedCompanyWithToken();

    const { POST } = await import("@/app/api/mcp/agents/route");
    const createResponse = await POST(makeRequest("http://localhost/api/mcp/agents", {
        method: "POST",
        headers: {
            authorization: `Bearer ${rawToken}`,
            "idempotency-key": randomUUID(),
        },
        body: {
            name: "Model Test Agent",
            llmModel: "gpt-5-mini",
        },
    }));
    const created = await createResponse.json();

    assert.equal(createResponse.status, 201);
    assert.equal(created.agent.llmProvider, "openai");
    assert.equal(created.agent.llmModel, "gpt-5-mini");

    const patchModule = await import("@/app/api/mcp/agents/[id]/route");
    const updateResponse = await patchModule.PATCH(makeRequest(
        `http://localhost/api/mcp/agents/${created.agent.id}`,
        {
            method: "PATCH",
            headers: {
                authorization: `Bearer ${rawToken}`,
                "idempotency-key": randomUUID(),
            },
            body: {
                llmProvider: "openai",
                llmModel: "claude-sonnet",
            },
        },
    ), { params: Promise.resolve({ id: created.agent.id }) });
    assert.equal(updateResponse.status, 200);

    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [updated] = await db.select().from(agents).where(eq(agents.id, created.agent.id));
    assert.equal(updated.llmProvider, "anthropic");
    assert.equal(updated.llmModel, "claude-sonnet");
});
