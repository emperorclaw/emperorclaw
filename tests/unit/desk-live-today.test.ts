import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunEventSource } from "../../src/lib/run-events";
import { humanStep, prettyToolName, toolVerb } from "../../src/lib/step-phrases";
import { PRIVATE_ACTIVITY, screenStepsFromRuns, type RunThoughtRow } from "../../src/lib/run-thoughts";
import { liveFeedEtag, localMidnight, scopeLiveFeed, shapeToday, type LiveFeed, type TodayRow } from "../../src/lib/live-feed";

/**
 * Desk display 2.2: steps narrated like a person ("Using terminal: npm test")
 * and the TODAY screen's usage.
 */

test("tool steps read as what the agent is doing, never adding words the step did not carry", () => {
    assert.deepEqual(humanStep("Running terminal", "npm test"), { label: "Using terminal", text: "npm test" });
    assert.deepEqual(humanStep("Running web_search", "desk lamps"), { label: "Searching the web", text: "desk lamps" });
    assert.deepEqual(humanStep("Running browser_navigate", "example.com"), { label: "Browsing the web", text: "example.com" });
    assert.deepEqual(humanStep("Running read_file", "src/app.ts"), { label: "Reading", text: "src/app.ts" });
    assert.deepEqual(humanStep("Running write_file", "src/app.ts"), { label: "Editing", text: "src/app.ts" });
    assert.deepEqual(humanStep("Running mcp__github__create_issue"), { label: "Using github create issue" });
    assert.deepEqual(humanStep("Preparing terminal"), { label: "Getting terminal ready" });
    assert.deepEqual(humanStep("terminal done"), { label: "Done with terminal" });
    assert.deepEqual(humanStep("web_search failed"), { label: "Web search failed" });
    assert.deepEqual(humanStep("Thinking", "Comparing both quotes"), { label: "Thinking", text: "Comparing both quotes" });
    assert.deepEqual(humanStep("Writing the reply"), { label: "Writing the reply" });
    assert.deepEqual(humanStep("Delegating", "Bob"), { label: "Delegating to Bob" });
    assert.deepEqual(humanStep("Delegating"), { label: "Delegating" });
    assert.deepEqual(humanStep(PRIVATE_ACTIVITY), { label: PRIVATE_ACTIVITY });
    assert.equal(prettyToolName("functions.web_fetch"), "web fetch");
    // Whole words only: a tool that merely contains a family's letters keeps its own name.
    assert.equal(toolVerb("example_x"), "Using example x");
    assert.equal(toolVerb("catalog"), "Using catalog");
    assert.equal(toolVerb("lsp_hover"), "Using lsp hover");
    assert.equal(toolVerb("process_invoice"), "Using process invoice");
    assert.equal(toolVerb("org_lookup"), "Using org lookup");
    assert.equal(toolVerb("explain_plan"), "Using explain plan");
    assert.equal(toolVerb("ls"), "Reading");
    assert.equal(toolVerb("Bash"), "Using terminal");
    assert.equal(toolVerb("mcp__brave__brave_search"), "Searching the web");
    assert.equal(toolVerb(""), "Using a tool");
    assert.ok(humanStep(`Running ${"very_long_tool_name_".repeat(4)}`).label.length <= 26);
});

const NOW = 2_000_000_000_000;
const AGENT = "22222222-2222-4222-8222-222222222222";
const ev = (seq: number, kind: string, extra: Partial<RunEventSource> = {}): RunEventSource => ({
    seq, kind, ts: new Date(NOW - 5_000), toolName: null, toolCallId: null, status: null, durationMs: null, summary: null, data: null, ...extra,
});
const row = (events: RunEventSource[], extra: Partial<RunThoughtRow> = {}): RunThoughtRow => ({
    runId: "11111111-1111-4111-8111-111111111111", agentId: AGENT, threadId: null, threadType: null,
    pairThread: false, viewerInThread: false, viewerOwnsThread: false, startedAtMs: NOW - 60_000, events, ...extra,
});

test("'Writing the reply' reaches every screen as a label; a free-text status never does", () => {
    const writing = [ev(1, "status", { data: { kind: "writing" } })];
    for (const allowText of [true, false]) {
        assert.deepEqual(screenStepsFromRuns([row(writing)], { nowMs: NOW, includePairThreads: true, allowText }).get(AGENT), { label: "Writing the reply", sec: 5 });
    }
    const status = [ev(1, "status", { summary: "Quoting the customer" })];
    assert.equal(screenStepsFromRuns([row(status)], { nowMs: NOW, includePairThreads: true, allowText: false }).get(AGENT)?.label, "Working");
    const privateRun = row(writing, { threadId: "33333333-3333-4333-8333-333333333333", threadType: "direct" });
    assert.equal(screenStepsFromRuns([privateRun], { nowMs: NOW, includePairThreads: true, allowText: true }).get(AGENT)?.label, PRIVATE_ACTIVITY);
    const tool = [ev(1, "tool.start", { toolName: "terminal", summary: "npm test" })];
    assert.deepEqual(screenStepsFromRuns([row(tool)], { nowMs: NOW, includePairThreads: true, allowText: true }).get(AGENT), { label: "Using terminal", text: "npm test", sec: 5 });
});

const rows: TodayRow[] = [
    { agentId: "a", runs: 10, tokens: 120_400, cost: 512, costed: 10, done: 2 },
    { agentId: "b", runs: 4, tokens: 9_600, cost: 731, costed: 3, done: 0 },
    { agentId: "c", runs: 2, tokens: 500, cost: 0, costed: 0, done: 1 },
    { agentId: "d", runs: 1, tokens: 100, cost: 40, costed: 1, done: 0 },
    { agentId: "e", runs: 1, tokens: 100, cost: 90, costed: 1, done: 0 },
];

test("today sums the shown agents only, rounds tokens to thousands and ranks the top 3 by cost", () => {
    const today = shapeToday(rows, new Set(["a", "b", "c", "d", "e"]));
    assert.deepEqual(today, {
        cost: 1373, runs: 18, tokensK: 131, done: 3,
        top: [{ agentId: "b", cost: 731, runs: 4 }, { agentId: "a", cost: 512, runs: 10 }, { agentId: "e", cost: 90, runs: 1 }, { agentId: "d", cost: 40, runs: 1 }],
        others: { n: 0, cost: 0, runs: 0 },
    }, "c reported no cost, so it is no slice of a cost chart");
    assert.ok(!JSON.stringify(today).includes("rows"), "the per-agent rows are never serialized");
    assert.deepEqual(shapeToday(rows, new Set(["c"])), { cost: null, runs: 2, tokensK: 1, done: 1, top: [{ agentId: "c", cost: 0, runs: 2 }], others: { n: 0, cost: 0, runs: 0 } },
        "no cost reported: null, never 0, and the slices go by runs");
    assert.deepEqual(shapeToday([], new Set()), { cost: null, runs: 0, tokensK: 0, done: 0, top: [], others: { n: 0, cost: 0, runs: 0 } });
});

test("a scoped viewer's today counts only its agents", () => {
    const feed = {
        v: 2, ts: new Date(NOW).toISOString(), company: { name: "Co" },
        summary: { agents: 2, healthy: 2, attention: 0, down: 0, idle: 0, working: 0, pendingApprovals: 0, tasksInProgress: 0, tasksOverdue: 0 },
        agents: ["a", "b"].map((id) => ({ id, name: id, short: id, hue: 0, health: "healthy", state: "idle", activity: null, task: null, lastSeenSec: 1, unanswered: 0 })),
        messages: [], dm: [], events: [], needs: [], today: shapeToday(rows, new Set(["a", "b"])),
    } as unknown as LiveFeed;
    const scoped = scopeLiveFeed(feed, ["a"]);
    assert.deepEqual(scoped.today, { cost: 512, runs: 10, tokensK: 120, done: 2, top: [{ agentId: "a", cost: 512, runs: 10 }], others: { n: 0, cost: 0, runs: 0 } });
    assert.notEqual(liveFeedEtag(scoped), liveFeedEtag(feed));
    assert.deepEqual(scopeLiveFeed(scoped, ["b"]).today, { cost: null, runs: 0, tokensK: 0, done: 0, top: [], others: { n: 0, cost: 0, runs: 0 } });
});

test("today starts at midnight in the company's timezone, else UTC", () => {
    const now = new Date("2026-11-04T03:30:00Z");
    assert.equal(localMidnight(now, null).toISOString(), "2026-11-04T00:00:00.000Z");
    assert.equal(localMidnight(now, "America/New_York").toISOString(), "2026-11-03T05:00:00.000Z", "22:30 the day before in New York (EST)");
    assert.equal(localMidnight(now, "Europe/Bratislava").toISOString(), "2026-11-03T23:00:00.000Z");
    assert.equal(localMidnight(new Date("2026-07-01T12:00:00Z"), "Europe/Bratislava").toISOString(), "2026-06-30T22:00:00.000Z", "summer time");
    assert.equal(localMidnight(new Date("2026-03-29T12:00:00Z"), "Europe/Bratislava").toISOString(), "2026-03-28T23:00:00.000Z", "the day summer time starts");
    assert.equal(localMidnight(now, "Not/AZone").toISOString(), "2026-11-04T00:00:00.000Z", "an invalid zone falls back to UTC");
});

test("the chart keeps the top 5 agents and groups the rest as others, so the slices add up to the total", () => {
    const many: TodayRow[] = Array.from({ length: 8 }, (_, i) => ({ agentId: `agent-${i}`, runs: i + 1, tokens: 1000, cost: (i + 1) * 100, costed: 1, done: 0 }));
    const ids = new Set(many.map((r) => r.agentId));
    const today = shapeToday(many, ids);
    assert.deepEqual(today.top.map((s) => s.agentId), ["agent-7", "agent-6", "agent-5", "agent-4", "agent-3"]);
    assert.deepEqual(today.others, { n: 3, cost: 100 + 200 + 300, runs: 1 + 2 + 3 });
    assert.equal(today.top.reduce((acc, s) => acc + s.cost, 0) + today.others.cost, today.cost);

    // No run reported a cost: the chart goes by runs, cost stays null.
    const runsOnly = many.map((r) => ({ ...r, cost: 0, costed: 0 }));
    const byRuns = shapeToday(runsOnly, ids);
    assert.equal(byRuns.cost, null);
    assert.deepEqual(byRuns.top.map((s) => [s.agentId, s.cost, s.runs]), [["agent-7", 0, 8], ["agent-6", 0, 7], ["agent-5", 0, 6], ["agent-4", 0, 5], ["agent-3", 0, 4]]);
    assert.deepEqual(byRuns.others, { n: 3, cost: 0, runs: 6 });
    assert.equal(byRuns.top.reduce((acc, s) => acc + s.runs, 0) + byRuns.others.runs, byRuns.runs);

    // A narrower viewer gets its own slices and others.
    const scoped = shapeToday(many, new Set(["agent-0", "agent-1"]));
    assert.deepEqual(scoped.top.map((s) => s.agentId), ["agent-1", "agent-0"]);
    assert.deepEqual(scoped.others, { n: 0, cost: 0, runs: 0 });
});
