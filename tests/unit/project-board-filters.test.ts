import assert from "node:assert/strict";
import test from "node:test";
import {
  migrateLegacyAgentFilter,
  normalizeAssigneeFilter,
} from "../../src/lib/project-board-filters";

const validAssignees = {
  agentIds: ["agent-1"],
  memberIds: ["member-1"],
};

test("legacy All Agents migrates to the unfiltered board", () => {
  assert.equal(migrateLegacyAgentFilter("All Agents", validAssignees.agentIds), "all");
});

test("legacy agent IDs migrate to the unified agent filter", () => {
  assert.equal(migrateLegacyAgentFilter("agent-1", validAssignees.agentIds), "agent:agent-1");
});

test("stale legacy agent IDs do not hide every task", () => {
  assert.equal(migrateLegacyAgentFilter("deleted-agent", validAssignees.agentIds), "all");
});

test("current assignee filters accept known people, agents, and groups", () => {
  assert.equal(normalizeAssigneeFilter("human:member-1", validAssignees), "human:member-1");
  assert.equal(normalizeAssigneeFilter("agent:agent-1", validAssignees), "agent:agent-1");
  assert.equal(normalizeAssigneeFilter("unassigned", validAssignees), "unassigned");
});

test("invalid saved or URL filters fall back to all assignees", () => {
  assert.equal(normalizeAssigneeFilter("agent:deleted-agent", validAssignees), "all");
  assert.equal(normalizeAssigneeFilter("agent:All Agents", validAssignees), "all");
  assert.equal(normalizeAssigneeFilter("unexpected", validAssignees), "all");
});
