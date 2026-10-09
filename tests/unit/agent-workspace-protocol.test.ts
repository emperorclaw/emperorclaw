import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_WORKSPACE_RULES, agentRoleTemplates, getAgentTemplate } from "../../src/lib/agent-templates";

test("every role receives one bounded workspace protocol through normal template lookup", () => {
    assert.ok(AGENT_WORKSPACE_RULES.length <= 1200, "detailed playbooks belong in on-demand KB, not each role prompt");
    for (const role of agentRoleTemplates) {
        const configured = getAgentTemplate(role.id)!;
        assert.equal(configured.agents.split(AGENT_WORKSPACE_RULES).length, 2);
    }
});

test("the leader can independently review explicitly reassigned work", () => {
    const lead = getAgentTemplate("boss")!;
    assert.ok(lead.agents.includes("independent reviewer"));
    assert.ok(!lead.agents.includes("Never close a task you did not do"));
});
