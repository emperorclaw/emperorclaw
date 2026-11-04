import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEventSource } from "../../src/lib/run-events";
import { screenAscii, screenStepsFromRuns, STEP_LABEL_MAX, STEP_TEXT_MAX, type RunThoughtRow } from "../../src/lib/run-thoughts";
import { fitThoughtsToBudget, LIVE_MIN_THOUGHTS, LIVE_PAYLOAD_BUDGET_BYTES } from "../../src/lib/live-feed-v2";
import { LAST_TITLE_MAX, lastDoneOf, liveFeedEtag, type LiveFeed } from "../../src/lib/live-feed";

/**
 * 2.1 device feed: per-agent `step` (the running run's current step) and
 * `last` (latest finished task). Steps carry real text only where the screen
 * may read the run; everything else is a generic label.
 */

const NOW = 2_000_000;
const AGENT = "22222222-2222-4222-8222-222222222222";

function ev(seq: number, kind: string, extra: Partial<RunEventSource> = {}): RunEventSource {
    return {
        seq, kind, ts: new Date(NOW - 60_000 + seq * 1_000),
        toolName: null, toolCallId: null, status: null, durationMs: null, summary: null, data: null,
        ...extra,
    };
}

function row(events: RunEventSource[], extra: Partial<RunThoughtRow> = {}): RunThoughtRow {
    return {
        runId: "11111111-1111-4111-8111-111111111111", agentId: AGENT, threadId: null, threadType: null,
        pairThread: false, viewerInThread: false, viewerOwnsThread: false, startedAtMs: NOW - 120_000, events, ...extra,
    };
}

const steps = (rows: RunThoughtRow[], allowText = true) => screenStepsFromRuns(rows, { nowMs: NOW, includePairThreads: true, allowText });

test("a visible run gives the step's label and real text, with seconds since the step", () => {
    const tool = steps([row([ev(1, "reasoning", { summary: "Plan" }), ev(2, "tool.start", { toolName: "terminal", summary: "npm test" })])]).get(AGENT);
    assert.deepEqual(tool, { label: "Running terminal", text: "npm test", sec: 58 });

    const thinking = steps([row([ev(1, "reasoning", { summary: "Comparing the two supplier quotes" })])]).get(AGENT);
    assert.deepEqual(thinking, { label: "Thinking", text: "Comparing the two supplier quotes", sec: 59 });
});

test("a bare beat or a generic line is a label without text, never a placeholder text", () => {
    assert.deepEqual(steps([row([ev(1, "reasoning")])]).get(AGENT), { label: "Thinking", sec: 59 });
    assert.deepEqual(steps([row([ev(1, "turn.started")])]).get(AGENT), { label: "Working", sec: 59 });
    assert.deepEqual(steps([row([ev(1, "tool.end", { toolName: "web", status: "ok" })])]).get(AGENT), { label: "web done", sec: 59 });
});

test("a run the screen may not read, or a token without thoughts, gets only the generic label", () => {
    const events = [ev(1, "tool.start", { toolName: "terminal", summary: "cat salary.csv" })];
    const otherMembersChat = row(events, { threadId: "33333333-3333-4333-8333-333333333333", threadType: "direct", viewerInThread: true, viewerOwnsThread: false });
    assert.deepEqual(steps([otherMembersChat]).get(AGENT), { label: "Running terminal", sec: 59 });
    assert.deepEqual(steps([row(events)], false).get(AGENT), { label: "Running terminal", sec: 59 });

    const notice = [ev(1, "notice", { summary: "Quoting the customer's private note" })];
    assert.deepEqual(steps([row(notice)], false).get(AGENT), { label: "Working", sec: 59 }, "notices never become a label");
    const reasoning = [ev(1, "reasoning", { summary: "The payroll numbers" })];
    assert.deepEqual(steps([otherMembersChat].map((r) => ({ ...r, events: reasoning }))).get(AGENT), { label: "Thinking", sec: 59 });

    const ownChat = row(reasoning, { threadId: "44444444-4444-4444-8444-444444444444", threadType: "direct", viewerOwnsThread: true });
    assert.equal(steps([ownChat]).get(AGENT)?.text, "The payroll numbers", "the creator's own private chat is readable");
});

test("no events, no step; the newest run of an agent wins", () => {
    assert.equal(steps([row([])]).size, 0);
    const older = row([ev(1, "tool.start", { toolName: "old", summary: "x" })], { runId: "a", startedAtMs: NOW - 300_000 });
    const newer = row([ev(1, "tool.start", { toolName: "new", summary: "y" })], { runId: "b", startedAtMs: NOW - 100_000 });
    assert.equal(steps([older, newer]).get(AGENT)?.label, "Running new");
});

test("step text and labels are ASCII, redacted and capped", () => {
    const long = steps([row([ev(1, "tool.start", { toolName: "terminal", summary: `curl -H "Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz0123456789" ${"é".repeat(200)}` })])]).get(AGENT)!;
    assert.ok(Array.from(long.text!).length <= STEP_TEXT_MAX);
    assert.ok(!long.text!.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"));
    assert.ok(/^[\x20-\x7E]*$/.test(long.text!), long.text);
    const name = "x".repeat(80);
    const label = steps([row([ev(1, "tool.start", { toolName: name })])]).get(AGENT)!.label;
    assert.ok(label.length <= STEP_LABEL_MAX && label.startsWith("Running x"));
    assert.equal(screenAscii("Zoë’s “plan” — v2…"), "Zoe's \"plan\" - v2...");
});

test("last: an ASCII task title of at most 56 chars with its age", () => {
    assert.equal(lastDoneOf(undefined, NOW), undefined);
    assert.deepEqual(lastDoneOf({ title: "Ship the café menu", taskType: "ops", doneAt: new Date(NOW - 90_000) }, NOW), { title: "Ship the cafe menu", ageSec: 90 });
    const long = lastDoneOf({ title: "T".repeat(90), taskType: "ops", doneAt: new Date(NOW) }, NOW)!;
    assert.equal(Array.from(long.title).length, LAST_TITLE_MAX);
    assert.ok(long.title.endsWith("..."));
    assert.ok(lastDoneOf({ title: null, taskType: "report", doneAt: new Date(NOW) }, NOW)!.title.length > 0, "an untitled task falls back to its type");
});

function heavyFeed(): LiveFeed {
    const uuid = (n: number) => `${String(n).padStart(8, "0")}-aaaa-4bbb-8ccc-dddddddddddd`;
    const agents = Array.from({ length: 24 }, (_, i) => ({
        id: uuid(i), name: `Agent${String(i).padStart(2, "0")} Builder`, short: `Agent${String(i).padStart(2, "0")}`,
        hue: 359, health: "healthy" as const, state: "working" as const, activity: null,
        task: { id: uuid(100 + i), title: "T".repeat(36) }, lastSeenSec: 1, unanswered: 0,
        look: { k: "h" as const, u: 359, v: 3, s: 5, h: 7, hs: 3, a: "g" as const }, act: "typing" as const, mood: "neutral" as const,
        thought: "W".repeat(140), thoughtAgeSec: i,
        step: { label: "Running terminal", text: "S".repeat(100), sec: i },
        last: { title: "L".repeat(56), ageSec: 1000 + i },
    }));
    return {
        v: 2, ts: new Date(NOW).toISOString(), company: { name: "Co" },
        summary: { agents: 24, healthy: 24, attention: 0, down: 0, idle: 0, working: 24, pendingApprovals: 0, tasksInProgress: 24, tasksOverdue: 0 },
        agents, messages: [], dm: [], events: [], needs: [],
    };
}

test("step text and last titles flex with thoughts under the payload budget; labels stay", () => {
    const feed = heavyFeed();
    const before = Buffer.byteLength(JSON.stringify(feed));
    fitThoughtsToBudget(feed);
    const after = Buffer.byteLength(JSON.stringify(feed));
    console.log(`24 agents with thought + step + last: ${before} bytes, ${after} after fitting (budget ${LIVE_PAYLOAD_BUDGET_BYTES})`);
    assert.ok(before > LIVE_PAYLOAD_BUDGET_BYTES, "the fixture really needs trimming");
    assert.ok(after <= LIVE_PAYLOAD_BUDGET_BYTES, `${after} > ${LIVE_PAYLOAD_BUDGET_BYTES}`);
    assert.ok(feed.agents.every((a) => a.step?.label === "Running terminal"), "labels are never dropped");
    assert.ok(feed.agents.filter((a) => a.step?.text).length >= LIVE_MIN_THOUGHTS);
    for (const a of feed.agents) assert.ok(!a.step?.text || a.step.text.length <= 100);
});

test("the ETag ignores step and last clocks but tracks their text", () => {
    const a = heavyFeed();
    const b = heavyFeed();
    b.agents[0].step!.sec = 999;
    b.agents[0].last!.ageSec = 999;
    assert.equal(liveFeedEtag(a), liveFeedEtag(b));
    b.agents[0].step!.text = "other";
    assert.notEqual(liveFeedEtag(a), liveFeedEtag(b));
});
