import test from "node:test";
import assert from "node:assert/strict";
import { coordinationRole, teamCoordinator } from "../../src/lib/team-coordination";

test("coordination is optional and never inferred from ownership or a global job title", () => {
    assert.equal(teamCoordinator([{ kind: "agent", id: "boss", role: "owner" }]), null);
    assert.equal(teamCoordinator([]), null);
});
test("one shared agent can coordinate one team and participate in another", () => {
    const agent = { kind: "agent" as const, id: "shared" };
    assert.equal(teamCoordinator([{ ...agent, role: "coordinator" }])?.id, "shared");
    assert.equal(teamCoordinator([{ ...agent, role: "member" }]), null);
});
test("changing coordination preserves the creator's ownership and accepts a human", () => {
    assert.equal(coordinationRole("owner", true), "owner_coordinator");
    assert.equal(coordinationRole("owner_coordinator", false), "owner");
    assert.equal(coordinationRole("member", true), "coordinator");
    assert.equal(coordinationRole("coordinator", false), "member");
    assert.equal(teamCoordinator([{ kind: "human", id: "human", role: "owner_coordinator" }])?.kind, "human");
});
