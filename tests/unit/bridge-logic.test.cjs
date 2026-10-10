/* eslint-disable @typescript-eslint/no-require-imports */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
    classifyMessage,
    loopGuardOk,
    estimateUsageTokens,
    stripCodexNoise,
    replyFormatGuide,
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
