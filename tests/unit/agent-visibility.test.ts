import test from "node:test";
import assert from "node:assert/strict";
import {
    classifyRunThread,
    livePillCopy,
    runWorkLabel,
    summarizeAlsoWorking,
    type RunningRun,
} from "../../src/lib/agent-visibility";
import { workLogThreadTitle } from "../../src/lib/direct-chat-mode";

const run = (over: Partial<RunningRun>): RunningRun => ({
    runId: "r1",
    agentId: "a1",
    threadId: null,
    threadKind: "other",
    taskId: null,
    taskTitle: null,
    taskHidden: false,
    startedAt: "2026-10-22T12:00:00.000Z",
    ...over,
});

test("livePillCopy: open shows Live, connecting/closed show the reconnect fallback", () => {
    assert.deepEqual(livePillCopy("open", 15), { label: "Live", live: true });
    assert.deepEqual(livePillCopy("connecting", 15), { label: "Reconnecting… refreshing every 15 s", live: false });
    assert.deepEqual(livePillCopy("closed", 15), { label: "Reconnecting… refreshing every 15 s", live: false });
    assert.deepEqual(livePillCopy("open", 30), { label: "Live", live: true });
});

test("classifyRunThread: own private, other private, operations, team, group", () => {
    assert.deepEqual(classifyRunThread({ type: "direct", ownerUserId: "u1", isPrivate: true }, "u1"), { kind: "own-private", visible: true });
    assert.deepEqual(classifyRunThread({ type: "direct", ownerUserId: "u2", isPrivate: true }, "u1"), { kind: "other-private", visible: false });
    assert.deepEqual(classifyRunThread({ type: "direct", ownerUserId: null, isPrivate: false }, "u1"), { kind: "operations", visible: true });
    assert.deepEqual(classifyRunThread({ type: "team" }, "u1"), { kind: "team", visible: true });
    assert.deepEqual(classifyRunThread({ type: "group" }, "u1"), { kind: "group", visible: true });
    assert.deepEqual(classifyRunThread(null, "u1"), { kind: "other", visible: false });
});

test("runWorkLabel: a task title wins and links to the task page", () => {
    assert.deepEqual(runWorkLabel(run({ taskId: "t1", taskTitle: "Write the report" })), {
        text: "Write the report", href: "/projects/tasks/t1",
    });
});

test("runWorkLabel: an out-of-scope task reads 'other work' with no link", () => {
    assert.deepEqual(runWorkLabel(run({ taskHidden: true })), { text: "other work", href: null });
});

test("runWorkLabel: another person's private thread reads 'a private chat' with no link", () => {
    assert.deepEqual(runWorkLabel(run({ threadKind: "other-private" })), { text: "a private chat", href: null });
    // Even with a task attached, another person's private chat names nothing.
    assert.deepEqual(runWorkLabel(run({ threadKind: "other-private", taskId: "11111111-1111-4111-8111-111111111111", taskTitle: "Secret plan" })), { text: "a private chat", href: null });
});

test("runWorkLabel: own private and shared/team/group threads get a link", () => {
    assert.deepEqual(runWorkLabel(run({ threadId: "t1", threadKind: "own-private" })), { text: "a chat", href: "/messages?agent=a1&thread=t1" });
    assert.deepEqual(runWorkLabel(run({ threadId: "t1", threadKind: "operations" })), { text: "the work log", href: "/messages?agent=a1&thread=t1" });
    assert.deepEqual(runWorkLabel(run({ threadId: "t1", threadKind: "team" })), { text: "the team channel", href: "/messages" });
    assert.deepEqual(runWorkLabel(run({ threadId: "t1", threadKind: "group" })), { text: "a group chat", href: "/messages" });
});

test("summarizeAlsoWorking: picks the newest other-thread run and counts the rest", () => {
    const runs = [
        run({ runId: "r1", threadId: "t-current", threadKind: "operations", startedAt: "2026-10-22T12:00:00.000Z" }),
        run({ runId: "r2", threadId: "t-a", threadKind: "operations", startedAt: "2026-10-22T11:00:00.000Z" }),
        run({ runId: "r3", threadId: "t-b", threadKind: "other-private", startedAt: "2026-10-22T12:30:00.000Z" }),
    ];
    const summary = summarizeAlsoWorking(runs, "t-current");
    assert.equal(summary.primary?.runId, "r3", "newest run wins");
    assert.equal(summary.primary?.text, "a private chat");
    assert.equal(summary.primary?.href, null);
    assert.equal(summary.more, 1);
});

test("summarizeAlsoWorking: excludes the current thread and returns none when idle", () => {
    const runs = [run({ runId: "r1", threadId: "t-current", threadKind: "operations" })];
    assert.deepEqual(summarizeAlsoWorking(runs, "t-current"), { primary: null, more: 0 });
    assert.equal(summarizeAlsoWorking(runs, null).primary?.runId, "r1", "no current thread means every run counts");
});

test("workLogThreadTitle keeps the stored Operations title compatible", () => {
    assert.equal(workLogThreadTitle("Scout"), "Scout · Work log");
    assert.equal(workLogThreadTitle(null), "Agent · Work log");
});
