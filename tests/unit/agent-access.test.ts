import { test } from "node:test";
import assert from "node:assert/strict";
import {
    agentAccessChangeAllowed, agentAccessSummary, agentIsLimited, agentUse, normalizeAgentAccess,
    type AgentAccessFacts, type AgentAccessSubject,
} from "../../src/lib/agent-access";

const OWNER = "owner-user";
const LISTED = "listed-user";
const OTHER = "other-user";
const ADMIN = "admin-user";

const agent = (access: string, extra: Partial<AgentAccessFacts> = {}): AgentAccessFacts => ({ access, ownerUserId: OWNER, people: [LISTED], ...extra });
const person = (userId: string, isAdmin = false): AgentAccessSubject => ({ userId, isAdmin });

test("agentUse: the truth table for everyone, people and owner agents", () => {
    const callers: [string, AgentAccessSubject][] = [
        ["owner", person(OWNER)],
        ["listed person", person(LISTED)],
        ["other member", person(OTHER)],
        ["admin", person(ADMIN, true)],
        ["admin who owns it", person(OWNER, true)],
    ];
    const expected: Record<string, Record<string, string>> = {
        everyone: { owner: "full", "listed person": "full", "other member": "full", admin: "full", "admin who owns it": "full" },
        people: { owner: "full", "listed person": "full", "other member": "none", admin: "metadata", "admin who owns it": "full" },
        owner: { owner: "full", "listed person": "none", "other member": "none", admin: "metadata", "admin who owns it": "full" },
    };
    for (const access of ["everyone", "people", "owner"]) {
        for (const [name, subject] of callers) {
            assert.equal(agentUse(subject, agent(access), true), expected[access][name], `${access} agent, ${name}`);
        }
    }
});

test("agentUse: member scope is the ceiling, whatever the access", () => {
    for (const access of ["everyone", "people", "owner"]) {
        assert.equal(agentUse(person(OWNER), agent(access), false), "none", `${access}: owner out of scope`);
        assert.equal(agentUse(person(ADMIN, true), agent(access), false), "none", `${access}: admin out of scope`);
    }
});

test("an unknown stored access fails closed to 'owner'", () => {
    assert.equal(normalizeAgentAccess("everybody"), "owner");
    assert.equal(agentUse(person(OTHER), agent("everybody"), true), "none");
    assert.equal(agentUse(person(OWNER), agent("everybody"), true), "full");
    assert.equal(agentIsLimited({ access: "everyone" }), false);
    assert.equal(agentIsLimited({ access: "people" }), true);
});

test("who may change who can use an agent", () => {
    const before = agent("owner");
    // The owner may do anything, including opening it up.
    assert.deepEqual(agentAccessChangeAllowed(person(OWNER), before, agent("everyone")), { ok: true });
    // An admin may limit or hand over, but never let themselves in.
    assert.deepEqual(agentAccessChangeAllowed(person(ADMIN, true), before, agent("people", { people: [OTHER] })), { ok: true });
    assert.deepEqual(agentAccessChangeAllowed(person(ADMIN, true), before, agent("owner", { ownerUserId: OTHER })), { ok: true }, "transfer to someone else");
    assert.equal(agentAccessChangeAllowed(person(ADMIN, true), before, agent("people", { people: [ADMIN] })).ok, false, "add self to the list");
    assert.equal(agentAccessChangeAllowed(person(ADMIN, true), before, agent("owner", { ownerUserId: ADMIN })).ok, false, "make self the owner");
    assert.equal(agentAccessChangeAllowed(person(ADMIN, true), before, agent("everyone")).ok, false, "open it to everyone (self included)");
    // An admin who can already use it may.
    assert.equal(agentAccessChangeAllowed(person(ADMIN, true), agent("people", { people: [ADMIN] }), agent("everyone")).ok, true);
    // Nobody else, not even people on the list.
    assert.equal(agentAccessChangeAllowed(person(LISTED), agent("people"), agent("everyone")).ok, false);
    assert.equal(agentAccessChangeAllowed(person(OTHER), agent("everyone"), agent("owner", { ownerUserId: OTHER })).ok, false);
    // A limited agent needs an owner; the mode must be known.
    const noOwner = agentAccessChangeAllowed(person(OWNER), before, agent("owner", { ownerUserId: null }));
    assert.equal(noOwner.ok, false);
    assert.equal(agentAccessChangeAllowed(person(OWNER), before, agent("secret")).ok, false);
});

test("agent list summary", () => {
    assert.equal(agentAccessSummary({ access: "everyone", ownerName: "Ana", peopleCount: 0 }), "Everyone");
    assert.equal(agentAccessSummary({ access: "owner", ownerName: "Ana", peopleCount: 3 }), "Only Ana");
    assert.equal(agentAccessSummary({ access: "people", ownerName: "Ana", peopleCount: 1 }), "Ana + 1 person");
    assert.equal(agentAccessSummary({ access: "people", ownerName: null, peopleCount: 2 }), "its owner + 2 people");
});
