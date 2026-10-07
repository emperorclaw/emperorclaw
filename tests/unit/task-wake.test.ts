import { test } from "node:test";
import assert from "node:assert/strict";
import {
    AGENT_WAKE_COALESCE_MS,
    decideWakeCoalescing,
    filterPendingStillOpen,
    minimalWakeText,
    sanitizePromptText,
    taskAcceptanceCriteria,
    taskAssignedWakeText,
    taskTitle,
    wakeBatchText,
} from "../../src/lib/task-wake";

const taskId = "11111111-1111-1111-1111-111111111111";

test("taskTitle reads inputJson.title and falls back to taskType", () => {
    assert.equal(taskTitle({ taskType: "review", inputJson: { title: "Review the PR" } }), "Review the PR");
    assert.equal(taskTitle({ taskType: "review", inputJson: {} }), "review");
    assert.equal(taskTitle({ taskType: "review", inputJson: null }), "review");
});

test("taskAcceptanceCriteria finds the criteria field and truncates", () => {
    assert.equal(taskAcceptanceCriteria({ inputJson: { acceptanceCriteria: "All tests pass" } }), "All tests pass");
    assert.equal(taskAcceptanceCriteria({ inputJson: { description: "Do the thing" } }), "Do the thing");
    assert.equal(taskAcceptanceCriteria({ inputJson: {} }), null);
    const long = "x".repeat(500);
    assert.ok((taskAcceptanceCriteria({ inputJson: { acceptanceCriteria: long } }) ?? "").length <= 120);
});

test("sanitizePromptText collapses whitespace/newlines and caps at 120", () => {
    assert.equal(sanitizePromptText("line one\n\n  line   two\nthird"), "line one line two third");
    assert.ok(sanitizePromptText("x".repeat(500)).length <= 120);
    assert.equal(sanitizePromptText(""), "");
});

test("taskAssignedWakeText lists one task as a card with next steps", () => {
    const text = taskAssignedWakeText([
        { id: taskId, title: "Fix [signup]", projectName: "Acme Launch", state: "inbox", assignedBy: "PM", acceptanceCriteria: "Form submits" },
    ]);
    assert.match(text, /New task assigned to you/);
    assert.match(text, /\[Fix signup\]\(emperor:\/\/task\/1{8}-1{4}-1{4}-1{4}-1{12}\)/);
    assert.match(text, /Project: "Acme Launch"/);
    assert.match(text, /Acceptance criteria: "Form submits"/);
    assert.match(text, /set it in_progress/);
});

test("taskAssignedWakeText presents free text as quoted data and caps it", () => {
    const longTitle = "A title " + "x".repeat(300);
    const text = taskAssignedWakeText([
        { id: taskId, title: longTitle, projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: "criteria " + "y".repeat(300) },
    ]);
    // No raw newlines and no unquoted acceptance criteria survive.
    assert.ok(!text.includes("\n\nA"), "title is collapsed");
    assert.match(text, /Acceptance criteria: "criteria y+…"/);
});

test("taskAssignedWakeText lists a coalesced batch", () => {
    const text = taskAssignedWakeText([
        { id: taskId, title: "One", projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null },
        { id: "22222222-2222-2222-2222-222222222222", title: "Two", projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null },
    ]);
    assert.match(text, /Tasks assigned to you \(2\)/);
    assert.match(text, /1\. \[One\]/);
    assert.match(text, /2\. \[Two\]/);
});

test("minimalWakeText hides title/criteria/project, keeping only the task id", () => {
    const text = minimalWakeText([{ id: taskId, title: "secret title", projectName: "secret project", state: "inbox", assignedBy: "secret", acceptanceCriteria: "secret criteria" }]);
    assert.doesNotMatch(text, /secret/);
    assert.match(text, new RegExp(`emperor://task/${taskId}`));
});

test("decideWakeCoalescing: first assignment flushes immediately", () => {
    const decision = decideWakeCoalescing({
        nowMs: 1_000_000,
        lastWakeAt: 0,
        windowMs: AGENT_WAKE_COALESCE_MS,
        pending: [],
        task: { id: "a", title: "A", projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null },
    });
    assert.equal(decision.action, "flush");
    assert.equal(decision.toSend?.length, 1);
    assert.equal(decision.pending.length, 0);
});

test("decideWakeCoalescing: a burst inside the window queues, the last flushes all", () => {
    const task = (id: string) => ({ id, title: id, projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null });
    const now = 1_000_000;
    const queued = decideWakeCoalescing({ nowMs: now, lastWakeAt: now - 10_000, windowMs: AGENT_WAKE_COALESCE_MS, pending: [], task: task("a") });
    assert.equal(queued.action, "queue");
    assert.deepEqual(queued.pending.map((p) => p.id), ["a"]);

    const queued2 = decideWakeCoalescing({ nowMs: now, lastWakeAt: now - 10_000, windowMs: AGENT_WAKE_COALESCE_MS, pending: queued.pending, task: task("b") });
    assert.equal(queued2.action, "queue");
    assert.deepEqual(queued2.pending.map((p) => p.id), ["a", "b"]);

    // Past the window, everything queued plus the new task flushes in order.
    const flushed = decideWakeCoalescing({ nowMs: now + AGENT_WAKE_COALESCE_MS, lastWakeAt: now - 10_000, windowMs: AGENT_WAKE_COALESCE_MS, pending: queued2.pending, task: task("c") });
    assert.equal(flushed.action, "flush");
    assert.deepEqual(flushed.toSend?.map((p) => p.id), ["a", "b", "c"]);
    assert.equal(flushed.pending.length, 0);
});

test("decideWakeCoalescing: a re-queued task id is de-duplicated", () => {
    const task = { id: "a", title: "A", projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null };
    const now = 1_000_000;
    const first = decideWakeCoalescing({ nowMs: now, lastWakeAt: now - 10_000, windowMs: AGENT_WAKE_COALESCE_MS, pending: [], task });
    const second = decideWakeCoalescing({ nowMs: now, lastWakeAt: now - 10_000, windowMs: AGENT_WAKE_COALESCE_MS, pending: first.pending, task });
    assert.deepEqual(second.pending.map((p) => p.id), ["a"]);
});

test("filterPendingStillOpen drops queued tasks no longer assigned/open", () => {
    const task = (id: string) => ({ id, title: id, projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null });
    const pending = [task("a"), task("b"), task("c")];
    const kept = filterPendingStillOpen(pending, new Set(["a", "c"]));
    assert.deepEqual(kept.map((p) => p.id), ["a", "c"]);
});

test("wakeBatchText renders a mixed redacted/normal batch with no empty links", () => {
    const normal = { id: taskId, title: "Build signup", projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null };
    const redacted = { id: "22222222-2222-2222-2222-222222222222", title: "", projectName: "", state: "", assignedBy: "", acceptanceCriteria: null };
    const text = wakeBatchText([normal, redacted]);
    assert.match(text, /Tasks assigned to you \(2\)/);
    assert.match(text, /1\. \[Build signup\]/);
    assert.match(text, new RegExp(`2\\. \\[task\\]\\(emperor://task/22222222-2222-2222-2222-222222222222\\)`));
    assert.doesNotMatch(text, /\[\]\(emperor:\/\/task\//);
});

test("wakeBatchText: a fully normal batch uses the full text, a lone redacted one stays minimal", () => {
    const normal = { id: taskId, title: "Build", projectName: "P", state: "inbox", assignedBy: "PM", acceptanceCriteria: null };
    assert.match(wakeBatchText([normal]), /New task assigned to you/);
    const redacted = { id: taskId, title: "", projectName: "", state: "", assignedBy: "", acceptanceCriteria: null };
    const lone = wakeBatchText([redacted]);
    assert.match(lone, new RegExp(`emperor://task/${taskId}`));
    assert.doesNotMatch(lone, /\[\]\(/);
});
