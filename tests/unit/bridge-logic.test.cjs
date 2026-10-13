/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    classifyMessage,
    loopGuardOk,
    estimateUsageTokens,
    stripCodexNoise,
    replyFormatGuide,
    organizationContext,
    RUNS_CAPABILITY,
    parseServerCapabilities,
    serverSupportsRuns,
    mapRunFinishStatus,
    mapExitToRunStatus,
    isRetryableLedgerError,
    createLedgerBreaker,
    LEDGER_BREAKER_THRESHOLD,
    LEDGER_BREAKER_COOLDOWN_MS,
    buildRunStartPayload,
    buildRunFinishPayload,
} = require("../../integrations/codex/bridge-logic");

const CTX = { agentId: "agent-1", agentName: "Ada" };

test("classifyMessage: responds to a direct human message addressed to this agent", () => {
    const d = classifyMessage({ senderType: "human", targetAgentId: "agent-1", text: "hello" }, CTX);
    assert.equal(d.action, "respond");
    assert.equal(d.resetLoop, true);
});

test("classifyMessage: an agent message without a server verdict fails closed", () => {
    const d = classifyMessage({ senderType: "agent", targetAgentId: "agent-1", text: "hi" }, CTX);
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "agent-no-verdict");
    assert.equal(d.resetLoop, false);
});

test("classifyMessage: skips empty/whitespace messages", () => {
    assert.equal(classifyMessage({ senderType: "human", text: "   " }, CTX).action, "skip");
    assert.equal(classifyMessage({ senderType: "human", text: "" }, CTX).reason, "empty");
});

test("classifyMessage: skips a direct message addressed to a different agent", () => {
    const d = classifyMessage({ senderType: "human", targetAgentId: "agent-2", text: "hey" }, CTX);
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "other-target");
});

test("classifyMessage: team chat requires an @mention", () => {
    const noMention = classifyMessage({ senderType: "human", threadType: "team", text: "team, standup?" }, CTX);
    assert.equal(noMention.action, "skip");
    assert.equal(noMention.reason, "team-no-mention");

    const mention = classifyMessage({ senderType: "human", threadType: "team", text: "@Ada please help" }, CTX);
    assert.equal(mention.action, "respond");
});

test("classifyMessage: snake_case field fallbacks are honored", () => {
    const d = classifyMessage({ sender_type: "human", target_agent_id: "agent-1", thread_type: "direct", text: "yo" }, CTX);
    assert.equal(d.action, "respond");
});

test("loopGuardOk: allows 3 replies per thread then trips", () => {
    const counts = new Map();
    assert.equal(loopGuardOk(counts, "t1"), true);  // 1
    assert.equal(loopGuardOk(counts, "t1"), true);  // 2
    assert.equal(loopGuardOk(counts, "t1"), true);  // 3
    assert.equal(loopGuardOk(counts, "t1"), false); // 4 → tripped
    // A different thread has its own budget
    assert.equal(loopGuardOk(counts, "t2"), true);
});

test("estimateUsageTokens: ~4 chars per token, split input/output", () => {
    const u = estimateUsageTokens("12345678", "1234"); // 8 chars in, 4 chars out
    assert.deepEqual(u, { inputTokens: 2, outputTokens: 1 });
    assert.deepEqual(estimateUsageTokens("", ""), { inputTokens: 0, outputTokens: 0 });
});

test("stripCodexNoise: removes rollout lines, keeps real output", () => {
    const raw = "codex_core::rollout starting\nHello there\ncodex_core::rollout done\nSecond line";
    assert.equal(stripCodexNoise(raw), "Hello there\nSecond line");
});

// ── Mock-LLM reply cycle ────────────────────────────────────────────────
// Simulates handling one message end-to-end WITHOUT a real model: the LLM is a
// stub. Asserts the agent decides to reply, cleans output, and reports usage.
test("mock reply cycle: a valid message yields a cleaned reply + usage report", () => {
    const fakeLLM = (prompt) => `codex_core::rollout noise\nACK: ${prompt.includes("ping") ? "pong" : "?"}`;

    const msg = { senderType: "human", targetAgentId: "agent-1", text: "ping", threadId: "t9" };
    const decision = classifyMessage(msg, CTX);
    assert.equal(decision.action, "respond");

    const counts = new Map();
    assert.equal(loopGuardOk(counts, msg.threadId), true);

    const rawOutput = fakeLLM(msg.text);
    const reply = stripCodexNoise(rawOutput);
    assert.equal(reply, "ACK: pong");

    const usage = estimateUsageTokens(msg.text, reply);
    assert.ok(usage.inputTokens > 0 && usage.outputTokens > 0, "usage should be reported for a real reply");
});

test("replyFormatGuide: only a server advertising rich-blocks-v1 yields a guide", () => {
    assert.equal(replyFormatGuide({ runtimeNode: {} }, {}), "");
    assert.equal(replyFormatGuide(null, {}), "");
    assert.equal(replyFormatGuide({ serverCapabilities: ["other"], replyFormatGuide: "g" }, {}), "");
    assert.equal(replyFormatGuide({ serverCapabilities: ["rich-blocks-v1"], replyFormatGuide: " ## Rich " }, {}), "## Rich");
});

test("replyFormatGuide: EMPEROR_CLAW_RICH_REPLIES=off opts out", () => {
    const res = { serverCapabilities: ["rich-blocks-v1"], replyFormatGuide: "## Rich" };
    assert.equal(replyFormatGuide(res, { EMPEROR_CLAW_RICH_REPLIES: "off" }), "");
});

test("classifyMessage: a group chat needs an @mention, like team chat", () => {
    assert.equal(classifyMessage({ senderType: "human", threadType: "group", text: "status?" }, CTX).action, "skip");
    assert.equal(classifyMessage({ senderType: "human", threadType: "group", text: "@Ada status?" }, CTX).action, "respond");
    // An unknown thread type is never treated as a private thread.
    assert.equal(classifyMessage({ senderType: "human", threadType: "channel", text: "hi" }, CTX).action, "skip");
    // Direct threads keep answering without a mention.
    assert.equal(classifyMessage({ senderType: "human", threadType: "direct", targetAgentId: "agent-1", text: "hi" }, CTX).action, "respond");
});

test("classifyMessage: @all in a group addresses every member, only in groups", () => {
    assert.equal(classifyMessage({ senderType: "human", threadType: "group", text: "@all standup" }, CTX).action, "respond");
    assert.equal(classifyMessage({ senderType: "human", threadType: "team", text: "@all standup" }, CTX).action, "skip");
    assert.equal(classifyMessage({ senderType: "human", threadType: "group", text: "@allison standup" }, CTX).action, "skip");
    assert.equal(classifyMessage({ senderType: "agent", threadType: "group", text: "@all standup" }, CTX).action, "skip");
});

test("classifyMessage: obeys the server verdict for agents (mentions/handoffs) and humans", () => {
    // A sibling @mention in a team, addressed to this agent, is answered.
    assert.equal(classifyMessage({ senderType: "agent", senderId: "b", threadType: "team", text: "@Ada review", addressedToYou: true, routeReason: "mention" }, CTX).action, "respond");
    // Same in a group.
    assert.equal(classifyMessage({ senderType: "agent", senderId: "b", threadType: "group", text: "@Ada", addressedToYou: true, routeReason: "mention" }, CTX).action, "respond");
    // An explicit two-agent pair handoff is answered.
    assert.equal(classifyMessage({ senderType: "agent", senderId: "b", targetAgentId: "agent-1", threadType: "group", text: "handoff", addressedToYou: true, routeReason: "agent_pair" }, CTX).action, "respond");
    // An unnamed third member in the same room is not addressed.
    assert.equal(classifyMessage({ senderType: "agent", senderId: "b", threadType: "group", text: "@Other", addressedToYou: false, routeReason: "not_addressed" }, CTX).action, "skip");
    // A loop-paused sibling message arrives as addressedToYou:false.
    const paused = classifyMessage({ senderType: "agent", senderId: "b", threadType: "team", text: "@Ada again", addressedToYou: false, routeReason: "loop_paused" }, CTX);
    assert.equal(paused.action, "skip");
    assert.match(paused.reason, /loop_paused/);
    // Human behavior is unchanged.
    assert.equal(classifyMessage({ senderType: "human", threadType: "team", text: "status?", addressedToYou: true, routeReason: "targeted" }, CTX).action, "respond");
    assert.equal(classifyMessage({ senderType: "human", threadType: "team", text: "@Ada hi", addressedToYou: false, routeReason: "not_addressed" }, CTX).action, "skip");
});

test("classifyMessage: an agent never answers its own message even if addressed", () => {
    const d = classifyMessage({ senderType: "agent", senderId: "agent-1", threadType: "team", text: "note", addressedToYou: true }, CTX);
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "self");
});

test("classifyMessage: a legacy server fails agent messages closed (no agent @all fan-out)", () => {
    assert.equal(classifyMessage({ senderType: "agent", threadType: "group", text: "@all standup" }, CTX).action, "skip");
    assert.equal(classifyMessage({ senderType: "agent", threadType: "group", text: "@Ada standup" }, CTX).action, "skip");
});

// ── Compact organization block ──────────────────────────────────────────
// Same wording rules as the Hermes bridge: leader + this agent's reporting
// line, one escalation rule, <=400 chars, "" when unconfigured.
test("organizationContext: names the leader and this agent's reporting line", () => {
    const info = {
        configured: true,
        leader: { kind: "human", id: "h1", name: "Grace" },
        reporting: [{ context: "Direct reporting", reportsTo: { kind: "agent", id: "a1", name: "Ada" } }],
        teams: [],
    };
    assert.equal(
        organizationContext(info, "a2"),
        "Org: leader Grace; you report to Ada\n"
        + "Escalate cross-team conflicts to the leader; details: GET /organization."
    );
});

test("organizationContext: an agent that is the leader reports to humans", () => {
    const info = { configured: true, leader: { kind: "agent", id: "a1", name: "Ada" }, reporting: [], teams: [] };
    assert.match(organizationContext(info, "a1"), /you lead the company; report to humans/);
});

test("organizationContext: not configured (or malformed) omits the block", () => {
    assert.equal(organizationContext({ configured: false }, "a1"), "");
    assert.equal(organizationContext(null, "a1"), "");
    assert.equal(organizationContext(undefined, "a1"), "");
});

test("organizationContext: falls back to a team coordinator's reporting line", () => {
    const info = {
        configured: true,
        leader: { kind: "human", id: "h1", name: "Grace" },
        reporting: [],
        teams: [{ name: "Dev", coordinator: { kind: "agent", id: "a1", name: "Ada" } }],
    };
    // A member reports to the coordinator; the coordinator itself reports to the leader.
    assert.match(organizationContext(info, "a2"), /you report to Ada/);
    assert.match(organizationContext(info, "a1"), /you report to Grace/);
});

test("organizationContext: stays under 400 chars with long names", () => {
    const info = {
        configured: true,
        leader: { kind: "human", id: "h1", name: "L".repeat(200) },
        reporting: [{ context: "Direct reporting", reportsTo: { kind: "agent", id: "a1", name: "R".repeat(200) } }],
        teams: [],
    };
    assert.ok(organizationContext(info, "a2").length <= 400);
});

// ── Run ledger (PR 3) ───────────────────────────────────────────────────

test("parseServerCapabilities: reads the handshake, [] for an older server", () => {
    assert.deepEqual(parseServerCapabilities({ serverCapabilities: ["rich-blocks-v1", "runs: 1"] }), ["rich-blocks-v1", "runs: 1"]);
    assert.deepEqual(parseServerCapabilities({ runtimeNode: {} }), []);
    assert.deepEqual(parseServerCapabilities(null), []);
    assert.deepEqual(parseServerCapabilities({ serverCapabilities: [null, 1, "runs: 1"] }), ["1", "runs: 1"]);
});

test("serverSupportsRuns: gated on the runs: 1 capability", () => {
    assert.equal(RUNS_CAPABILITY, "runs: 1");
    assert.equal(serverSupportsRuns(["runs: 1"]), true);
    assert.equal(serverSupportsRuns(["rich-blocks-v1"]), false);
    assert.equal(serverSupportsRuns([]), false);
    assert.equal(serverSupportsRuns(undefined), false);
});

test("mapRunFinishStatus: outcome → terminal status", () => {
    assert.equal(mapRunFinishStatus(null), "succeeded");
    assert.equal(mapRunFinishStatus(undefined), "succeeded");
    assert.equal(mapRunFinishStatus({ code: "RUN_TIMEOUT" }), "timeout");
    assert.equal(mapRunFinishStatus({ timedOut: true }), "timeout");
    assert.equal(mapRunFinishStatus({ code: "RUN_CANCELLED" }), "cancelled");
    assert.equal(mapRunFinishStatus(new Error("boom")), "failed");
});

test("mapExitToRunStatus: non-zero exit is failed, a signal is timeout", () => {
    assert.equal(mapExitToRunStatus(0, null), "succeeded");
    assert.equal(mapExitToRunStatus(0, undefined), "succeeded");
    assert.equal(mapExitToRunStatus(1, null), "failed");
    assert.equal(mapExitToRunStatus(2, null), "failed");
    assert.equal(mapExitToRunStatus(null, "SIGTERM"), "timeout");
    assert.equal(mapExitToRunStatus(1, "SIGKILL"), "timeout");
});

test("isRetryableLedgerError: 4xx is permanent, everything else retries", () => {
    assert.equal(isRetryableLedgerError({ status: 400 }), false);
    assert.equal(isRetryableLedgerError({ status: 404 }), false);
    assert.equal(isRetryableLedgerError({ status: 401 }), false);
    assert.equal(isRetryableLedgerError({ status: 500 }), true);
    assert.equal(isRetryableLedgerError({ status: 503 }), true);
    assert.equal(isRetryableLedgerError(new Error("network timed out")), true);
    assert.equal(isRetryableLedgerError(null), true);
});

test("createLedgerBreaker: opens after 3 failures, skips while open, closes after the window", () => {
    let clock = 1_000_000;
    const events = [];
    const breaker = createLedgerBreaker({
        now: () => clock,
        onOpen: () => events.push("open"),
        onClose: () => events.push("close"),
    });

    assert.equal(LEDGER_BREAKER_THRESHOLD, 3);
    assert.equal(LEDGER_BREAKER_COOLDOWN_MS, 5 * 60 * 1000);

    breaker.recordFailure();
    breaker.recordFailure();
    assert.equal(breaker.shouldSkip(), false, "still closed after 2 failures");
    assert.deepEqual(events, []);

    breaker.recordFailure();
    assert.equal(breaker.shouldSkip(), true, "open after the 3rd consecutive failure");
    assert.deepEqual(events, ["open"]);

    // While the window is open every call is skipped and nothing is re-logged.
    clock += LEDGER_BREAKER_COOLDOWN_MS - 1;
    assert.equal(breaker.shouldSkip(), true);
    assert.deepEqual(events, ["open"]);

    // The window elapsing closes the breaker once.
    clock += 2;
    assert.equal(breaker.shouldSkip(), false);
    assert.deepEqual(events, ["open", "close"]);

    // A success resets the consecutive-failure counter.
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    clock += LEDGER_BREAKER_COOLDOWN_MS;
    breaker.shouldSkip();
    assert.equal(breaker.shouldSkip(), false, "counter reset means it does not reopen");
    assert.deepEqual(events, ["open", "close"]);
});

test("buildRunStartPayload: shape includes runtimeKind=codex, omits absent ids", () => {
    const payload = buildRunStartPayload({
        id: "run-1", agentId: "agent-1", runtimeId: "codex-abc", bridgeVersion: "0.2.0",
        triggerMessageId: "msg-1", threadId: "thread-1", taskId: "task-1",
        startedAt: "2026-01-01T00:00:00Z",
    });
    assert.deepEqual(payload, {
        id: "run-1", agentId: "agent-1", runtimeId: "codex-abc", runtimeKind: "codex",
        bridgeVersion: "0.2.0", triggerKind: "message", triggerMessageId: "msg-1",
        threadId: "thread-1", taskId: "task-1", startedAt: "2026-01-01T00:00:00Z",
    });
    const minimal = buildRunStartPayload({ id: "run-2", agentId: "a", runtimeId: "r", bridgeVersion: "0.2.0", startedAt: "t" });
    assert.equal("threadId" in minimal, false);
    assert.equal("taskId" in minimal, false);
    assert.equal("triggerMessageId" in minimal, false);
});

test("buildRunFinishPayload: shape omits unset fields, keeps zeroes", () => {
    const payload = buildRunFinishPayload({
        status: "succeeded", endedAt: "2026-01-01T00:00:02Z", durationMs: 2000,
        inputTokens: 3, outputTokens: 4, replyMessageId: "reply-1", error: null,
    });
    assert.deepEqual(payload, {
        status: "succeeded", endedAt: "2026-01-01T00:00:02Z", durationMs: 2000,
        inputTokens: 3, outputTokens: 4, replyMessageId: "reply-1",
    });
    const zeroed = buildRunFinishPayload({ status: "failed", durationMs: 0, toolCalls: 0 });
    assert.equal(zeroed.durationMs, 0);
    assert.equal(zeroed.toolCalls, 0);
    assert.equal("error" in zeroed, false);
    assert.equal("replyMessageId" in zeroed, false);
});
