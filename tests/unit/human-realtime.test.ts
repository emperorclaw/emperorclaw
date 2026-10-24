import test from "node:test";
import assert from "node:assert/strict";
import { humanSocketReceives, originMatchesHost, socketsOverCap, type HumanViewer } from "../../src/lib/realtime-delivery";
import { eventTopicsFor } from "../../src/lib/realtime-topics";

const company = "c1";

function viewer(overrides: Partial<HumanViewer> = {}): HumanViewer {
    return {
        companyId: company,
        userId: "u1",
        role: "member",
        allowedAgentIds: null,
        allowedCustomerIds: null,
        allowedProjectIds: null,
        ...overrides,
    };
}

const restricted: HumanViewer = {
    companyId: company,
    userId: "u1",
    role: "member",
    allowedAgentIds: new Set(["a1", "a2"]),
    allowedCustomerIds: new Set(["cust1"]),
    allowedProjectIds: new Set(["proj1"]),
};

const companyWide = { companyId: company, audience: null, subject: null };

test("humanSocketReceives: only the same company", () => {
    assert.equal(humanSocketReceives(companyWide, viewer({ companyId: "other" })), false);
    assert.equal(humanSocketReceives(companyWide, viewer({ companyId: company })), true);
});

test("humanSocketReceives: company-wide events reach every role when unrestricted", () => {
    for (const role of ["owner", "admin", "member", "viewer"]) {
        assert.equal(humanSocketReceives(companyWide, viewer({ role })), true, `${role} should get company-wide events`);
    }
});

test("humanSocketReceives: a private thread reaches only its owner", () => {
    const privateEvent = { companyId: company, audience: { agentId: "ax", ownerUserId: "u1" }, subject: null };
    assert.equal(humanSocketReceives(privateEvent, viewer({ userId: "u1" })), true, "the owner sees it");
    assert.equal(humanSocketReceives(privateEvent, viewer({ userId: "u2" })), false, "another user never sees it");
    assert.equal(humanSocketReceives(privateEvent, viewer({ userId: "u1", role: "admin" })), true, "the owner sees it regardless of role");
});

test("humanSocketReceives: an orphaned or mixed private thread reaches nobody", () => {
    assert.equal(humanSocketReceives({ companyId: company, audience: { agentId: "ax", ownerUserId: null }, subject: null }, viewer({ userId: "u1" })), false);
    assert.equal(humanSocketReceives({ companyId: company, audience: { agentId: null, ownerUserId: null }, subject: null }, viewer({ userId: "u1" })), false);
});

test("humanSocketReceives: restricted member is filtered by project and customer", () => {
    const inScope = { companyId: company, audience: null, subject: { projectIds: ["proj1"], customerIds: ["cust1"], agentIds: [] } };
    const outOfScopeProject = { companyId: company, audience: null, subject: { projectIds: ["proj2"], customerIds: ["cust2"], agentIds: [] } };
    const outOfScopeCustomer = { companyId: company, audience: null, subject: { projectIds: ["proj1"], customerIds: ["cust2"], agentIds: [] } };
    assert.equal(humanSocketReceives(inScope, restricted), true);
    assert.equal(humanSocketReceives(outOfScopeProject, restricted), false);
    assert.equal(humanSocketReceives(outOfScopeCustomer, restricted), false);
});

test("humanSocketReceives: restricted member is filtered by agent (one-way presence)", () => {
    const statusIn = { companyId: company, audience: null, subject: { projectIds: [], customerIds: [], agentIds: ["a1"] } };
    const statusOut = { companyId: company, audience: null, subject: { projectIds: [], customerIds: [], agentIds: ["a3"] } };
    assert.equal(humanSocketReceives(statusIn, restricted), true);
    assert.equal(humanSocketReceives(statusOut, restricted), false);
});

test("humanSocketReceives: team chat (no subject ids) still reaches a restricted member", () => {
    assert.equal(humanSocketReceives({ companyId: company, audience: null, subject: { projectIds: [], customerIds: [], agentIds: [] } }, restricted), true);
    assert.equal(humanSocketReceives(companyWide, restricted), true);
});

test("humanSocketReceives: an empty restricted allow-list fails closed", () => {
    const none: HumanViewer = { companyId: company, userId: "u1", role: "member", allowedAgentIds: new Set(), allowedCustomerIds: new Set(), allowedProjectIds: new Set() };
    assert.equal(humanSocketReceives({ companyId: company, audience: null, subject: { projectIds: ["proj1"], customerIds: [], agentIds: [] } }, none), false);
});

// ── Topic mapping ────────────────────────────────────────────────────────────

test("eventTopicsFor: thread messages and presence map to thread + dashboard + inbox", () => {
    const t1 = "11111111-1111-4111-8111-111111111111";
    const topics = eventTopicsFor({ type: "thread_message", threadId: t1 }, null);
    assert.deepEqual(new Set(topics), new Set([`thread:${t1}`, "dashboard", "inbox"]));
    const typing = eventTopicsFor({ type: "participant_status", threadId: t1 }, null);
    assert.ok(typing.includes(`thread:${t1}`) && typing.includes("dashboard") && typing.includes("inbox"));
});

test("eventTopicsFor: agent events map to agents + dashboard", () => {
    const topics = eventTopicsFor({ type: "agent_status", agentId: "a1", status: "offline" }, null);
    assert.deepEqual(new Set(topics), new Set(["agents", "dashboard"]));
});

test("eventTopicsFor: task events map to task id + dashboard + projects + inbox", () => {
    const taskId = "22222222-2222-4222-8222-222222222222";
    const topics = eventTopicsFor({ type: "task_updated", task: { id: taskId } }, null);
    assert.ok(topics.includes(`task:${taskId}`));
    assert.ok(topics.includes("dashboard") && topics.includes("projects") && topics.includes("inbox"));
});

test("eventTopicsFor: project events map to project id + projects", () => {
    const projectId = "33333333-3333-4333-8333-333333333333";
    const topics = eventTopicsFor({ type: "project_created", project: { id: projectId } }, { projectIds: [projectId], customerIds: [], agentIds: [] });
    assert.ok(topics.includes(`project:${projectId}`) && topics.includes("projects"));
});

test("eventTopicsFor: run updates map to run + thread + task + dashboard", () => {
    const runId = "44444444-4444-4444-8444-444444444444";
    const threadId = "55555555-5555-4555-8555-555555555555";
    const taskId = "66666666-6666-4666-8666-666666666666";
    const topics = eventTopicsFor({ type: "run_updated", runId, threadId, taskId, agentId: "a1" }, null);
    assert.deepEqual(new Set(topics), new Set([`run:${runId}`, `thread:${threadId}`, `task:${taskId}`, "dashboard"]));
});

test("eventTopicsFor: approval and incident events map to inbox + dashboard", () => {
    const approval = eventTopicsFor({ type: "approval_created", approval: { id: "a" } }, null);
    assert.ok(approval.includes("inbox") && approval.includes("dashboard"));
    const incident = eventTopicsFor({ type: "incident_updated", incident: { id: "i" } }, null);
    assert.ok(incident.includes("inbox") && incident.includes("dashboard"));
});

// ── Upgrade guards ───────────────────────────────────────────────────────────

test("originMatchesHost: same host (with port) is accepted", () => {
    assert.equal(originMatchesHost("https://brain.example.com", ["brain.example.com"]), true);
    assert.equal(originMatchesHost("http://localhost:3002", ["localhost:3002"]), true);
    assert.equal(originMatchesHost("https://Brain.Example.com", ["brain.example.com"]), true);
    assert.equal(originMatchesHost(["https://a.example.com"], ["x.example.com", "a.example.com"]), true, "any allowed host (forwarded host behind a trusted proxy)");
});

test("originMatchesHost: foreign, missing or odd origins are rejected", () => {
    assert.equal(originMatchesHost("https://evil.example.net", ["brain.example.com"]), false);
    assert.equal(originMatchesHost("https://brain.example.com.evil.net", ["brain.example.com"]), false);
    assert.equal(originMatchesHost("http://localhost:3000", ["localhost:3002"]), false, "the port is part of the host");
    assert.equal(originMatchesHost(undefined, ["brain.example.com"]), false);
    assert.equal(originMatchesHost("", ["brain.example.com"]), false);
    assert.equal(originMatchesHost("null", ["brain.example.com"]), false);
    assert.equal(originMatchesHost("not a url", ["brain.example.com"]), false);
    assert.equal(originMatchesHost("file://brain.example.com", ["brain.example.com"]), false);
    assert.equal(originMatchesHost("https://brain.example.com", []), false);
    assert.equal(originMatchesHost("https://brain.example.com", [undefined, null]), false);
});

test("socketsOverCap: closes the oldest beyond the cap", () => {
    assert.deepEqual(socketsOverCap(["a", "b", "c"], 10), []);
    assert.deepEqual(socketsOverCap(["a", "b", "c"], 3), []);
    assert.deepEqual(socketsOverCap(["a", "b", "c", "d"], 3), ["a"]);
    assert.deepEqual(socketsOverCap(["a", "b", "c", "d", "e"], 3), ["a", "b"]);
    assert.deepEqual(socketsOverCap(["a"], 0), ["a"]);
});
