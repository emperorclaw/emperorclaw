import { test } from "node:test";
import assert from "node:assert/strict";
import { pickActivity, PRIVATE_ACTIVITY, PRIVATE_RUN_ERROR, redactRunForViewer, threadVisibleToViewer, type TypingRow } from "../../src/lib/agent-activity";

const at = (s: number) => new Date(Date.UTC(2026, 9, 22, 12, 0, s));
const row = (over: Partial<TypingRow>): TypingRow => ({
    agentId: "a1", threadId: "t-team", threadType: "team", typingUntil: at(10), activity: null, ...over,
});

test("team and group activity is shown with its thread", () => {
    const out = pickActivity([row({ activity: "tool: web_search" })], new Set());
    assert.deepEqual(out.get("a1"), { activity: "tool: web_search", threadId: "t-team", until: at(10).getTime() });
});

test("a private thread the viewer is not in is redacted and unlinked", () => {
    const out = pickActivity([row({ threadId: "t-dm", threadType: "direct", activity: "thinking: the customer's salary is…" })], new Set());
    assert.deepEqual(out.get("a1"), { activity: PRIVATE_ACTIVITY, threadId: null, until: at(10).getTime() });
});

test("a private thread the viewer takes part in is shown", () => {
    const out = pickActivity([row({ threadId: "t-dm", threadType: "direct", activity: "drafting reply" })], new Set(["t-dm"]));
    assert.equal(out.get("a1")?.activity, "drafting reply");
    assert.equal(out.get("a1")?.threadId, "t-dm");
});

test("a row with text beats a bare typing row, then the later one wins", () => {
    const out = pickActivity([
        row({ threadId: "t1", typingUntil: at(30), activity: null }),
        row({ threadId: "t2", typingUntil: at(10), activity: "step 1" }),
        row({ threadId: "t3", typingUntil: at(20), activity: "step 2" }),
    ], new Set());
    assert.equal(out.get("a1")?.activity, "step 2");
    assert.equal(out.get("a1")?.threadId, "t3");
});

test("blank activity counts as none and long lines are capped", () => {
    assert.equal(pickActivity([row({ activity: "   " })], new Set()).get("a1")?.activity, null);
    assert.equal(pickActivity([row({ activity: "x".repeat(500) })], new Set()).get("a1")?.activity?.length, 200);
});

test("run threads: public, unthreaded and joined threads are visible; others are not", () => {
    const mine = new Set(["t-mine"]);
    assert.equal(threadVisibleToViewer(null, null, mine), true);
    assert.equal(threadVisibleToViewer("t-team", "team", mine), true);
    assert.equal(threadVisibleToViewer("t-group", "group", mine), true);
    assert.equal(threadVisibleToViewer("t-mine", "direct", mine), true);
    assert.equal(threadVisibleToViewer("t-dm", "direct", mine), false);
    assert.equal(threadVisibleToViewer("t-unknown", undefined, mine), false);
});

test("a run in a hidden thread loses its thread id and raw error", () => {
    const run = { id: "r1", threadId: "t-dm", error: "customer said: my card is 4111…" };
    assert.deepEqual(redactRunForViewer(run, false), { id: "r1", threadId: null, error: PRIVATE_RUN_ERROR });
    assert.deepEqual(redactRunForViewer({ id: "r2", threadId: "t-dm", error: null }, false), { id: "r2", threadId: null, error: null });
    assert.equal(redactRunForViewer(run, true), run);
});
