import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, resetDb, makeRequest, getDb, getSchema } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

async function register(body: unknown) {
    const { POST } = await import("@/app/api/auth/register/route");
    const res = await POST(makeRequest("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.1" },
        body,
    }));
    return { res, json: await res.json() };
}

maybe("bootstrap: first signup creates the instance and is auto-verified", async () => {
    await resetDb();
    const { res, json } = await register({
        email: "admin@example.com",
        password: "supersecret",
        companyName: "Acme",
        acceptBetaDisclaimer: true,
    });
    assert.equal(res.status, 201);
    assert.equal(json.instanceCreated, true);

    const db = await getDb();
    const { users } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [user] = await db.select().from(users).where(eq(users.email, "admin@example.com"));
    assert.ok(user.emailVerifiedAt, "first admin must be auto-verified (no SMTP lockout)");
    assert.equal(user.instanceRole, "instance_admin");
});

maybe("open registration auto-verifies when SMTP is not configured", async () => {
    await resetDb();
    // Bootstrap first, then flip to open registration.
    await register({ email: "admin@example.com", password: "supersecret", companyName: "Acme", acceptBetaDisclaimer: true });
    const db = await getDb();
    const { instanceSettings } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(instanceSettings).set({ value: "open" }).where(eq(instanceSettings.key, "registration_mode"));

    const { res, json } = await register({ email: "member@example.com", password: "supersecret" });
    assert.equal(res.status, 201);
    assert.equal(json.emailVerificationRequired, false, "no SMTP → account should be auto-verified");

    const { users } = await getSchema();
    const [member] = await db.select().from(users).where(eq(users.email, "member@example.com"));
    assert.ok(member.emailVerifiedAt, "member should be able to log in immediately");
});

maybe("registration rejects duplicate email", async () => {
    await resetDb();
    await register({ email: "admin@example.com", password: "supersecret", companyName: "Acme", acceptBetaDisclaimer: true });
    const { res } = await register({ email: "admin@example.com", password: "supersecret", companyName: "Acme", acceptBetaDisclaimer: true });
    assert.equal(res.status, 400);
});

// ─── Runtime register (0.9: versions, duplicateRuntime) ─────────────────────

async function agentToken(companyId: string, agentId: string): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const { createHash, randomUUID } = await import("node:crypto");
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, agentId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: "rt", scope: "mcp_full",
    });
    return raw;
}

async function registerRuntime(rawToken: string, body: Record<string, unknown>) {
    const { POST } = await import("@/app/api/mcp/runtime/register/route");
    const res = await POST(makeRequest("http://localhost/api/mcp/runtime/register", {
        method: "POST",
        headers: { authorization: `Bearer ${rawToken}` },
        body,
    }));
    return { res, json: await res.json() };
}

/** Exactly what bridge 0.3.0 sends (`ensure_runtime`). */
const LEGACY_BODY = {
    runtimeId: "hermes-pi-qa",
    name: "Hermes on berry5",
    hostname: "berry5",
    gatewayVersion: "hermes-agent",
    capabilitiesJson: ["hermes-agent", "thread-reply", "emperor-tools", "rich-replies"],
    startedAt: "2026-10-22T10:00:00Z",
};

maybe("runtime register: a 0.3 bridge still registers and is reported as legacy", async () => {
    await resetDb();
    const { seedCompanyWithToken, seedAgent } = await import("./_helper");
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Courier" });
    const token = await agentToken(companyId, agent.id);

    const { res, json } = await registerRuntime(token, LEGACY_BODY);
    assert.equal(res.status, 200);
    assert.ok(json.serverCapabilities.includes("runs: 1"));
    assert.ok(json.serverCapabilities.includes("run-events: 1"));
    assert.ok(json.replyFormatGuide);
    assert.equal(json.runtimeNode.agentId, agent.id);
    assert.equal(json.runtimeNode.bridgeVersion, null);
    assert.deepEqual(json.bridge, { latest: "0.9.1", minimum: "0.9.0", hermes: "v0.22.4", deprecated: ["0.3"], updateState: "legacy" });
    assert.equal(json.duplicateRuntime, null);
    assert.equal(json.sharedHostOk, true);
});

maybe("runtime register: versions are stored and a second live runtime for the agent is a duplicate", async () => {
    await resetDb();
    const { seedCompanyWithToken, seedAgent } = await import("./_helper");
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "QA" });
    const token = await agentToken(companyId, agent.id);

    // The old 0.3 bridge is still alive...
    await registerRuntime(token, LEGACY_BODY);
    // ...when the 0.9 bridge for the same agent registers.
    const v09 = {
        runtimeId: "hermes-pc-qa", name: "Hermes on pc", hostname: "pc",
        bridgeVersion: "0.9.1", bridgeProtocol: 2, hermesVersion: "v0.22.4", hermesCodeSha: "4d04303818b6",
        transport: "gateway-ws", deployMode: "remote", maxParallelTurns: 3,
    };
    const { res, json } = await registerRuntime(token, v09);
    assert.equal(res.status, 200);
    assert.equal(json.runtimeNode.bridgeVersion, "0.9.1");
    assert.equal(json.runtimeNode.bridgeProtocol, 2);
    assert.equal(json.runtimeNode.hermesVersion, "v0.22.4");
    assert.equal(json.runtimeNode.transport, "gateway-ws");
    assert.equal(json.runtimeNode.deployMode, "remote");
    assert.equal(json.bridge.updateState, "current");
    assert.equal(json.duplicateRuntime?.runtimeId, "hermes-pi-qa");
    assert.equal(json.duplicateRuntime?.hostname, "berry5");

    // Once the other runtime is stale (> 120 s), there is no duplicate.
    const db = await getDb();
    const { runtimeNodes } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(runtimeNodes).set({ lastSeenAt: new Date(Date.now() - 5 * 60_000) }).where(eq(runtimeNodes.runtimeId, "hermes-pi-qa"));
    const again = await registerRuntime(token, v09);
    assert.equal(again.json.duplicateRuntime, null);

    // A recent run from the other runtime id counts as a sign of life too.
    const { agentRuns } = await getSchema();
    const { randomUUID } = await import("node:crypto");
    await db.insert(agentRuns).values({ id: randomUUID(), companyId, agentId: agent.id, runtimeId: "hermes-pi-qa", bridgeVersion: "0.3.0", startedAt: new Date() });
    const busy = await registerRuntime(token, v09);
    assert.equal(busy.json.duplicateRuntime?.runtimeId, "hermes-pi-qa");
    assert.equal(busy.json.duplicateRuntime?.bridgeVersion, "0.3.0");

    // Rolling back to 0.3 on the same runtime id clears the stored versions.
    const rolledBack = await registerRuntime(token, { ...LEGACY_BODY, runtimeId: "hermes-pc-qa" });
    assert.equal(rolledBack.json.runtimeNode.bridgeVersion, null);
    assert.equal(rolledBack.json.bridge.updateState, "legacy");
});

maybe("runtime profile-defaults serves key=value lines to a runtime token", async () => {
    await resetDb();
    const { seedCompanyWithToken, seedAgent } = await import("./_helper");
    const { companyId } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Builder" });
    const token = await agentToken(companyId, agent.id);
    const { GET } = await import("@/app/api/mcp/runtime/profile-defaults/route");

    const denied = await GET(makeRequest("http://localhost/api/mcp/runtime/profile-defaults"));
    assert.equal(denied.status, 401);

    const res = await GET(makeRequest("http://localhost/api/mcp/runtime/profile-defaults", { headers: { authorization: `Bearer ${token}` } }));
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    const lines = (await res.text()).trim().split("\n");
    assert.ok(lines.includes("compression.threshold_tokens=80000"));
    assert.ok(lines.every((line) => /^[^=\s]+=/.test(line)));
});

maybe("runtime register: sharedHostOk compares host fingerprints across companies, never hostnames", async () => {
    await resetDb();
    const { seedCompanyWithToken, seedAgent } = await import("./_helper");
    const a = await seedCompanyWithToken();
    const b = await seedCompanyWithToken();
    const tokenA1 = await agentToken(a.companyId, (await seedAgent(a.companyId, { name: "A1" })).id);
    const tokenA2 = await agentToken(a.companyId, (await seedAgent(a.companyId, { name: "A2" })).id);
    const tokenB = await agentToken(b.companyId, (await seedAgent(b.companyId, { name: "B1" })).id);
    const FP = "a".repeat(64);
    const shared = (runtimeId: string, extra: Record<string, unknown> = {}) => ({
        runtimeId, name: "Hermes on box", hostname: "box", bridgeVersion: "0.9.0", gatewayTopology: "shared", hostFingerprint: FP, ...extra,
    });

    const first = await registerRuntime(tokenA1, shared("box-a1"));
    assert.equal(first.json.sharedHostOk, true);
    assert.equal(first.json.runtimeNode.gatewayTopology, "shared");
    assert.equal(first.json.runtimeNode.hostFingerprint, FP);
    assert.equal((await registerRuntime(tokenA2, shared("box-a2"))).json.sharedHostOk, true, "same company is fine");

    // Same hostname, different fingerprint: a spoofed or colliding hostname never blocks.
    assert.equal((await registerRuntime(tokenB, shared("box-b0", { hostFingerprint: "b".repeat(64) }))).json.sharedHostOk, true);
    // No fingerprint: never blocked.
    assert.equal((await registerRuntime(tokenB, shared("box-b9", { hostFingerprint: undefined }))).json.sharedHostOk, true);
    // Same fingerprint but not shared topology: not this check's business.
    assert.equal((await registerRuntime(tokenB, shared("box-b8", { gatewayTopology: "standalone" }))).json.sharedHostOk, true);

    const foreign = await registerRuntime(tokenB, shared("box-b1"));
    assert.equal(foreign.json.sharedHostOk, false);
    assert.equal((await registerRuntime(tokenA1, shared("box-a1"))).json.sharedHostOk, false, "both sides see the conflict");

    // An unknown topology value is not stored; an oversize fingerprint is capped.
    const odd = await registerRuntime(tokenB, { ...shared("box-b2"), hostFingerprint: "c".repeat(300), gatewayTopology: "mesh" });
    assert.equal(odd.json.runtimeNode.gatewayTopology, null);
    assert.equal(odd.json.runtimeNode.hostFingerprint.length, 128);
});
