import { test } from "node:test";
import assert from "node:assert/strict";
import {
    RUN_THOUGHT_MAX_CHARS,
    buildRunLive,
    deriveActivityLine,
    publicActivityLine,
    reasoningHeadline,
    type RunEventSource,
} from "../../src/lib/run-events";
import { lastReasoningLine, stepHeadline } from "../../src/lib/live-activity";
import { dashboardLiveFromRows, runThoughtsFromRows, runThoughtVisible, type RunThoughtRow } from "../../src/lib/dashboard-live";
import { holdThoughts } from "../../src/lib/live-office";
import type { ReasoningRow } from "../../src/lib/live-feed-v2";
import type { SceneThought } from "../../src/lib/team-scene";

/**
 * The live "what is the agent doing" line: one derivation (run-events) shared
 * by direct chat, team chat, the Agents page and the dashboard bubbles.
 */

const RUN = { id: "11111111-1111-4111-8111-111111111111", agentId: "22222222-2222-4222-8222-222222222222", triggerMessageId: null, status: "running", startedAt: new Date(1_000_000), endedAt: null };

function ev(seq: number, kind: string, extra: Partial<RunEventSource> = {}): RunEventSource {
    return {
        seq, kind, ts: new Date(1_000_000 + seq * 1_000),
        toolName: null, toolCallId: null, status: null, durationMs: null, summary: null, data: null,
        ...extra,
    };
}

const at = (seq: number) => new Date(1_000_000 + seq * 1_000 + 500);

test("reasoning shows the first sentence of its summary", () => {
    assert.equal(deriveActivityLine(ev(1, "reasoning", { summary: "The build fails on Windows paths. I will normalize them first." })),
        "Thinking · The build fails on Windows paths.");
    assert.equal(deriveActivityLine(ev(1, "reasoning", { summary: "\n\n  Reading config.ts and v0.9 notes\nsecond line" })),
        "Thinking · Reading config.ts and v0.9 notes", "first non-empty line; dots inside words do not cut");
    assert.equal(deriveActivityLine(ev(1, "reasoning", { summary: "Ok. Then the rest of the plan follows" })),
        "Thinking · Ok. Then the rest of the plan follows", "a too-short first sentence keeps the whole line");
    const long = deriveActivityLine(ev(1, "reasoning", { summary: "word ".repeat(80) }));
    assert.ok(long?.startsWith("Thinking · word"));
    assert.ok(long!.endsWith("…"));
    assert.ok(Array.from(long!.slice("Thinking · ".length)).length <= RUN_THOUGHT_MAX_CHARS);
    assert.equal(reasoningHeadline("   \n "), null);
});

test("reasoning without a summary reads Thinking…", () => {
    assert.equal(deriveActivityLine(ev(1, "reasoning")), "Thinking…");
    assert.equal(deriveActivityLine(ev(1, "reasoning", { summary: "  " })), "Thinking…");
});

test("tool, tool end and reply-writing lines", () => {
    assert.equal(deriveActivityLine(ev(1, "tool.start", { toolName: "write_file", summary: "src/app.ts" })), "Running write_file · src/app.ts");
    assert.equal(deriveActivityLine(ev(1, "tool.end", { toolName: "write_file", status: "ok" })), "write_file done");
    assert.equal(deriveActivityLine(ev(1, "tool.end", { toolName: "write_file", status: "error" })), "write_file failed");
    assert.equal(deriveActivityLine(ev(1, "status", { data: { kind: "writing" } })), "Writing the reply…");
    assert.equal(deriveActivityLine(ev(1, "status", { data: { kind: "streaming" }, summary: "ignored" })), "Writing the reply…");
});

test("current falls back to the last summarized thought of the same stretch, then to Thinking…", () => {
    const thought = buildRunLive(RUN, [ev(1, "reasoning", { summary: "Comparing both quotes" }), ev(2, "usage", { data: { input: 3 } }), ev(3, "reasoning")], at(3));
    assert.equal(thought.current.summary, "Thinking · Comparing both quotes");
    assert.equal(thought.current.sinceMs, 500, "the timer follows the newest beat");
    assert.equal(lastReasoningLine(thought), null, "the detail line never repeats the current thought");

    const afterTool = buildRunLive(RUN, [ev(1, "reasoning", { summary: "Old plan" }), ev(2, "tool.end", { toolName: "web", status: "ok" }), ev(3, "reasoning")], at(3));
    assert.equal(afterTool.current.summary, "Thinking…", "a thought from before another step is stale");

    const tool = buildRunLive(RUN, [ev(1, "reasoning", { summary: "Run the tests next" }), ev(2, "tool.start", { toolName: "terminal", summary: "npm test" })], at(2));
    assert.equal(tool.current.summary, "Running terminal · npm test");
    assert.equal(lastReasoningLine(tool), "Thinking · Run the tests next");
});

test("the public label keeps only the step and the tool name", () => {
    assert.equal(publicActivityLine(ev(1, "reasoning", { summary: "secret plan" })), "Thinking…");
    assert.equal(publicActivityLine(ev(1, "tool.start", { toolName: "terminal", summary: "cat salary.csv" })), "Running terminal");
    assert.equal(publicActivityLine(ev(1, "tool.end", { toolName: "terminal", status: "error" })), "terminal failed");
    assert.equal(publicActivityLine(ev(1, "notice", { summary: "quoting the customer" })), "Working");
    assert.equal(publicActivityLine(ev(1, "status", { summary: "drafting the private reply" })), "Working");
});

test("the screen reader headline changes per step, not per thought", () => {
    assert.equal(stepHeadline("Thinking · Comparing both quotes"), "Thinking");
    assert.equal(stepHeadline("Thinking…"), "Thinking");
    assert.equal(stepHeadline("Running terminal · npm test"), "Running terminal");
    assert.equal(stepHeadline("Writing the reply…"), "Writing the reply");
    assert.equal(stepHeadline(null), null);
});

// ─── Dashboard bubbles ──────────────────────────────────────────────────────

function runRow(agentId: string, threadType: string | null, events: RunEventSource[], extra: Partial<RunThoughtRow> = {}): RunThoughtRow {
    return {
        runId: `run-${agentId}`, agentId, threadId: threadType ? `thread-${agentId}` : null, threadType,
        pairThread: false, viewerInThread: false, startedAtMs: 900_000, events, ...extra,
    };
}

const NOW = 1_000_000 + 10_000;

test("a private run shows only the generic step label on the dashboard", () => {
    const thinking = [ev(1, "reasoning", { summary: "The owner's salary question needs care" })];
    const tool = [ev(1, "tool.start", { toolName: "terminal", summary: "cat payroll.csv" })];
    const out = runThoughtsFromRows([
        runRow("direct-outsider", "direct", thinking),
        runRow("direct-tool", "direct", tool),
        runRow("direct-mine", "direct", thinking, { viewerInThread: true }),
        runRow("team", "team", tool),
        runRow("pair", "group", thinking, { pairThread: true }),
        runRow("task", null, tool),
        runRow("quiet", "team", []),
    ], { nowMs: NOW, includePairThreads: false });

    assert.deepEqual(out.get("direct-outsider"), { memberKey: "agent:direct-outsider", label: "Thinking…", text: "", at: new Date(1_001_000).toISOString() });
    assert.deepEqual({ label: out.get("direct-tool")?.label, text: out.get("direct-tool")?.text }, { label: "Running terminal", text: "" });
    assert.deepEqual({ label: out.get("direct-mine")?.label, text: out.get("direct-mine")?.text }, { label: "Thinking", text: "The owner's salary question needs care" });
    assert.deepEqual({ label: out.get("team")?.label, text: out.get("team")?.text }, { label: "Running terminal", text: "cat payroll.csv" });
    assert.equal(out.get("pair")?.label, "Thinking…", "pair threads are private for non-admins");
    assert.equal(out.get("task")?.text, "cat payroll.csv", "task runs without a thread are visible, as on the Agents page");
    assert.equal(out.has("quiet"), false, "no events: leave room for a legacy thought");

    const admin = runThoughtsFromRows([runRow("pair", "group", thinking, { pairThread: true })], { nowMs: NOW, includePairThreads: true });
    assert.equal(admin.get("pair")?.text, "The owner's salary question needs care");
    assert.equal(runThoughtVisible({ threadId: "t", threadType: null, pairThread: false, viewerInThread: false }, true), false, "an archived or foreign thread is private");
});

test("live run steps win over legacy reasoning; legacy remains the fallback", () => {
    const reasoning = (agentId: string, text: string): ReasoningRow => ({ agentId, messageId: `m-${agentId}`, threadType: "team", createdAtMs: NOW - 5_000, reasoning: text, truncatedHead: false });
    const live = dashboardLiveFromRows({
        reasoning: [reasoning("ada", "Old bridge thinking about supplier quotes"), reasoning("bob", "Old bridge thinking about the deploy plan")],
        runThoughts: [runRow("ada", "team", [ev(1, "tool.start", { toolName: "web", summary: "supplier.com" })]), runRow("stranger", "team", [ev(1, "reasoning")])],
        handoffs: [], transitions: [], approvals: [],
        agents: [{ id: "ada", name: "Ada" }, { id: "bob", name: "Bob" }],
        nowMs: NOW,
    });
    const byKey = new Map(live.thoughts.map((t) => [t.memberKey, t]));
    assert.equal(byKey.get("agent:ada")?.label, "Running web");
    assert.equal(byKey.get("agent:ada")?.text, "supplier.com");
    assert.equal(byKey.get("agent:bob")?.text, "Old bridge thinking about the deploy plan");
    assert.equal(byKey.get("agent:bob")?.label, undefined);
    assert.equal(byKey.has("agent:stranger"), false, "agents off the roster never get a bubble");
});

test("held thoughts stay until a newer one arrives and leave with the work", () => {
    const t = (key: string, text: string, sec: number): SceneThought => ({ memberKey: key, text, at: new Date(sec * 1000).toISOString() });
    const working = new Set(["a", "b"]);
    const first = holdThoughts(new Map(), [t("a", "one", 10), t("b", "two", 10)], working);
    assert.equal(first.size, 2);
    assert.equal(holdThoughts(first, [], working), first, "a refresh without thoughts changes nothing");
    assert.equal(holdThoughts(first, [t("a", "older", 5)], working), first, "an older reading never replaces a newer one");
    assert.equal(holdThoughts(first, [t("a", "newer", 12)], working).get("a")?.text, "newer");
    const after = holdThoughts(first, [], new Set(["b"]));
    assert.equal(after.has("a"), false, "a member that stopped working drops its bubble");
});
