import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

maybe("worker pairing claims an agent exactly once and delivers the token exactly once", async () => {
    await resetDb();
    const savedKey = process.env.EMPEROR_CLAW_MASTER_KEY;
    const savedSecret = process.env.EMPEROR_WORKER_PAIRING_SECRET;
    process.env.EMPEROR_CLAW_MASTER_KEY = "test-master-key-for-pairing";

    try {
        const { companyId } = await seedCompanyWithToken();
        const agent = await seedAgent(companyId, { name: "Viktor", provider: "hermes", deploymentMode: "remote_paired" });

        const { assignAgentToIdleWorker, heartbeatWorker } = await import("@/lib/worker-pairing");

        // A worker registers (heartbeat) while unbound, then is claimed for the agent.
        const workerId = "test-worker-1";
        await heartbeatWorker(workerId);
        const claimed = await assignAgentToIdleWorker(companyId, agent);
        assert.equal(claimed, workerId, "the idle worker is assigned");

        process.env.EMPEROR_WORKER_PAIRING_SECRET = "pairing-secret";
        const { POST } = await import("@/app/api/runtime/pair/route");
        const call = (secret: string | undefined, body: unknown) => {
            const headers: Record<string, string> = {};
            if (secret !== undefined) headers["x-worker-pairing-secret"] = secret;
            return POST(makeRequest("http://localhost/api/runtime/pair", { method: "POST", headers, body }));
        };

        // Bad secret → 401.
        const bad = await call("wrong-secret", { workerId });
        assert.equal(bad.status, 401);

        // First delivery returns the minted token exactly once.
        const first = await call("pairing-secret", { workerId });
        assert.equal(first.status, 200);
        const firstBody = await first.json();
        assert.equal(firstBody.assigned, true);
        assert.equal(firstBody.agentId, agent.id);
        assert.equal(firstBody.agentName, "viktor");
        assert.equal(firstBody.displayName, "Viktor");
        assert.ok(firstBody.apiToken, "the agent-bound token is delivered once");

        // Restart re-delivery: same assignment, no new token.
        const second = await call("pairing-secret", { workerId });
        const secondBody = await second.json();
        assert.equal(secondBody.assigned, true);
        assert.equal(secondBody.agentId, agent.id);
        assert.equal(secondBody.apiToken, undefined, "no token is re-issued on restart");

        // Two workers can never hold the same agent: the unique index on
        // paired_workers.agent_id rejects the second bind, so the claim fails.
        await heartbeatWorker("test-worker-2");
        const doubleClaim = await assignAgentToIdleWorker(companyId, agent);
        assert.equal(doubleClaim, null, "a second worker cannot claim an already-assigned agent");

        // Disabled when the secret is unset.
        delete process.env.EMPEROR_WORKER_PAIRING_SECRET;
        const disabled = await call(undefined, { workerId });
        assert.equal(disabled.status, 404);
    } finally {
        if (savedKey === undefined) delete process.env.EMPEROR_CLAW_MASTER_KEY; else process.env.EMPEROR_CLAW_MASTER_KEY = savedKey;
        if (savedSecret === undefined) delete process.env.EMPEROR_WORKER_PAIRING_SECRET; else process.env.EMPEROR_WORKER_PAIRING_SECRET = savedSecret;
    }
});
