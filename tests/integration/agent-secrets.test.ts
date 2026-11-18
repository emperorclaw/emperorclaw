import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { actAs, bearer, call, seedHuman, seedMcpToken } from "./_access-helper";

process.env.EMPEROR_CLAW_MASTER_KEY = "test-master-key";

const maybe = dbAvailable ? test : test.skip;

async function libraryWorld() {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Secret Agent" });
    return { companyId, userId, agent };
}

maybe("set stores a secret, list hides the value, and a second set rotates the version", async () => {
    const { companyId, userId, agent } = await libraryWorld();
    const {
        listAgentSecrets, resolveAgentSecretsForRuntime, setAgentSecret,
    } = await import("@/lib/agent-secrets");

    const first = await setAgentSecret({
        companyId, agentId: agent.id, name: "API_KEY", value: "first-value", exposeToTools: true, userId,
        canSetRoutingNames: true,
    });
    assert.equal(first.name, "API_KEY");
    assert.equal(first.version, 1);
    assert.equal(first.exposeToTools, true);

    const metadata = await listAgentSecrets(companyId, agent.id);
    assert.equal(metadata.length, 1);
    assert.equal(metadata[0].name, "API_KEY");
    assert.equal(metadata[0].version, 1);
    assert.equal("value" in metadata[0], false);
    assert.equal("valueEncrypted" in metadata[0], false);

    const before = await resolveAgentSecretsForRuntime(companyId, agent.id);
    assert.deepEqual(before.secrets, [{ name: "API_KEY", value: "first-value", exposeToTools: true }]);
    assert.deepEqual(before.failed, []);
    assert.match(before.etag, /^[0-9a-f]{64}$/);

    const rotated = await setAgentSecret({
        companyId, agentId: agent.id, name: "API_KEY", value: "second-value", userId,
        canSetRoutingNames: true,
    });
    assert.equal(rotated.version, 2);
    assert.equal(rotated.exposeToTools, true, "omitting exposeToTools keeps the stored flag");

    const after = await resolveAgentSecretsForRuntime(companyId, agent.id);
    assert.deepEqual(after.secrets, [{ name: "API_KEY", value: "second-value", exposeToTools: true }]);
    assert.notEqual(after.etag, before.etag, "a rotated value changes the ETag");
});

maybe("delete soft-deletes the row, hides it from list and resolve, and frees the name", async () => {
    const { companyId, userId, agent } = await libraryWorld();
    const {
        deleteAgentSecret, listAgentSecrets, resolveAgentSecretsForRuntime, setAgentSecret,
    } = await import("@/lib/agent-secrets");

    const secret = await setAgentSecret({ companyId, agentId: agent.id, name: "TOKEN", value: "one", userId, canSetRoutingNames: true });
    assert.equal(await deleteAgentSecret(companyId, agent.id, secret.id), true);
    assert.deepEqual(await listAgentSecrets(companyId, agent.id), []);
    const resolved = await resolveAgentSecretsForRuntime(companyId, agent.id);
    assert.deepEqual(resolved.secrets, []);
    assert.equal(await deleteAgentSecret(companyId, agent.id, secret.id), false, "a second delete finds nothing");

    const recreated = await setAgentSecret({ companyId, agentId: agent.id, name: "TOKEN", value: "two", userId, canSetRoutingNames: true });
    assert.equal(recreated.version, 1, "a recreated name starts over");
    assert.equal(recreated.id === secret.id, false);
});

maybe("a missing master key is a typed error and stores nothing", async () => {
    const { companyId, userId, agent } = await libraryWorld();
    const {
        AgentSecretsUnavailableError, listAgentSecrets, setAgentSecret,
    } = await import("@/lib/agent-secrets");

    const saved = process.env.EMPEROR_CLAW_MASTER_KEY;
    delete process.env.EMPEROR_CLAW_MASTER_KEY;
    try {
        await assert.rejects(
            setAgentSecret({ companyId, agentId: agent.id, name: "API_KEY", value: "plaintext", userId, canSetRoutingNames: true }),
            AgentSecretsUnavailableError,
        );
        assert.deepEqual(await listAgentSecrets(companyId, agent.id), []);
    } finally {
        process.env.EMPEROR_CLAW_MASTER_KEY = saved;
    }
});

maybe("resolve skips an unreadable row and reports its name instead of failing the set", async () => {
    const { companyId, userId, agent } = await libraryWorld();
    const { resolveAgentSecretsForRuntime, setAgentSecret } = await import("@/lib/agent-secrets");

    await setAgentSecret({ companyId, agentId: agent.id, name: "GOOD_ONE", value: "ok", userId, canSetRoutingNames: true });
    const broken = await setAgentSecret({ companyId, agentId: agent.id, name: "BROKEN_ONE", value: "ok", userId, canSetRoutingNames: true });

    const db = await getDb();
    const { agentSecrets } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agentSecrets).set({ valueEncrypted: "not-ciphertext" }).where(eq(agentSecrets.id, broken.id));

    const resolved = await resolveAgentSecretsForRuntime(companyId, agent.id);
    assert.deepEqual(resolved.secrets, [{ name: "GOOD_ONE", value: "ok", exposeToTools: false }]);
    assert.deepEqual(resolved.failed, ["BROKEN_ONE"]);
});

maybe("human routes: a plain member is refused, the agent's owner and an admin are allowed", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    const admin = await seedHuman(companyId, "admin");
    const agentOwner = await seedHuman(companyId, "member");
    const outsider = await seedHuman(companyId, "member");
    const agent = await seedAgent(companyId, { name: "Owned Agent", ownerUserId: agentOwner.userId });

    const listRoute = await import("@/app/api/agents/[id]/env-vars/route");
    const deleteRoute = await import("@/app/api/agents/[id]/env-vars/[secretId]/route");

    actAs({ userId: outsider.userId, sessionId: outsider.sessionId });
    try {
        const refused = await call(listRoute.GET as never, `/api/agents/${agent.id}/env-vars`, { params: { id: agent.id } });
        assert.equal(refused.status, 403);
    } finally {
        actAs(null);
    }

    actAs({ userId: agentOwner.userId, sessionId: agentOwner.sessionId });
    try {
        const created = await call(listRoute.POST as never, `/api/agents/${agent.id}/env-vars`, {
            method: "POST",
            body: { name: "API_KEY", value: "owner-value" },
            params: { id: agent.id },
        });
        assert.equal(created.status, 200);
        const secret = created.json?.secret as { id: string; name: string; version: number };
        assert.equal(secret.name, "API_KEY");
        assert.equal("value" in secret, false);

        const listed = await call(listRoute.GET as never, `/api/agents/${agent.id}/env-vars`, { params: { id: agent.id } });
        assert.equal(listed.status, 200);
        const secrets = listed.json?.secrets as Record<string, unknown>[];
        assert.equal(secrets.length, 1);
        assert.equal("value" in secrets[0], false);

        const removed = await call(deleteRoute.DELETE as never, `/api/agents/${agent.id}/env-vars/${secret.id}`, {
            method: "DELETE",
            params: { id: agent.id, secretId: secret.id },
        });
        assert.equal(removed.status, 204);
    } finally {
        actAs(null);
    }

    actAs({ userId: admin.userId, sessionId: admin.sessionId });
    try {
        const listed = await call(listRoute.GET as never, `/api/agents/${agent.id}/env-vars`, { params: { id: agent.id } });
        assert.equal(listed.status, 200);
    } finally {
        actAs(null);
    }

    actAs({ userId: owner.userId, sessionId: owner.sessionId });
    try {
        const listed = await call(listRoute.GET as never, `/api/agents/${agent.id}/env-vars`, { params: { id: agent.id } });
        assert.equal(listed.status, 200);
    } finally {
        actAs(null);
    }
});

maybe("human routes: a routing name is refused for a non-admin agent owner and accepted for an admin", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const admin = await seedHuman(companyId, "admin");
    const agentOwner = await seedHuman(companyId, "member");
    const agent = await seedAgent(companyId, { name: "Routed Agent", ownerUserId: agentOwner.userId });
    const listRoute = await import("@/app/api/agents/[id]/env-vars/route");
    const { AgentSecretForbiddenError, setAgentSecret } = await import("@/lib/agent-secrets");
    const forbidden = "Only a company owner or admin can set this variable name, because it changes where the agent's runtime sends requests.";

    await assert.rejects(
        setAgentSecret({
            companyId, agentId: agent.id, name: "OPENAI_BASE_URL", value: "https://evil.example.com",
            userId: agentOwner.userId, canSetRoutingNames: false,
        }),
        AgentSecretForbiddenError,
    );

    actAs({ userId: agentOwner.userId, sessionId: agentOwner.sessionId });
    try {
        const refused = await call(listRoute.POST as never, `/api/agents/${agent.id}/env-vars`, {
            method: "POST",
            body: { name: "OPENAI_BASE_URL", value: "https://evil.example.com" },
            params: { id: agent.id },
        });
        assert.equal(refused.status, 403);
        assert.equal(refused.json?.error, forbidden);

        const ordinary = await call(listRoute.POST as never, `/api/agents/${agent.id}/env-vars`, {
            method: "POST",
            body: { name: "PLAIN_SETTING", value: "x" },
            params: { id: agent.id },
        });
        assert.equal(ordinary.status, 200, "the owner can still set a normal name");
    } finally {
        actAs(null);
    }

    actAs({ userId: admin.userId, sessionId: admin.sessionId });
    try {
        const accepted = await call(listRoute.POST as never, `/api/agents/${agent.id}/env-vars`, {
            method: "POST",
            body: { name: "OPENAI_BASE_URL", value: "https://api.openai.com/v1" },
            params: { id: agent.id },
        });
        assert.equal(accepted.status, 200);
    } finally {
        actAs(null);
    }
});

maybe("human routes: a malformed agent id or secret id is a 404, not a database error", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    const agent = await seedAgent(companyId, { name: "Valid Agent" });
    const listRoute = await import("@/app/api/agents/[id]/env-vars/route");
    const deleteRoute = await import("@/app/api/agents/[id]/env-vars/[secretId]/route");

    actAs({ userId: owner.userId, sessionId: owner.sessionId });
    try {
        const badAgent = await call(listRoute.GET as never, "/api/agents/not-a-uuid/env-vars", {
            params: { id: "not-a-uuid" },
        });
        assert.equal(badAgent.status, 404);

        const badCreate = await call(listRoute.POST as never, "/api/agents/not-a-uuid/env-vars", {
            method: "POST",
            body: { name: "API_KEY", value: "value" },
            params: { id: "not-a-uuid" },
        });
        assert.equal(badCreate.status, 404);

        const badSecret = await call(deleteRoute.DELETE as never, `/api/agents/${agent.id}/env-vars/not-a-uuid`, {
            method: "DELETE",
            params: { id: agent.id, secretId: "not-a-uuid" },
        });
        assert.equal(badSecret.status, 404);
    } finally {
        actAs(null);
    }
});

maybe("human routes audit a set and a delete by secret name only", async () => {
    await resetDb();
    const { companyId } = await seedCompanyWithToken();
    const owner = await seedHuman(companyId, "owner");
    const agent = await seedAgent(companyId, { name: "Audited Agent" });
    const listRoute = await import("@/app/api/agents/[id]/env-vars/route");
    const deleteRoute = await import("@/app/api/agents/[id]/env-vars/[secretId]/route");

    actAs({ userId: owner.userId, sessionId: owner.sessionId });
    try {
        const created = await call(listRoute.POST as never, `/api/agents/${agent.id}/env-vars`, {
            method: "POST",
            body: { name: "AUDIT_SECRET", value: "super-secret-value" },
            params: { id: agent.id },
        });
        assert.equal(created.status, 200);
        const secret = created.json?.secret as { id: string };

        const removed = await call(deleteRoute.DELETE as never, `/api/agents/${agent.id}/env-vars/${secret.id}`, {
            method: "DELETE",
            params: { id: agent.id, secretId: secret.id },
        });
        assert.equal(removed.status, 204);
    } finally {
        actAs(null);
    }

    const db = await getDb();
    const { auditLog } = await getSchema();
    const { asc, eq } = await import("drizzle-orm");
    const rows = await db.select().from(auditLog)
        .where(eq(auditLog.companyId, companyId))
        .orderBy(asc(auditLog.createdAt), asc(auditLog.id));
    const secrets = rows.filter((row) => row.action.startsWith("agent_secrets."));
    assert.deepEqual(secrets.map((row) => row.action), ["agent_secrets.set", "agent_secrets.delete"]);
    for (const row of secrets) {
        assert.equal(row.actorType, "human");
        assert.equal(row.actorId, owner.userId);
        assert.equal(row.targetType, "agent");
        assert.equal(row.targetId, agent.id);
        assert.equal((row.payloadJson as { meta?: { label?: string } }).meta?.label, "AUDIT_SECRET");
        assert.equal(JSON.stringify(row.payloadJson).includes("super-secret-value"), false);
    }
});

maybe("runtime route: a company-wide token is refused and an agent token only sees its own agent", async () => {    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const agentA = await seedAgent(companyId, { name: "Agent A" });
    const agentB = await seedAgent(companyId, { name: "Agent B" });
    const { setAgentSecret } = await import("@/lib/agent-secrets");
    await setAgentSecret({ companyId, agentId: agentA.id, name: "A_TOKEN", value: "a-value", userId, canSetRoutingNames: true });
    await setAgentSecret({ companyId, agentId: agentB.id, name: "B_TOKEN", value: "b-value", userId, canSetRoutingNames: true });

    const companyToken = await seedMcpToken(companyId, null);
    const agentToken = await seedMcpToken(companyId, agentA.id);
    const route = await import("@/app/api/mcp/runtime/env-vars/route");
    const url = `/api/mcp/runtime/env-vars?agentId=${agentB.id}`;

    const refused = await call(route.GET as never, url, { headers: bearer(companyToken) });
    assert.equal(refused.status, 403);
    assert.deepEqual(refused.json, { error: "agent_bound_token_required" });

    const allowed = await call(route.GET as never, url, { headers: bearer(agentToken) });
    assert.equal(allowed.status, 200);
    const secrets = allowed.json?.secrets as { name: string; value: string }[];
    assert.deepEqual(secrets, [{ name: "A_TOKEN", value: "a-value", exposeToTools: false }]);

    const etag = allowed.json?.etag as string;
    const cached = await call(route.GET as never, url, {
        headers: { ...bearer(agentToken), "if-none-match": `"${etag}"` },
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.text, "");
    assert.equal(cached.json, null);
});
