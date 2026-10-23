import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
    RUN_ACTIVITY_MAX_CHARS,
    RUN_EVENTS_BATCH_MAX,
    RUN_EVENTS_LATE_ACCEPT_MS,
    RUN_EVENT_SUMMARY_MAX_CHARS,
    RUN_LIVE_MAX_STEPS,
    applyRunEventCap,
    gateTypingEffect,
    buildRunLive,
    deriveActivityLine,
    parseEventsSince,
    runEventBatchSchema,
    runEventsAcceptance,
    sanitizeRunEvent,
    sanitizeRunEventData,
    typingEffectFor,
    type RunEventSource,
} from "../../src/lib/run-events";
import { finishRunSchema } from "../../src/lib/run-ledger";
import {
    COALESCED_REPLIES_CAPABILITY,
    RUN_EVENTS_CAPABILITY,
    RUN_USAGE_CAPABILITY,
    SERVER_CAPABILITIES,
} from "../../src/lib/rich-reply-guide";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";

function wire(seq: number, kind: string, extra: Record<string, unknown> = {}) {
    return { id: randomUUID(), seq, ts: new Date().toISOString(), kind, ...extra };
}

function source(seq: number, kind: string, extra: Partial<RunEventSource> = {}): RunEventSource {
    return {
        seq, kind, ts: new Date(1_000_000 + seq * 1_000),
        toolName: null, toolCallId: null, status: null, durationMs: null, summary: null, data: null,
        ...extra,
    };
}

test("the server advertises the 0.9 capabilities", () => {
    assert.equal(RUN_EVENTS_CAPABILITY, "run-events: 1");
    assert.equal(RUN_USAGE_CAPABILITY, "run-usage: 2");
    assert.equal(COALESCED_REPLIES_CAPABILITY, "coalesced-replies: 1");
    for (const cap of [RUN_EVENTS_CAPABILITY, RUN_USAGE_CAPABILITY, COALESCED_REPLIES_CAPABILITY, "runs: 1", "lean-context: 1"]) {
        assert.ok((SERVER_CAPABILITIES as readonly string[]).includes(cap), cap);
    }
});

test("batch schema strips unknown fields, rejects unknown kinds and oversize batches", () => {
    const ok = runEventBatchSchema.safeParse({
        run: { id: RUN_ID, agentId: AGENT_ID, runtimeKind: "hermes", futureField: 1 },
        events: [wire(1, "tool.start", { toolName: "terminal", newField: "x", data: { target: "npm test" } })],
        extra: true,
    });
    assert.ok(ok.success);
    assert.equal((ok.data.events[0] as Record<string, unknown>).newField, undefined);
    assert.equal((ok.data as Record<string, unknown>).extra, undefined);

    assert.equal(runEventBatchSchema.safeParse({ events: [wire(1, "message.delta")] }).success, false);
    assert.equal(runEventBatchSchema.safeParse({ events: [wire(-1, "usage")] }).success, false);
    const tooMany = Array.from({ length: RUN_EVENTS_BATCH_MAX + 1 }, (_, i) => wire(i, "usage"));
    assert.equal(runEventBatchSchema.safeParse({ events: tooMany }).success, false);
});

test("sanitizing redacts and caps summary and data, and clamps the timestamp", () => {
    const now = new Date("2026-10-22T10:00:00Z");
    const event = sanitizeRunEvent({
        id: RUN_ID, seq: 3, ts: "1999-01-01T00:00:00Z", kind: "tool.end",
        toolName: ` ${"t".repeat(300)} `,
        summary: `token sk-ant-api03-${"a".repeat(40)} ${"x".repeat(2_000)}`,
        data: { target: `Bearer ${"b".repeat(40)}` },
    }, now);
    assert.equal(event.ts.getTime(), now.getTime(), "out-of-range ts falls back to now");
    assert.ok(Array.from(event.summary!).length <= RUN_EVENT_SUMMARY_MAX_CHARS);
    assert.ok(!event.summary!.includes("sk-ant-api03"));
    assert.ok(event.toolName!.length <= 100);
    assert.ok(!JSON.stringify(event.data).includes("b".repeat(40)));

    assert.equal(sanitizeRunEventData({}), null);
    assert.deepEqual(sanitizeRunEventData({ blob: "y".repeat(5_000) }), { truncated: true });
});

test("the cap keeps terminal events, then important kinds, dropping reasoning/progress/usage/notice first", () => {
    const events = [
        { seq: 1, kind: "reasoning" },
        { seq: 2, kind: "tool.start" },
        { seq: 3, kind: "notice" },
        { seq: 4, kind: "tool.end" },
        { seq: 5, kind: "turn.completed" },
    ];
    assert.deepEqual(applyRunEventCap(0, events, 10), { kept: events, dropped: 0 });

    const capped = applyRunEventCap(7, events, 10); // room for 3
    assert.deepEqual(capped.kept.map((e) => e.seq), [2, 4, 5]);
    assert.equal(capped.dropped, 2);

    const full = applyRunEventCap(10, events, 10);
    assert.deepEqual(full.kept.map((e) => e.kind), ["turn.completed"], "a terminal event survives a full run");
    assert.equal(full.dropped, 4);
});

test("deriveActivityLine renders each kind as one short line", () => {
    assert.equal(deriveActivityLine(source(1, "tool.start", { toolName: "terminal", data: { target: "npm test" } })), "Running terminal · npm test");
    assert.equal(deriveActivityLine(source(1, "tool.progress", { toolName: "web", data: { percent: 41.6 } })), "Running web · 42%");
    assert.equal(deriveActivityLine(source(1, "tool.end", { toolName: "terminal", status: "error" })), "terminal failed");
    assert.equal(deriveActivityLine(source(1, "tool.end", { toolName: "terminal", status: "ok" })), "Finished terminal");
    assert.equal(deriveActivityLine(source(1, "tool.start", { toolName: "read_file", summary: "hostname" })), "Running read_file · hostname");
    assert.equal(deriveActivityLine(source(1, "tool.prepare", { toolName: "read_file" })), "Preparing read_file");
    assert.equal(deriveActivityLine(source(1, "reasoning", { summary: "Checking the tests" })), "Thinking…");
    assert.equal(deriveActivityLine(source(1, "notice", { summary: "Retrying model call" })), "Retrying model call");
    assert.equal(deriveActivityLine(source(1, "notice")), null);
    assert.equal(deriveActivityLine(source(1, "status", { data: { kind: "compacting" } })), "Tidying memory…");
    assert.equal(deriveActivityLine(source(1, "turn.queued", { data: { position: 2 } })), "Queued · position 2");
    assert.equal(deriveActivityLine(source(1, "usage", { data: { input: 5 } })), null);
    assert.equal(deriveActivityLine(source(1, "turn.completed")), null);
    const long = deriveActivityLine(source(1, "tool.start", { toolName: "terminal", data: { target: "z".repeat(500) } }));
    assert.ok(long && Array.from(long).length <= RUN_ACTIVITY_MAX_CHARS);
});

test("typing effect follows the newest meaningful event", () => {
    assert.deepEqual(typingEffectFor([source(1, "tool.start", { toolName: "web" }), source(2, "usage")], "running"),
        { action: "set", activity: "Running web" });
    assert.deepEqual(typingEffectFor([source(1, "tool.end", { toolName: "web" }), source(2, "turn.completed")], "running"),
        { action: "clear" });
    assert.deepEqual(typingEffectFor([source(9, "compaction.end")], "succeeded"), { action: "clear" });
    assert.equal(typingEffectFor([source(1, "usage")], "running"), null);
});

test("finished runs accept late events for 10 minutes, then are gone; lost runs stay open", () => {
    const now = new Date("2026-10-22T10:00:00Z");
    assert.equal(runEventsAcceptance({ status: "running", endedAt: null }, now), "accept");
    assert.equal(runEventsAcceptance({ status: "succeeded", endedAt: new Date(now.getTime() - 60_000) }, now), "accept");
    assert.equal(runEventsAcceptance({ status: "failed", endedAt: new Date(now.getTime() - RUN_EVENTS_LATE_ACCEPT_MS - 1) }, now), "gone");
    assert.equal(runEventsAcceptance({ status: "lost", endedAt: new Date(now.getTime() - 3 * 3_600_000) }, now), "accept");
});

test("buildRunLive exposes current, the last steps and live usage", () => {
    const run = {
        id: RUN_ID, agentId: AGENT_ID, triggerMessageId: null, status: "running",
        startedAt: new Date(1_000_000), endedAt: null,
    };
    const events: RunEventSource[] = [source(0, "turn.started")];
    for (let i = 1; i <= 12; i++) events.push(source(i, i % 2 ? "tool.start" : "tool.end", { toolName: `t${i}`, status: i % 2 ? "running" : "ok" }));
    events.push(source(13, "usage", { data: { input: 1200, output: 80, cacheRead: 900, contextUsed: 30_000, contextMax: 120_000, contextPercent: 25.2, model: "deepseek" } }));
    events.push(source(14, "reasoning", { summary: "Next I will run the build" }));

    const live = buildRunLive(run, events.reverse(), new Date(1_000_000 + 16_000));
    assert.equal(live.steps.length, RUN_LIVE_MAX_STEPS);
    assert.equal(live.steps.at(-1)?.kind, "reasoning");
    assert.ok(live.steps.every((step, i, all) => i === 0 || all[i - 1].seq < step.seq));
    assert.equal(live.current.kind, "reasoning");
    assert.equal(live.current.summary, "Thinking…");
    assert.equal(live.current.sinceMs, 2_000);
    assert.deepEqual(live.usage, { input: 1200, output: 80, cacheRead: 900, contextPercent: 25 });
    assert.equal(live.startedAt, new Date(1_000_000).toISOString());
    assert.equal(live.endedAt, undefined);

    const empty = buildRunLive(run, [], new Date(1_005_000));
    assert.deepEqual(empty.current, { kind: "turn.started", summary: "Working", sinceMs: 5_000 });
    assert.deepEqual(empty.steps, []);
});

test("parseEventsSince keeps valid runId:seq pairs", () => {
    const parsed = parseEventsSince(`${RUN_ID}:7,bad,${AGENT_ID}:x,${RUN_ID}:3`);
    assert.deepEqual([...parsed], [[RUN_ID, 7]]);
    assert.equal(parseEventsSince(null).size, 0);
});

test("finish accepts run-usage v2 fields and bounds them", () => {
    const ok = finishRunSchema.safeParse({
        status: "succeeded", cacheReadTokens: 10, cacheWriteTokens: 2, reasoningTokens: 3, apiCalls: 4,
        model: "deepseek-v4", provider: "deepseek", exitReason: "text_response(finish_reason=stop)", queueMs: 12, firstTokenMs: 1840, compactions: 1, eventsDropped: 0,
    });
    assert.ok(ok.success);
    assert.equal(finishRunSchema.safeParse({ status: "succeeded", model: "m".repeat(101) }).success, false);
    assert.equal(finishRunSchema.safeParse({ status: "succeeded", apiCalls: -1 }).success, false);
    assert.equal(finishRunSchema.safeParse({ status: "succeeded", exitReason: "x".repeat(121) }).success, false);
});

test("a finished run may only clear typing", () => {
    assert.deepEqual(gateTypingEffect({ action: "set", activity: "x" }, "running"), { action: "set", activity: "x" });
    assert.equal(gateTypingEffect({ action: "set", activity: "x" }, "succeeded"), null);
    assert.deepEqual(gateTypingEffect({ action: "clear" }, "failed"), { action: "clear" });
    assert.equal(gateTypingEffect(null, "running"), null);
});
