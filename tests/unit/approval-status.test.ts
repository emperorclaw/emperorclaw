import { test } from "node:test";
import assert from "node:assert/strict";
import {
    EXTERNAL_ACTION_TYPES,
    EXTERNAL_APPROVAL_TTL_MS,
    approvalAgeDays,
    approvalDecisionMessage,
    isExpirableApproval,
    isExternalAction,
    isStaleApproval,
    mayProceed,
    resolutionTaskState,
} from "../../src/lib/approval-status";

const H = 3_600_000;

test("mayProceed is true only for an explicit approval", () => {
    assert.equal(mayProceed("approved"), true);
    for (const status of ["pending", "rejected", "dismissed", "expired", null, undefined]) {
        assert.equal(mayProceed(status), false, `${status} must not proceed`);
    }
});

test("external actions are the outward/irreversible ones, never task_done", () => {
    for (const action of EXTERNAL_ACTION_TYPES) assert.equal(isExternalAction(action), true);
    assert.equal(isExternalAction("task_done"), false);
    assert.equal(isExternalAction(null), false);
    assert.ok(!(EXTERNAL_ACTION_TYPES as readonly string[]).includes("task_done"));
});

test("isExpirableApproval: only pending, only external, only older than the TTL", () => {
    const now = 100 * H;
    const justUnder = { status: "pending", actionType: "send_email", requestedAtMs: now - EXTERNAL_APPROVAL_TTL_MS + H };
    const overTtl = { status: "pending", actionType: "send_email", requestedAtMs: now - EXTERNAL_APPROVAL_TTL_MS - H };
    assert.equal(isExpirableApproval(justUnder, now), false, "under 48h stays pending");
    assert.equal(isExpirableApproval(overTtl, now), true, "over 48h expires");
    assert.equal(isExpirableApproval({ ...overTtl, actionType: "task_done" }, now), false, "internal action never expires");
    assert.equal(isExpirableApproval({ ...overTtl, status: "approved" }, now), false, "resolved approvals never expire");
});

test("isStaleApproval and approvalAgeDays flag any approval older than 48h", () => {
    const now = 100 * H;
    assert.equal(isStaleApproval(now - 48 * H + H, now), false);
    assert.equal(isStaleApproval(now - 48 * H - H, now), true);
    assert.equal(approvalAgeDays(now - 4 * 24 * H, now), 4);
    assert.equal(approvalAgeDays(now - H, now), 1, "never reports 0 days");
});

test("resolutionTaskState: dismiss/expire leave the task untouched, reject/approve move it", () => {
    assert.equal(resolutionTaskState("dismissed", "send_email"), null);
    assert.equal(resolutionTaskState("expired", "send_email"), null);
    assert.equal(resolutionTaskState("rejected", "send_email"), "in_progress");
    assert.equal(resolutionTaskState("approved", "send_email"), "in_progress");
    assert.equal(resolutionTaskState("approved", "task_done"), "done");
});

test("approvalDecisionMessage: dismissal tells the agent not to act, with the note", () => {
    const message = approvalDecisionMessage({
        status: "dismissed",
        actionType: "send_email",
        refs: "[Email](emperor://task/t1)",
        note: "No longer needed",
    });
    assert.match(message.text, /^Approval dismissed for \[Email\]\(emperor:\/\/task\/t1\) — do NOT perform this action; it is obsolete\./);
    assert.match(message.text, /No longer needed/);
    assert.equal(message.deliveryState, "queued", "the agent is woken so it stops waiting");

    const noNote = approvalDecisionMessage({ status: "dismissed", actionType: "publish", refs: "[Post](emperor://task/t2)" });
    assert.match(noNote.text, /do NOT perform this action/);
    assert.ok(!noNote.text.includes('Note: ""'));
});

test("approvalDecisionMessage: expiry tells the agent not to act and to ask again", () => {
    const message = approvalDecisionMessage({ status: "expired", actionType: "send_email", refs: "[Email](emperor://task/t1)" });
    assert.match(message.text, /^Approval expired for \[Email\]\(emperor:\/\/task\/t1\) — do NOT perform this action\. Ask again if it is still needed\.$/);
    assert.equal(message.deliveryState, "queued");
});

test("approvalDecisionMessage: approved task_done resolves; other approvals queue", () => {
    const closed = approvalDecisionMessage({ status: "approved", actionType: "task_done", refs: "x" });
    assert.equal(closed.deliveryState, "resolved");
    assert.match(closed.text, /^Approval granted for x\./);
    const action = approvalDecisionMessage({ status: "approved", actionType: "send_email", refs: "x", note: "go" });
    assert.equal(action.deliveryState, "queued");
    assert.match(action.text, /Approval granted for x: "go"/);
});
