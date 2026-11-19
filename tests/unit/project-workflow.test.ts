import { test } from "node:test";
import assert from "node:assert/strict";
import { taskAssignmentDenial, taskStateChangeDenial, validateTaskStateTransition } from "../../src/lib/project-workflow";
import { TASK_STATES } from "../../src/lib/task-state";

function project(overrides: Partial<Parameters<typeof validateTaskStateTransition>[0]["project"]> = {}) {
    return {
        leadAgentId: "lead",
        requireApprovalForDone: false,
        requireReviewBeforeDone: false,
        commentRequiredForReview: false,
        blockStatusChangesWithPendingApproval: false,
        onlyLeadCanChangeStatus: false,
        ...overrides,
    };
}

function task(overrides: Partial<Parameters<typeof validateTaskStateTransition>[0]["task"]> = {}) {
    return { state: TASK_STATES.inbox, assignedAgentId: "worker", ...overrides };
}

test("onlyLeadCanChangeStatus: the assignee may self-start into in_progress", () => {
    const error = validateTaskStateTransition({
        project: project({ onlyLeadCanChangeStatus: true }),
        task: task({ assignedAgentId: "worker" }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "worker",
    });
    assert.equal(error, null);
});

test("onlyLeadCanChangeStatus: the assignee may move its own task to review", () => {
    const error = validateTaskStateTransition({
        project: project({ onlyLeadCanChangeStatus: true }),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inProgress }),
        requestedState: TASK_STATES.review,
        actorAgentId: "worker",
    });
    assert.equal(error, null);
});

test("onlyLeadCanChangeStatus: a non-assignee non-lead cannot move someone else's task to in_progress", () => {
    const error = validateTaskStateTransition({
        project: project({ onlyLeadCanChangeStatus: true }),
        task: task({ assignedAgentId: "worker" }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "bystander",
    });
    assert.ok(error);
});

test("onlyLeadCanChangeStatus: the assignee still cannot move to done", () => {
    const error = validateTaskStateTransition({
        project: project({ onlyLeadCanChangeStatus: true }),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inProgress }),
        requestedState: TASK_STATES.done,
        actorAgentId: "worker",
    });
    assert.ok(error);
});

test("onlyLeadCanChangeStatus: the lead can move to done", () => {
    const error = validateTaskStateTransition({
        project: project({ onlyLeadCanChangeStatus: true }),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.review }),
        requestedState: TASK_STATES.done,
        actorAgentId: "lead",
    });
    assert.equal(error, null);
});

test("W8: a done or failed task is never reopened", () => {
    const error = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.done }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "worker",
    });
    assert.ok(error);
    const failed = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.failed }),
        requestedState: TASK_STATES.review,
        actorAgentId: "lead",
    });
    assert.ok(failed);
});

test("W8: the assignee may start only from a queued/assigned state", () => {
    const fromInbox = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inbox }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "worker",
    });
    assert.equal(fromInbox, null);
    const fromReview = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.review }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "worker",
    });
    assert.ok(fromReview);
});

test("W8: the assignee may move to review only from in_progress", () => {
    const fromInProgress = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inProgress }),
        requestedState: TASK_STATES.review,
        actorAgentId: "worker",
    });
    assert.equal(fromInProgress, null);
    const fromInbox = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inbox }),
        requestedState: TASK_STATES.review,
        actorAgentId: "worker",
    });
    assert.ok(fromInbox);
});

test("W8: the lead is exempt from the self-start source-state rules", () => {
    const error = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.review }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "lead",
    });
    assert.equal(error, null);
});

test("blocked: a blocker reason is required to hold a task", () => {
    const missing = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inProgress }),
        requestedState: TASK_STATES.blocked,
        actorAgentId: "worker",
    });
    assert.ok(missing);
    const provided = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inProgress }),
        requestedState: TASK_STATES.blocked,
        actorAgentId: "worker",
        blockedReason: "Waiting on legal sign-off",
    });
    assert.equal(provided, null);
});

test("blocked: a blocked task may restart into in_progress", () => {
    const error = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.blocked }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "worker",
    });
    assert.equal(error, null);
});

test("requesting the state the task is already in is a no-op success", () => {
    // An assignee re-saving in_progress must not trip the source-state rules.
    const sameInProgress = validateTaskStateTransition({
        project: project({ onlyLeadCanChangeStatus: true }),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.inProgress }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "worker",
    });
    assert.equal(sameInProgress, null);

    // Re-requesting done on a done task is also a no-op, not a reopen error.
    const sameDone = validateTaskStateTransition({
        project: project(),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.done }),
        requestedState: TASK_STATES.done,
        actorAgentId: "worker",
    });
    assert.equal(sameDone, null);
});

// Regression: task c87002d6 (Stayolo collection page). At 15:47:06Z a session of
// the implementing agent PATCHed {"state":"done"} onto a task sitting in review
// whose assignedAgentId was the reviewer, and the only project policy guard was
// off. The actor was neither the assignee nor the project lead, and the write
// was accepted: the implementer approved its own release. State changes must be
// refused for an agent that is neither the current assignee nor the lead.
test("c87002d6: a non-assignee non-lead agent cannot close someone else's task", () => {
    const error = validateTaskStateTransition({
        project: project({ leadAgentId: "reviewer", requireApprovalForDone: false, requireReviewBeforeDone: false, onlyLeadCanChangeStatus: false }),
        task: task({ assignedAgentId: "reviewer", state: TASK_STATES.review }),
        requestedState: TASK_STATES.done,
        actorAgentId: "implementer",
    });
    assert.ok(error, "a non-assignee must not be able to close a task assigned to the reviewer");
});

test("c87002d6: a non-assignee non-lead agent cannot start someone else's task", () => {
    const error = validateTaskStateTransition({
        project: project({ leadAgentId: "reviewer" }),
        task: task({ assignedAgentId: "reviewer", state: TASK_STATES.inbox }),
        requestedState: TASK_STATES.inProgress,
        actorAgentId: "implementer",
    });
    assert.ok(error, "a non-assignee must not be able to start a task assigned to another agent");
});

// The lead still routes: assignment, unblocking and status moves are its job.
test("c87002d6: the project lead can still close a task assigned to someone else", () => {
    const error = validateTaskStateTransition({
        project: project({ leadAgentId: "lead" }),
        task: task({ assignedAgentId: "worker", state: TASK_STATES.review }),
        requestedState: TASK_STATES.done,
        actorAgentId: "lead",
    });
    assert.equal(error, null);
});

// --- case c87002d6: the two writes of 2026-11-19 and the identity behind them ---

test("c87002d6: a company token cannot sign a status change, and the refusal names the token", () => {
    const error = taskStateChangeDenial({
        project: { leadAgentId: "reviewer" },
        task: { assignedAgentId: "reviewer" },
        signature: { type: "system", id: null, tokenId: "tok_7f3a91" },
    });
    assert.ok(error, "a token that resolves to no agent must not be allowed to move status");
    assert.ok(error.includes("tok_7f3a91"), "the 403 must name the tokenId so the writer can be found");
});

test("c87002d6: a scheduler with no token behind it may still close", () => {
    const error = taskStateChangeDenial({
        project: { leadAgentId: "lead" },
        task: { assignedAgentId: "worker" },
        signature: { type: "system", id: null, tokenId: null },
    });
    assert.equal(error, null);
});

test("c87002d6: the 15:47:10 reassignment is refused", () => {
    const error = taskAssignmentDenial({
        project: { leadAgentId: "lead" },
        task: { assignedAgentId: "reviewer" },
        nextAssignedAgentId: "implementer",
        signature: { type: "agent", id: "implementer" },
    });
    assert.ok(error, "an agent must not take over a task assigned to someone else");
});

test("a claim, the lead and the current assignee may still move ownership", () => {
    const claim = taskAssignmentDenial({
        project: { leadAgentId: "lead" },
        task: { assignedAgentId: null },
        nextAssignedAgentId: "implementer",
        signature: { type: "agent", id: "implementer" },
    });
    assert.equal(claim, null, "claiming unassigned work stays open");

    const routing = taskAssignmentDenial({
        project: { leadAgentId: "lead" },
        task: { assignedAgentId: "worker" },
        nextAssignedAgentId: "other",
        signature: { type: "agent", id: "lead" },
    });
    assert.equal(routing, null, "the project lead routes work");

    const handback = taskAssignmentDenial({
        project: { leadAgentId: "lead" },
        task: { assignedAgentId: "worker" },
        nextAssignedAgentId: "lead",
        signature: { type: "agent", id: "worker" },
    });
    assert.equal(handback, null, "the assignee may hand its own task back");
});

test("an internal call with no actor is trusted, so the fleet keeps closing its own work", () => {
    const close = taskStateChangeDenial({
        project: { leadAgentId: null },
        task: { assignedAgentId: "worker" },
        signature: null,
    });
    assert.equal(close, null, "the pipeline closing its own task passes no actor");

    const handoff = taskAssignmentDenial({
        project: { leadAgentId: null },
        task: { assignedAgentId: null },
        nextAssignedAgentId: "worker",
        signature: null,
    });
    assert.equal(handoff, null, "server-side hand-off helpers pass no actor");
});
