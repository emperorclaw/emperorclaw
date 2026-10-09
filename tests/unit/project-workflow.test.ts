import { test } from "node:test";
import assert from "node:assert/strict";
import { validateTaskStateTransition } from "../../src/lib/project-workflow";
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
