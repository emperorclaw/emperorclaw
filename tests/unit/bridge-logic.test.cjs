/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    classifyMessage,
    loopGuardOk,
    estimateUsageTokens,
    stripCodexNoise,
} = require("../../integrations/codex/bridge-logic");

const CTX = { agentId: "agent-1", agentName: "Ada" };

test("classifyMessage: responds to a direct human message addressed to this agent", () => {
    const d = classifyMessage({ senderType: "human", targetAgentId: "agent-1", text: "hello" }, CTX);
    assert.equal(d.action, "respond");
    assert.equal(d.resetLoop, true);
});

test("classifyMessage: never responds to another agent (loop prevention)", () => {
    const d = classifyMessage({ senderType: "agent", targetAgentId: "agent-1", text: "hi" }, CTX);
    assert.equal(d.action, "skip");
    assert.equal(d.reason, "agent-sender");
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
