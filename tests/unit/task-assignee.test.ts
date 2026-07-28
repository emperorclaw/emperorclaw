import test from "node:test";
import assert from "node:assert/strict";
import { getTaskAssignee, serializeTaskWithAssignee } from "../../src/lib/task-assignee";

test("getTaskAssignee resolves one human, one agent, or nobody", () => {
  assert.deepEqual(getTaskAssignee({
    assignedAgentId: null,
    assignedMemberId: "member-1",
  }), { type: "human", id: "member-1" });

  assert.deepEqual(getTaskAssignee({
    assignedAgentId: "agent-1",
    assignedMemberId: null,
  }), { type: "agent", id: "agent-1" });

  assert.equal(getTaskAssignee({
    assignedAgentId: null,
    assignedMemberId: null,
  }), null);
});

test("serializeTaskWithAssignee is additive and preserves legacy fields", () => {
  const task = serializeTaskWithAssignee({
    id: "task-1",
    assignedAgentId: "agent-1",
    assignedMemberId: null,
  });

  assert.equal(task.assignedAgentId, "agent-1");
  assert.equal(task.assignedMemberId, null);
  assert.deepEqual(task.assignee, { type: "agent", id: "agent-1" });
});
