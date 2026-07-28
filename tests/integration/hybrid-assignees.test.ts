import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

const maybe = dbAvailable ? test : test.skip;

maybe("human and agent assignment coexist without cross-claiming or stale leases", async () => {
  await resetDb();
  const db = await getDb();
  const { companyMembers, projects } = await getSchema();
  const { companyId, userId } = await seedCompanyWithToken();

  const [member] = await db.insert(companyMembers).values({
    companyId,
    userId,
    role: "owner",
  }).returning();
  const [project] = await db.insert(projects).values({
    companyId,
    goal: "Hybrid workforce test",
    status: "active",
  }).returning();
  const agentA = await seedAgent(companyId, { name: "Agent A" });
  const agentB = await seedAgent(companyId, { name: "Agent B" });

  const {
    claimNextTaskForAgent,
    createTaskForProject,
    updateTaskForCompany,
  } = await import("@/lib/openclaw/tasks");

  const { task: humanTask } = await createTaskForProject({
    companyId,
    projectId: project.id,
    taskType: "manual_task",
    inputJson: { title: "Human-owned task" },
    assignee: { type: "human", id: userId },
  });
  assert.equal(humanTask.assignedMemberId, member.id);
  assert.equal(humanTask.assignedAgentId, null);

  const otherAgentClaim = await claimNextTaskForAgent({
    companyId,
    agentId: agentB.id,
  });
  assert.equal(otherAgentClaim.task, null, "an agent must not claim human-assigned work");

  await updateTaskForCompany({
    companyId,
    taskId: humanTask.id,
    state: "in_progress",
  });
  const handedToAgent = await updateTaskForCompany({
    companyId,
    taskId: humanTask.id,
    assignee: { type: "agent", id: agentA.id },
  });
  assert.equal("error" in handedToAgent, false);
  if ("error" in handedToAgent) return;
  assert.equal(handedToAgent.task.assignedAgentId, agentA.id);
  assert.equal(handedToAgent.task.assignedMemberId, null);
  assert.equal(handedToAgent.task.leaseUntil, null);

  const wrongAgentClaim = await claimNextTaskForAgent({
    companyId,
    agentId: agentB.id,
  });
  assert.equal(wrongAgentClaim.task, null, "another agent must not steal assigned work");

  const assignedAgentClaim = await claimNextTaskForAgent({
    companyId,
    agentId: agentA.id,
  });
  assert.equal(assignedAgentClaim.task?.id, humanTask.id);
  assert.ok(assignedAgentClaim.task?.lease_until || assignedAgentClaim.task?.leaseUntil);

  const handedBack = await updateTaskForCompany({
    companyId,
    taskId: humanTask.id,
    assignee: { type: "human", id: member.id },
  });
  assert.equal("error" in handedBack, false);
  if ("error" in handedBack) return;
  assert.equal(handedBack.task.assignedMemberId, member.id);
  assert.equal(handedBack.task.assignedAgentId, null);
  assert.equal(handedBack.task.leaseOwner, null);
  assert.equal(handedBack.task.leaseUntil, null);
});
