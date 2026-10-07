import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

maybe("a runtime reads its live instructions and memory in one call", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Boss", provider: "hermes", doctrineJson: { "AGENTS.md": "Always assign an owner.", "SOUL.md": "Calm and brief." } });
    const { writeAgentMemory } = await import("@/lib/control-plane");
    await writeAgentMemory({ companyId, agentId: agent.id, kind: "preference", content: "Copy Ana on client emails." });

    const route = await import("@/app/api/mcp/agents/[id]/memory/route");
    const res = await route.GET(makeRequest(`http://localhost/api/mcp/agents/${agent.id}/memory`, { headers: { authorization: `Bearer ${rawToken}` } }), { params: Promise.resolve({ id: agent.id }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.instructions, "Always assign an owner.\n\nCalm and brief.", "operating rules first, then persona");
    assert.equal(body.entries.at(-1).content, "Copy Ana on client emails.");
    assert.equal(body.agent.llmApiKeyEncrypted, undefined, "no key material");

    // An agent writes its own memory over MCP.
    const post = await route.POST(makeRequest(`http://localhost/api/mcp/agents/${agent.id}/memory`, {
        method: "POST", headers: { authorization: `Bearer ${rawToken}` }, body: { kind: "lesson", content: "Quotes go through approval." },
    }), { params: Promise.resolve({ id: agent.id }) });
    assert.equal(post.status, 201);
});

maybe("groups keep an icon; bad icons are refused", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const { createGroup, updateGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "human", id: userId }, { title: "Dev team", icon: "💻" });
    assert.equal(group.icon, "💻");
    assert.equal((await updateGroup(companyId, group.id, { icon: "🚀" })).icon, "🚀");
    assert.equal((await updateGroup(companyId, group.id, { icon: "" })).icon, null, "empty goes back to the default");
    await assert.rejects(updateGroup(companyId, group.id, { icon: "this is not an emoji" }), /one emoji/);
});

maybe("avatar helpers keep legacy seeds and point drawn avatars at our endpoint", async () => {
    const { seedFromLegacyUrl, validAvatarUrl, agentAvatarSrc } = await import("@/lib/avatar");
    assert.equal(seedFromLegacyUrl("https://api.dicebear.com/9.x/bottts/svg?seed=agent%201"), "agent 1", "legacy seed survives");
    assert.equal(seedFromLegacyUrl("https://example.com/me.png"), null);
    assert.equal(validAvatarUrl("http://example.com/x.png"), null, "https only");
    assert.equal(validAvatarUrl("javascript:alert(1)"), null);
    assert.equal(agentAvatarSrc({ id: "abc", avatarUrl: null }), "/api/avatars/abc");
    assert.equal(agentAvatarSrc({ id: "abc", avatarUrl: "https://example.com/me.png" }), "https://example.com/me.png", "uploaded photos win");
});
