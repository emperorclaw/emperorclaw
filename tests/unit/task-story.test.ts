import { test } from "node:test";
import assert from "node:assert/strict";
import {
    approvalInRun,
    dayKey,
    dayLabel,
    describeTaskEvent,
    formatCost,
    groupStoryByDay,
    mergeStory,
    pageStory,
    parseMemberScope,
    RUN_OUTCOME_LABEL,
    runOutcome,
    scopedAgentIds,
    taskHref,
    taskVisibleToScope,
    type StoryEntry,
    type StoryNames,
} from "../../src/lib/task-story";

const names: StoryNames = {
    agent: (id) => (id === "a1" ? "Atlas" : null),
    member: (id) => (id === "m1" || id === "u1" ? "Ana" : null),
};

function event(id: string, at: string): StoryEntry {
    return { kind: "event", id, at, actor: { type: "system", name: null }, tone: "system", text: id, note: null };
}

function run(id: string, at: string): StoryEntry {
    return {
        kind: "run", id, at,
        run: {
            id, agentId: "a1", agentName: "Atlas", status: "succeeded", outcome: "done", triggerKind: "task",
            startedAt: at, endedAt: at, durationMs: 1000, inputTokens: 1, outputTokens: 1, costCents: 1, toolCalls: 1,
            model: null, exitReason: null, error: null, private: false, threadHref: null, threadLabel: null, reply: null,
        },
    };
}

// ─── Outcome mapping ────────────────────────────────────────────────────────

test("runOutcome maps every ledger status to one of four outcomes (or running)", () => {
    assert.equal(runOutcome({ status: "running" }), "running");
    assert.equal(runOutcome({ status: "succeeded" }), "done");
    assert.equal(runOutcome({ status: "failed" }), "failed");
    assert.equal(runOutcome({ status: "timeout" }), "failed");
    assert.equal(runOutcome({ status: "lost" }), "failed");
    assert.equal(runOutcome({ status: "cancelled" }), "stopped");
    assert.equal(runOutcome({ status: "blocked" }), "needs_you");
    assert.equal(runOutcome({ status: "something_new" }), "stopped");
});

test("a succeeded run that left an approval pending, or asked for a human, needs you", () => {
    assert.equal(runOutcome({ status: "succeeded" }, { pendingApproval: true }), "needs_you");
    assert.equal(runOutcome({ status: "succeeded", exitReason: "approval_required" }), "needs_you");
    assert.equal(runOutcome({ status: "succeeded", exitReason: "clarify(question)" }), "needs_you");
    assert.equal(runOutcome({ status: "succeeded", exitReason: "text_response(finish_reason=stop)" }), "done");
    // A failure stays a failure even with a pending approval around.
    assert.equal(runOutcome({ status: "failed" }, { pendingApproval: true }), "failed");
});

test("outcome labels are the four product words", () => {
    assert.deepEqual(
        [RUN_OUTCOME_LABEL.done, RUN_OUTCOME_LABEL.needs_you, RUN_OUTCOME_LABEL.failed, RUN_OUTCOME_LABEL.stopped],
        ["Done", "Needs you", "Failed", "Stopped"],
    );
});

test("approvalInRun counts requests while the run was open, plus a short grace", () => {
    const window = { startedAtMs: 1_000, endedAtMs: 10_000 };
    assert.equal(approvalInRun(500, window), false);
    assert.equal(approvalInRun(5_000, window), true);
    assert.equal(approvalInRun(10_000 + 60_000, window), true);
    assert.equal(approvalInRun(10_000 + 5 * 60_000, window), false);
    assert.equal(approvalInRun(99_999_999, { startedAtMs: 1_000, endedAtMs: null }), true);
});

// ─── Merge, page and group ──────────────────────────────────────────────────

test("mergeStory orders newest first across sources, run first on ties", () => {
    const merged = mergeStory(
        [event("e1", "2026-10-20T10:00:00Z"), event("e2", "2026-10-21T09:00:00Z")],
        [run("r1", "2026-10-21T09:00:00Z"), run("r2", "2026-10-19T08:00:00Z")],
    );
    assert.deepEqual(merged.map((entry) => entry.id), ["r1", "e2", "e1", "r2"]);
});

test("pageStory caps at the limit and pages with a before cursor without gaps or repeats", () => {
    const merged = mergeStory(Array.from({ length: 7 }, (_, i) => event(`e${i}`, new Date(Date.UTC(2026, 9, 20, 10, i)).toISOString())));
    const first = pageStory(merged, { limit: 3 });
    assert.deepEqual(first.entries.map((e) => e.id), ["e6", "e5", "e4"]);
    assert.equal(first.hasMore, true);
    const second = pageStory(merged, { limit: 3, before: first.nextBefore });
    assert.deepEqual(second.entries.map((e) => e.id), ["e3", "e2", "e1"]);
    const third = pageStory(merged, { limit: 3, before: second.nextBefore });
    assert.deepEqual(third.entries.map((e) => e.id), ["e0"]);
    assert.equal(third.hasMore, false);
    assert.equal(third.nextBefore, null);
});

test("pageStory defaults to 50 entries", () => {
    const merged = mergeStory(Array.from({ length: 60 }, (_, i) => event(`e${i}`, new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString())));
    const page = pageStory(merged);
    assert.equal(page.entries.length, 50);
    assert.equal(page.hasMore, true);
});

test("groupStoryByDay groups by local day and labels Today / Yesterday / dates", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const entries = [
        event("a", "2026-10-23T08:00:00Z"),
        event("b", "2026-10-23T01:00:00Z"),
        event("c", "2026-10-22T23:30:00Z"),
        event("d", "2026-10-20T10:00:00Z"),
        event("e", "2025-12-31T10:00:00Z"),
    ];
    const utc = groupStoryByDay(entries, { now, timeZone: "UTC" });
    assert.deepEqual(utc.map((day) => [day.label, day.entries.map((e) => e.id)]), [
        ["Today", ["a", "b"]],
        ["Yesterday", ["c"]],
        ["Tue, Oct 20", ["d"]],
        ["Dec 31, 2025", ["e"]],
    ]);
    // 01:00 UTC on the 23rd is still the 22nd in New York; 23:30 UTC on the 22nd too.
    const ny = groupStoryByDay(entries, { now, timeZone: "America/New_York" });
    assert.deepEqual(ny.map((day) => [day.key, day.entries.map((e) => e.id)]), [
        ["2026-10-23", ["a"]],
        ["2026-10-22", ["b", "c"]],
        ["2026-10-20", ["d"]],
        ["2025-12-31", ["e"]],
    ]);
});

test("dayKey and dayLabel survive bad input", () => {
    assert.equal(dayKey("not a date", "UTC"), "unknown");
    assert.equal(dayLabel("unknown", new Date("2026-10-23T00:00:00Z"), "UTC"), "unknown");
});

// ─── Event lines ────────────────────────────────────────────────────────────

test("describeTaskEvent turns task_events into plain lines", () => {
    const base = { id: "x", createdAt: "2026-10-23T10:00:00Z", actorId: null };
    assert.deepEqual(
        describeTaskEvent({ ...base, eventType: "task_note", actorType: "agent", actorId: "a1", payloadJson: { note: "Draft ready", kind: "progress" } }, names),
        { actor: { type: "agent", name: "Atlas" }, tone: "note", text: "Note", note: "Draft ready" },
    );
    assert.equal(describeTaskEvent({ ...base, eventType: "task_note", actorType: "agent", payloadJson: { note: "x", kind: "blocker" } }, names).tone, "problem");
    assert.equal(describeTaskEvent({ ...base, eventType: "task_generated", actorType: "system", payloadJson: { assignee: { type: "agent", id: "a1" } } }, names).text, "Created and assigned to Atlas");
    assert.equal(describeTaskEvent({ ...base, eventType: "task_claimed", actorType: "agent", actorId: "a1", payloadJson: null }, names).text, "Claimed by Atlas");
    assert.equal(describeTaskEvent({ ...base, eventType: "task_reassigned", actorType: "human", actorId: "u1", payloadJson: { assignee: { type: "human", id: "m1" } } }, names).text, "Reassigned to Ana");
    assert.equal(describeTaskEvent({ ...base, eventType: "task_reassigned", actorType: "human", payloadJson: { assignee: null } }, names).text, "Unassigned");
    const review = describeTaskEvent({ ...base, eventType: "task_review", actorType: "agent", actorId: "a1", payloadJson: { comment: "Ready for a look" } }, names);
    assert.deepEqual([review.text, review.tone, review.note], ["Moved to Review", "state", "Ready for a look"]);
    assert.equal(describeTaskEvent({ ...base, eventType: "task_failed", actorType: "agent", payloadJson: {} }, names).tone, "problem");
    assert.equal(describeTaskEvent({ ...base, eventType: "dead_lettered", actorType: "system", payloadJson: {} }, names).tone, "problem");
    assert.equal(describeTaskEvent({ ...base, eventType: "stall_nudge", actorType: "system", payloadJson: {} }, names).text, "Nudged after no progress");
    assert.equal(describeTaskEvent({ ...base, eventType: "custom_thing", actorType: "system", payloadJson: {} }, names).text, "custom thing");
});

// ─── Scope ──────────────────────────────────────────────────────────────────

test("taskVisibleToScope follows the project's customer, like member-scope", () => {
    assert.equal(taskVisibleToScope({ customerId: "c1" }, null), true);
    assert.equal(taskVisibleToScope({ customerId: null }, null), true);
    assert.equal(taskVisibleToScope({ customerId: "c1" }, { mode: "all" }), true);
    assert.equal(taskVisibleToScope({ customerId: "c1" }, { mode: "restricted", agentIds: [], customerIds: ["c1"] }), true);
    assert.equal(taskVisibleToScope({ customerId: "c1" }, { mode: "restricted", agentIds: ["a1"], customerIds: ["c2"] }), false);
    // Internal projects (no customer) are hidden from restricted members.
    assert.equal(taskVisibleToScope({ customerId: null }, { mode: "restricted", agentIds: ["a1"], customerIds: ["c1"] }), false);
    assert.equal(taskVisibleToScope({ customerId: "c1" }, { mode: "restricted" }), false);
});

test("scopedAgentIds: null when unrestricted, [] means none", () => {
    assert.equal(scopedAgentIds(null), null);
    assert.equal(scopedAgentIds({ mode: "all", agentIds: ["a1"] }), null);
    assert.deepEqual(scopedAgentIds({ mode: "restricted", agentIds: ["a1"] }), ["a1"]);
    assert.deepEqual(scopedAgentIds({ mode: "restricted" }), []);
});

test("parseMemberScope only restricts on an explicit restricted mode", () => {
    assert.equal(parseMemberScope(null), null);
    assert.equal(parseMemberScope({}), null);
    assert.equal(parseMemberScope({ mode: "all", agentIds: ["a"] }), null);
    assert.deepEqual(parseMemberScope({ mode: "restricted", agentIds: ["a", 3, ""], customerIds: "nope" }), { mode: "restricted", agentIds: ["a"], customerIds: [] });
});

// ─── Copy ───────────────────────────────────────────────────────────────────

test("taskHref and formatCost", () => {
    assert.equal(taskHref("t1"), "/projects/tasks/t1");
    assert.equal(taskHref("t1", "r1"), "/projects/tasks/t1#run-r1");
    assert.equal(formatCost(21), "$0.21");
    assert.equal(formatCost(0.4), "<$0.01");
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(null), null);
});
