import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
    buildPairResponse,
    constantTimeEqual,
    pairingEnabled,
    selectIdleWorker,
    type IdleWorker,
} from "../../src/lib/worker-pairing";

test("pairingEnabled is on only when the secret is set", () => {
    assert.equal(pairingEnabled({}), false);
    assert.equal(pairingEnabled({ EMPEROR_WORKER_PAIRING_SECRET: "" }), false);
    assert.equal(pairingEnabled({ EMPEROR_WORKER_PAIRING_SECRET: "   " }), false);
    assert.equal(pairingEnabled({ EMPEROR_WORKER_PAIRING_SECRET: "secret" }), true);
});

test("constantTimeEqual matches and rejects without length leaks", () => {
    assert.equal(constantTimeEqual("secret", "secret"), true);
    assert.equal(constantTimeEqual("secret", "other"), false);
    assert.equal(constantTimeEqual("a", "a much longer secret value"), false);
    assert.equal(constantTimeEqual("", ""), true);
});

test("selectIdleWorker prefers the most recently seen idle worker", () => {
    const workers: IdleWorker[] = [
        { id: "w1", workerId: "a", companyId: null, agentId: null, lastSeenAt: new Date("2026-10-07T10:00:00Z") },
        { id: "w2", workerId: "b", companyId: null, agentId: null, lastSeenAt: new Date("2026-10-07T11:00:00Z") },
    ];
    assert.equal(selectIdleWorker(workers, "company-1")?.id, "w2");
});

test("selectIdleWorker skips assigned workers and other-company workers", () => {
    const workers: IdleWorker[] = [
        { id: "w1", workerId: "a", companyId: null, agentId: "agent-1", lastSeenAt: new Date("2026-10-07T12:00:00Z") },
        { id: "w2", workerId: "b", companyId: "other-company", agentId: null, lastSeenAt: new Date("2026-10-07T12:00:00Z") },
        { id: "w3", workerId: "c", companyId: "company-1", agentId: null, lastSeenAt: new Date("2026-10-07T09:00:00Z") },
    ];
    assert.equal(selectIdleWorker(workers, "company-1")?.id, "w3", "an assigned worker and a foreign-company worker are never idle");
});

test("selectIdleWorker returns null when nothing is idle", () => {
    const workers: IdleWorker[] = [
        { id: "w1", workerId: "a", companyId: "company-1", agentId: "agent-1", lastSeenAt: new Date() },
    ];
    assert.equal(selectIdleWorker(workers, "company-1"), null);
});

const agent = { id: "a1", name: "Viktor", role: "Operator", llmProvider: "openai", llmModel: "gpt-4o-mini" };

test("buildPairResponse delivers secrets only on first delivery", () => {
    const first = buildPairResponse({ assigned: true, agent, apiToken: "ec_token", llmApiKey: "sk-key" });
    assert.equal(first.assigned, true);
    assert.equal(first.apiToken, "ec_token");
    assert.equal(first.llmApiKey, "sk-key");
    assert.equal(first.agentName, "Viktor");

    // Restart re-delivery: no secrets, same assignment.
    const restart = buildPairResponse({ assigned: true, agent, apiToken: null, llmApiKey: null });
    assert.equal(restart.assigned, true);
    assert.equal(restart.apiToken, undefined);
    assert.equal(restart.llmApiKey, undefined);
    assert.equal(restart.agentId, "a1");
});

test("buildPairResponse is unassigned without an agent", () => {
    assert.deepEqual(buildPairResponse({ assigned: false, agent: null }), { assigned: false });
    assert.deepEqual(buildPairResponse({ assigned: true, agent: null }), { assigned: false });
});

// The pairing endpoint must gate on the secret before touching the database,
// and be disabled entirely when the secret is unset.
test("POST /api/runtime/pair checks pairingEnabled before any DB access", () => {
    const source = readFileSync(resolve(__dirname, "../..", "src/app/api/runtime/pair/route.ts"), "utf8");
    const handler = source.slice(source.indexOf("export async function POST"));
    assert.ok(handler.length > 0, "POST handler exists");
    const disabled = handler.indexOf("pairingEnabled()");
    assert.ok(disabled > 0, "disabled when the secret is unset");
    const compare = handler.indexOf("constantTimeEqual(provided, expected)");
    assert.ok(compare > 0, "authenticated by constant-time comparison");
    const firstDbUse = handler.search(/\b(heartbeatWorker|deliverWorkerAssignment)\(/);
    assert.ok(disabled < compare && compare < firstDbUse, "disabled check → secret check → DB use");
});
