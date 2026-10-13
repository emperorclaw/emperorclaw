import { test } from "node:test";
import assert from "node:assert/strict";
import { canAgentReadResource, toPublicResource, type AgentResourceAccess } from "../../src/lib/resources";

const access = (overrides: Partial<AgentResourceAccess> = {}): AgentResourceAccess => ({
    callerAgentId: "agent-a",
    allowedProjectIds: null,
    allowedCustomerIds: null,
    ...overrides,
});

test("toPublicResource strips the secret column and keeps the rest", () => {
    const row = { id: "r1", name: "Note", scopeType: "company", scopeId: null, configText: "body", secretText: "sk-live-123" };
    const safe = toPublicResource(row);
    assert.equal("secretText" in safe, false);
    assert.equal(safe.configText, "body");
    assert.equal(safe.name, "Note");
});

test("company notes are readable by any agent", () => {
    assert.equal(canAgentReadResource({ scopeType: "company", scopeId: null }, access()), true);
});

test("an agent cannot read another agent's note", () => {
    assert.equal(canAgentReadResource({ scopeType: "agent", scopeId: "agent-a" }, access()), true);
    assert.equal(canAgentReadResource({ scopeType: "agent", scopeId: "agent-b" }, access()), false);
});

test("project/customer notes follow the agent's scope grants", () => {
    const restricted = access({ allowedProjectIds: new Set(["p1"]), allowedCustomerIds: new Set(["c1"]) });
    assert.equal(canAgentReadResource({ scopeType: "project", scopeId: "p1" }, restricted), true);
    assert.equal(canAgentReadResource({ scopeType: "project", scopeId: "p2" }, restricted), false);
    assert.equal(canAgentReadResource({ scopeType: "customer", scopeId: "c1" }, restricted), true);
    assert.equal(canAgentReadResource({ scopeType: "customer", scopeId: "c2" }, restricted), false);
});

test("a human/operator session (null access) keeps full access", () => {
    for (const scopeType of ["company", "project", "customer", "agent"]) {
        assert.equal(canAgentReadResource({ scopeType, scopeId: "anything" }, null), true);
    }
});
