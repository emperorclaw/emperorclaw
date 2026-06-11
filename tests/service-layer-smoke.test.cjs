/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function hasExport(source, name) {
  const pattern = new RegExp(String.raw`export\s+(?:async\s+)?function\s+${name}\b`);
  return pattern.test(source);
}

test("control-plane service exposes the runtime helper surface", () => {
  const source = read("src/lib/control-plane.ts");
  [
    "ensureTeamThread",
    "ensureDirectThread",
    "appendThreadMessage",
    "updateThreadExecutionState",
    "startAgentSession",
    "checkpointAgentSession",
    "endAgentSession",
    "registerRuntimeNode",
  ].forEach((name) => {
    assert.ok(hasExport(source, name), `control-plane.ts should export ${name}`);
  });
});

test("workflow, approval, and lifecycle services expose the expected API shape", () => {
  const workflow = read("src/lib/project-workflow.ts");
  const approvals = read("src/lib/approvals.ts");
  const lifecycle = read("src/lib/lifecycle.ts");
  const openclawTasks = read("src/lib/openclaw/tasks.ts");
  const openclawRuntime = read("src/lib/openclaw/runtime.ts");
  const openclawMessaging = read("src/lib/openclaw/messaging.ts");
  const resources = read("src/lib/resources.ts");
  const artifacts = read("src/lib/artifacts.ts");
  const projectAgentProfiles = read("src/lib/project-agent-profiles.ts");
  const agentDeletion = read("src/lib/agent-deletion.ts");

  [
    "validateTaskStateTransition",
    "resolveReviewBucket",
    "normalizeExecutionState",
    "canWorkerCompleteDirectly",
    "getPendingApprovalSummaryForTaskIds",
    "getPendingApprovalForTask",
    "isRecurringTask",
    "normalizeRequestedTaskState",
  ].forEach((name) => {
    assert.ok(hasExport(workflow, name), `project-workflow.ts should export ${name}`);
  });

  [
    "createApprovalRequest",
    "resolveApproval",
    "listApprovalsForCompany",
    "getApprovalDetail",
    "taskHasPendingApproval",
    "getLatestPendingApproval",
  ].forEach((name) => {
    assert.ok(hasExport(approvals, name), `approvals.ts should export ${name}`);
  });

  [
    "nextCheckinDeadline",
    "startLifecycleMonitor",
  ].forEach((name) => {
    assert.ok(hasExport(lifecycle, name), `lifecycle.ts should export ${name}`);
  });

  [
    "claimNextTaskForAgent",
    "createTaskForProject",
    "finalizeTaskForAgent",
    "listRecurringTaskDefinitionsForProject",
    "createRecurringTaskDefinition",
    "spawnRecurringTaskInstance",
  ].forEach((name) => {
    assert.ok(hasExport(openclawTasks, name), `openclaw/tasks.ts should export ${name}`);
  });

  ["acknowledgeAgentHeartbeat"].forEach((name) => {
    assert.ok(hasExport(openclawRuntime, name), `openclaw/runtime.ts should export ${name}`);
  });

  ["sendThreadMessageFromMcp"].forEach((name) => {
    assert.ok(hasExport(openclawMessaging, name), `openclaw/messaging.ts should export ${name}`);
  });

  [
    "listScopedResources",
    "getScopedResource",
    "createScopedResource",
    "updateScopedResource",
    "archiveScopedResource",
    "leaseScopedResource",
  ].forEach((name) => {
    assert.ok(hasExport(resources, name), `resources.ts should export ${name}`);
  });

  [
    "normalizeArtifactClass",
    "normalizeArtifactImportance",
    "prepareArtifactRecord",
  ].forEach((name) => {
    assert.ok(hasExport(artifacts, name), `artifacts.ts should export ${name}`);
  });

  [
    "listProjectAgentProfiles",
    "getProjectAgentProfile",
    "createProjectAgentProfile",
    "updateProjectAgentProfile",
    "archiveProjectAgentProfile",
  ].forEach((name) => {
    assert.ok(hasExport(projectAgentProfiles, name), `project-agent-profiles.ts should export ${name}`);
  });

  ["deleteAgentAndData"].forEach((name) => {
    assert.ok(hasExport(agentDeletion, name), `agent-deletion.ts should export ${name}`);
  });
});
