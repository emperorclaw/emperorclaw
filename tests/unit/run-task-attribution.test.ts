import { test } from "node:test";
import assert from "node:assert/strict";
import {
    groupActivity,
    needsActivityAttribution,
    pickActivityTask,
    runWindowsOverlap,
    taskFromTriggerMetadata,
    triggerTaskCandidate,
} from "../../src/lib/run-task-attribution";
import { RESERVED_MESSAGE_METADATA_KEYS, stripReservedMetadata } from "../../src/lib/message-routing";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";
const T3 = "33333333-3333-4333-8333-333333333333";

// ─── Rule (a): trigger message metadata ─────────────────────────────────────

test("taskFromTriggerMetadata takes the single id of a task-assigned notice", () => {
    assert.equal(taskFromTriggerMetadata({ taskAssigned: true, taskIds: [T1], reason: "assigned" }), T1);
});

test("taskFromTriggerMetadata ignores a notice about several tasks", () => {
    assert.equal(taskFromTriggerMetadata({ taskAssigned: true, taskIds: [T1, T2] }), null);
    // Even when a taskId is also present: the message is about several tasks.
    assert.equal(taskFromTriggerMetadata({ taskIds: [T1, T2], taskId: T1 }), null);
});

test("taskFromTriggerMetadata treats a repeated id as one task and normalizes case", () => {
    assert.equal(taskFromTriggerMetadata({ taskIds: [T1, T1.toUpperCase()] }), T1);
});

test("taskFromTriggerMetadata falls back to taskId when there is no taskIds", () => {
    assert.equal(taskFromTriggerMetadata({ taskId: T2 }), T2);
    assert.equal(taskFromTriggerMetadata({ taskIds: [], taskId: T2 }), T2);
});

test("taskFromTriggerMetadata rejects malformed metadata", () => {
    assert.equal(taskFromTriggerMetadata(null), null);
    assert.equal(taskFromTriggerMetadata("x"), null);
    assert.equal(taskFromTriggerMetadata([T1]), null);
    assert.equal(taskFromTriggerMetadata({}), null);
    assert.equal(taskFromTriggerMetadata({ taskIds: ["not-a-uuid"] }), null);
    assert.equal(taskFromTriggerMetadata({ taskIds: [T1, "not-a-uuid"] }), null);
    assert.equal(taskFromTriggerMetadata({ taskIds: [42] }), null);
    assert.equal(taskFromTriggerMetadata({ taskId: "'; drop table tasks; --" }), null);
});

test("triggerTaskCandidate requires the same company", () => {
    const message = { companyId: "c1", senderType: "system", targetAgentId: null, metadataJson: { taskIds: [T1] } };
    assert.equal(triggerTaskCandidate(message, { companyId: "c1", agentId: "a1" }), T1);
    assert.equal(triggerTaskCandidate(message, { companyId: "c2", agentId: "a1" }), null);
    assert.equal(triggerTaskCandidate(null, { companyId: "c1", agentId: "a1" }), null);
});

test("triggerTaskCandidate ignores a notice addressed to another agent", () => {
    const message = { companyId: "c1", senderType: "system", targetAgentId: "a2", metadataJson: { taskIds: [T1] } };
    assert.equal(triggerTaskCandidate(message, { companyId: "c1", agentId: "a1" }), null);
    assert.equal(triggerTaskCandidate(message, { companyId: "c1", agentId: "a2" }), T1);
});

test("triggerTaskCandidate trusts only system messages, never an agent's or a person's metadata", () => {
    const run = { companyId: "c1", agentId: "a1" };
    const metadataJson = { taskAssigned: true, taskIds: [T1], taskId: T1 };
    assert.equal(triggerTaskCandidate({ companyId: "c1", senderType: "system", targetAgentId: "a1", metadataJson }, run), T1);
    for (const senderType of ["agent", "human", "", "System"]) {
        assert.equal(triggerTaskCandidate({ companyId: "c1", senderType, targetAgentId: "a1", metadataJson }, run), null, senderType);
    }
});

test("taskId and taskIds are reserved: a runtime cannot stamp them on its own message", () => {
    assert.ok((RESERVED_MESSAGE_METADATA_KEYS as readonly string[]).includes("taskId"));
    assert.ok((RESERVED_MESSAGE_METADATA_KEYS as readonly string[]).includes("taskIds"));
    assert.deepEqual(stripReservedMetadata({ taskId: T1, taskIds: [T1], chatId: "x" }), { chatId: "x" });
});

// ─── Rule (c): the agent's task activity in the run window ──────────────────

test("pickActivityTask picks the task with the most events", () => {
    assert.equal(pickActivityTask([
        { taskId: T1, events: 1, lastAtMs: 900 },
        { taskId: T2, events: 3, lastAtMs: 100 },
    ]), T2);
});

test("pickActivityTask breaks a tie by the latest activity, then by id", () => {
    assert.equal(pickActivityTask([
        { taskId: T1, events: 2, lastAtMs: 500 },
        { taskId: T2, events: 2, lastAtMs: 700 },
    ]), T2);
    assert.equal(pickActivityTask([
        { taskId: T2, events: 2, lastAtMs: 700 },
        { taskId: T3, events: 2, lastAtMs: 700 },
        { taskId: T1, events: 2, lastAtMs: 700 },
    ]), T3, "deterministic regardless of input order");
});

test("pickActivityTask returns null when there is no activity", () => {
    assert.equal(pickActivityTask([]), null);
    assert.equal(pickActivityTask([{ taskId: T1, events: 0, lastAtMs: 1 }]), null);
});

test("groupActivity folds rows per task with counts and the latest time", () => {
    const groups = groupActivity([
        { taskId: T1, atMs: 100 },
        { taskId: T2, atMs: 300 },
        { taskId: T1, atMs: 200 },
    ]);
    assert.deepEqual(groups.find((g) => g.taskId === T1), { taskId: T1, events: 2, lastAtMs: 200 });
    assert.deepEqual(groups.find((g) => g.taskId === T2), { taskId: T2, events: 1, lastAtMs: 300 });
    assert.equal(pickActivityTask(groups), T1);
});

test("needsActivityAttribution only for a finished agent run with no task", () => {
    const ended = new Date();
    assert.equal(needsActivityAttribution({ taskId: null, agentId: "a1", endedAt: ended }), true);
    assert.equal(needsActivityAttribution({ taskId: T1, agentId: "a1", endedAt: ended }), false, "never re-attributes");
    assert.equal(needsActivityAttribution({ taskId: null, agentId: null, endedAt: ended }), false);
    assert.equal(needsActivityAttribution({ taskId: null, agentId: "a1", endedAt: null }), false);
});

test("runWindowsOverlap: strict overlap, back-to-back runs do not overlap, an open run extends forever", () => {
    assert.equal(runWindowsOverlap({ startedAtMs: 0, endedAtMs: 100 }, { startedAtMs: 50, endedAtMs: 150 }), true);
    assert.equal(runWindowsOverlap({ startedAtMs: 50, endedAtMs: 150 }, { startedAtMs: 0, endedAtMs: 100 }), true, "symmetric");
    assert.equal(runWindowsOverlap({ startedAtMs: 0, endedAtMs: 100 }, { startedAtMs: 20, endedAtMs: 30 }), true, "contained");
    assert.equal(runWindowsOverlap({ startedAtMs: 0, endedAtMs: 100 }, { startedAtMs: 100, endedAtMs: 200 }), false, "back to back");
    assert.equal(runWindowsOverlap({ startedAtMs: 0, endedAtMs: 100 }, { startedAtMs: 150, endedAtMs: 200 }), false);
    assert.equal(runWindowsOverlap({ startedAtMs: 0, endedAtMs: 100 }, { startedAtMs: 50, endedAtMs: null }), true, "still running");
    assert.equal(runWindowsOverlap({ startedAtMs: 200, endedAtMs: 300 }, { startedAtMs: 50, endedAtMs: null }), true, "an open run started earlier");
    assert.equal(runWindowsOverlap({ startedAtMs: 0, endedAtMs: 100 }, { startedAtMs: 100, endedAtMs: null }), false, "an open run started at the end");
});
