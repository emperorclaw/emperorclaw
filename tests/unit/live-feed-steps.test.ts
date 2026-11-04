import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEventSource } from "../../src/lib/run-events";
import { PRIVATE_ACTIVITY, screenAscii, screenStepsFromRuns, screenThoughtsFromRuns, SCREEN_RUN_FRESH_MS, STEP_LABEL_MAX, STEP_TEXT_MAX, type RunThoughtRow } from "../../src/lib/run-thoughts";
import { fitThoughtsToBudget, LIVE_MIN_THOUGHTS, LIVE_PAYLOAD_BUDGET_BYTES } from "../../src/lib/live-feed-v2";
import { capScreenExtras, LAST_TITLE_MAX, lastDoneOf, LIVE_MAX_LASTS, LIVE_MAX_STEP_TEXTS, liveFeedEtag, type LiveFeed } from "../../src/lib/live-feed";

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

test("a run the screen may not read is only 'Working in a private chat'; a readable one without thoughts gets the generic label", () => {
    const events = [ev(1, "tool.start", { toolName: "terminal", summary: "cat salary.csv" })];
    const otherMembersChat = row(events, { threadId: "33333333-3333-4333-8333-333333333333", threadType: "direct", viewerInThread: true, viewerOwnsThread: false });
    assert.deepEqual(steps([otherMembersChat]).get(AGENT), { label: PRIVATE_ACTIVITY, sec: 59 }, "no tool name for a private run");
    assert.deepEqual(steps([otherMembersChat], false).get(AGENT), { label: PRIVATE_ACTIVITY, sec: 59 });
    const workLog = row(events, { threadId: "55555555-5555-4555-8555-555555555555", threadType: "direct", viewerInThread: true });
    assert.deepEqual(steps([workLog]).get(AGENT), { label: PRIVATE_ACTIVITY, sec: 59 }, "the shared Work log is private to a screen");
    assert.deepEqual(steps([row(events)], false).get(AGENT), { label: "Running terminal", sec: 59 });
    const team = row(events, { threadId: "66666666-6666-4666-8666-666666666666", threadType: "team" });
    assert.deepEqual(steps([team], false).get(AGENT), { label: "Running terminal", sec: 59 }, "a team run on a token without thoughts: label, no text");
    assert.ok(Array.from(PRIVATE_ACTIVITY).length <= STEP_LABEL_MAX, "the private label fits the device");

    const notice = [ev(1, "notice", { summary: "Quoting the customer's private note" })];
    assert.deepEqual(steps([row(notice)], false).get(AGENT), { label: "Working", sec: 59 }, "notices never become a label");
    const reasoning = [ev(1, "reasoning", { summary: "The payroll numbers" })];
    assert.deepEqual(steps([otherMembersChat].map((r) => ({ ...r, events: reasoning }))).get(AGENT), { label: PRIVATE_ACTIVITY, sec: 59 });

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

test("a run whose newest event is older than 10 minutes gives no step and no thought (a crashed bridge's leftover)", () => {
    const old = (seq: number) => ({ ...ev(seq, "tool.start", { toolName: "terminal", summary: "npm test" }), ts: new Date(NOW - SCREEN_RUN_FRESH_MS - 1_000) });
    assert.equal(steps([row([old(1)])]).size, 0);
    assert.equal(screenThoughtsFromRuns([row([old(1)])], { nowMs: NOW, includePairThreads: true }).size, 0);
    const fresh = { ...old(2), ts: new Date(NOW - 5_000) };
    assert.equal(steps([row([old(1), fresh])]).get(AGENT)?.label, "Running terminal", "one recent event keeps the run live");
});

test("the step's identity rides along for the ETag only: a new step with the same label changes it", () => {
    const first = steps([row([ev(1, "tool.start", { toolName: "terminal", summary: "npm test" })])]).get(AGENT)!;
    const next = steps([row([ev(1, "tool.start", { toolName: "terminal", summary: "npm test" }), ev(2, "tool.start", { toolName: "terminal", summary: "npm test" })])]).get(AGENT)!;
    assert.ok(first.key && next.key && first.key !== next.key);
    assert.ok(!JSON.stringify(first).includes("key"), "never serialized to the device");
    const a = heavyFeed();
    const b = heavyFeed();
    Object.defineProperty(a.agents[0].step!, "key", { value: "run:1", enumerable: false });
    Object.defineProperty(b.agents[0].step!, "key", { value: "run:1", enumerable: false });
    b.agents[0].step!.sec = 0;
    assert.equal(liveFeedEtag(a), liveFeedEtag(b), "the ticking sec is ignored");
    b.agents[0].step = Object.defineProperty({ ...b.agents[0].step! }, "key", { value: "run:2", enumerable: false });
    assert.notEqual(liveFeedEtag(a), liveFeedEtag(b), "same label and text, new step: new ETag");
});

test("only the 6 most recent step texts and last-done titles are sent; every label stays", () => {
    const feed = heavyFeed();
    capScreenExtras(feed.agents);
    const texts = feed.agents.filter((a) => a.step?.text);
    assert.equal(texts.length, LIVE_MAX_STEP_TEXTS);
    assert.deepEqual(texts.map((a) => a.step!.sec), [0, 1, 2, 3, 4, 5], "the freshest steps keep their text");
    assert.ok(feed.agents.every((a) => a.step?.label));
    const lasts = feed.agents.filter((a) => a.last);
    assert.equal(lasts.length, LIVE_MAX_LASTS);
    assert.deepEqual(lasts.map((a) => a.last!.ageSec), [1000, 1001, 1002, 1003, 1004, 1005]);
});

test("last-done titles are redacted", () => {
    const last = lastDoneOf({ title: "Rotate key sk-abcdefghijklmnopqrstuvwxyz0123456789", taskType: "ops", doneAt: new Date(NOW) }, NOW)!;
    assert.ok(!last.title.includes("sk-abcdefghijklmnopqrstuvwxyz0123456789"), last.title);
    assert.ok(last.title.startsWith("Rotate key"));
});
