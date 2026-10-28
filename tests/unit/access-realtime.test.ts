import { test } from "node:test";
import assert from "node:assert/strict";
import { humanSocketReceives, parseRealtimeNotification, type HumanViewer } from "../../src/lib/realtime-delivery";

const company = "company-1";
const event = (subject: { projectIds?: string[]; customerIds?: string[]; agentIds?: string[]; directAgentIds?: string[] } | null, audience: { agentId: string | null; ownerUserId?: string | null } | null = null) => ({
    companyId: company, audience,
    subject: subject ? { projectIds: subject.projectIds ?? [], customerIds: subject.customerIds ?? [], agentIds: subject.agentIds ?? [], directAgentIds: subject.directAgentIds ?? [] } : null,
});

test("an agent limited to other people: its status and its DMs never reach the socket", () => {
    const viewer: HumanViewer = { companyId: company, userId: "u1", hiddenAgentIds: new Set(["secret"]) };
    assert.equal(humanSocketReceives(event({ agentIds: ["secret"] }), viewer), false, "status of the hidden agent");
    assert.equal(humanSocketReceives(event({ directAgentIds: ["secret"] }), viewer), false, "a message in its shared DM");
    assert.equal(humanSocketReceives(event({ directAgentIds: ["secret"] }, { agentId: "secret", ownerUserId: "u1" }), viewer), false, "even its private thread with them (access changed since)");
    assert.equal(humanSocketReceives(event({ agentIds: ["open"], directAgentIds: ["open"] }), viewer), true, "other agents pass");
    assert.equal(humanSocketReceives(event(null), viewer), true, "events about nothing pass");
});

test("audience events reach only their owner", () => {
    const viewer: HumanViewer = { companyId: company, userId: "u1", hiddenAgentIds: new Set() };
    assert.equal(humanSocketReceives(event({}, { agentId: "a1", ownerUserId: "u1" }), viewer), true);
    assert.equal(humanSocketReceives(event({}, { agentId: "a1", ownerUserId: "u2" }), viewer), false);
    assert.equal(humanSocketReceives(event({}, { agentId: "a1", ownerUserId: null }), viewer), false);
    assert.equal(humanSocketReceives({ ...event({}), companyId: "other" }, viewer), false, "never another company");
});

test("a project granted directly: its events pass with its own customer, mixed events do not", () => {
    // Granted P1 (customer C1) directly; C1 itself is not on the list; P9 is out of reach.
    const viewer: HumanViewer = {
        companyId: company, userId: "u1",
        allowedProjectIds: new Set(["p1"]), allowedCustomerIds: new Set(), allowedAgentIds: new Set(["a1"]),
        grantedProjectCustomerIds: new Set(["c1"]),
    };
    assert.equal(humanSocketReceives(event({ projectIds: ["p1"], customerIds: ["c1"] }), viewer), true, "the granted project and its customer");
    assert.equal(humanSocketReceives(event({ customerIds: ["c1"] }), viewer), false, "the customer alone stays out");
    assert.equal(humanSocketReceives(event({ projectIds: ["p1", "p9"], customerIds: ["c1"] }), viewer), false, "mixed projects: one out of reach");
    assert.equal(humanSocketReceives(event({ projectIds: ["p1"], customerIds: ["c2"] }), viewer), false, "another customer named alongside");
});

test("directAgentIds survive the NOTIFY round trip", () => {
    const parsed = parseRealtimeNotification(JSON.stringify({ companyId: company, audience: null, subject: { projectIds: [], customerIds: [], agentIds: [], directAgentIds: ["a1", 3] }, payload: { type: "thread_message" } }));
    assert.deepEqual(parsed?.subject?.directAgentIds, ["a1"]);
});
