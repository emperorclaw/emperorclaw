/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");

function read(relativePath) {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function contains(source, needle) {
  return source.includes(needle);
}

function collectRouteViolations(relativePath, required, forbidden) {
  const source = read(relativePath);
  const violations = [];
  for (const needle of required) {
    if (!contains(source, needle)) {
      violations.push(`${relativePath} should reference ${needle}`);
    }
  }

  for (const needle of forbidden) {
    if (contains(source, needle)) {
      violations.push(`${relativePath} still owns runtime behavior via ${needle}`);
    }
  }
  return violations;
}

test("MCP message routes delegate to the control-plane service layer", () => {
  const violations = [
    ...collectRouteViolations(
      "src/app/api/mcp/messages/send/route.ts",
      [
        'from "@/lib/openclaw/messaging"',
        "sendThreadMessageFromMcp",
      ],
      [
        "leaseUntil",
        "checkinDeadlineAt",
        "wakeAttempts",
        "lastProvisionError",
        "validateTaskStateTransition",
      ],
    ),
    ...collectRouteViolations(
      "src/app/api/mcp/threads/[id]/messages/route.ts",
      [
        'from "@/lib/control-plane"',
        "appendThreadMessage",
        "getThreadMessages",
      ],
      [
        "leaseUntil",
        "checkinDeadlineAt",
        "wakeAttempts",
        "lastProvisionError",
        "validateTaskStateTransition",
      ],
    ),
  ];

  assert.equal(violations.length, 0, violations.join("\n"));
});

test("runtime-sensitive MCP routes do not own lifecycle or workflow policy inline", () => {
  const violations = [
    ...collectRouteViolations(
      "src/app/api/mcp/agents/heartbeat/route.ts",
      ['from "@/lib/lifecycle"', 'from "@/lib/openclaw/runtime"', "acknowledgeAgentHeartbeat"],
      [
        "db.update(tasks)",
        "db.update(agentSessions)",
        "leaseUntil",
        "checkinDeadlineAt",
        "wakeAttempts",
        "lastProvisionError",
      ],
    ),
    ...collectRouteViolations(
      "src/app/api/mcp/tasks/claim/route.ts",
      ['from "@/lib/openclaw/tasks"', "claimNextTaskForAgent"],
      [
        "FOR UPDATE SKIP LOCKED",
        "lease_until",
        "max_active_agents",
        "processing_started_at",
        "task_claimed",
      ],
    ),
    ...collectRouteViolations(
      "src/app/api/mcp/tasks/[id]/result/route.ts",
      [
        'from "@/lib/openclaw/tasks"',
        "finalizeTaskForAgent",
      ],
      [
        "createApprovalRequest",
        "validateTaskStateTransition",
        "taskEvents",
        "task_requires_approval",
        "leaseOwner: null",
      ],
    ),
  ];

  assert.equal(violations.length, 0, violations.join("\n"));
});
