import { test } from "node:test";
import assert from "node:assert/strict";
import {
    agentLoopHardCap,
    agentLoopMaxTurns,
    agentStreaks,
    decideDelivery,
    mentionedAgentIds,
    mentionsEveryone,
} from "../../src/lib/message-routing";

const roster = [
    { id: "max", name: "Max" },
    { id: "maxb", name: "Max Builder" },
    { id: "qa", name: "QA" },
    { id: "kat", name: "Katarína – Accountant (SK)" },
    { id: "alex1", name: "Alex Smith" },
    { id: "alex2", name: "Alex Jones" },
];

const human = (text: string) => ({ senderType: "human", senderId: "u1", targetAgentId: null, text });
const agent = (text: string, senderId = "other") => ({ senderType: "agent", senderId, targetAgentId: null, text });

test("full names win over first names, so @Max Builder doesn't wake Max", () => {
    assert.deepEqual([...mentionedAgentIds("@Max Builder please build it", roster)], ["maxb"]);
    assert.deepEqual([...mentionedAgentIds("@Max please review", roster)], ["max"]);
    assert.deepEqual([...mentionedAgentIds("@QA and @Max-Builder", roster)].sort(), ["maxb", "qa"]);
});

test("ambiguous first names match nobody; accents and suffixes are handled", () => {
    assert.equal(mentionedAgentIds("@Alex can you check", roster).size, 0);
    assert.deepEqual([...mentionedAgentIds("@Alex-Jones can you check", roster)], ["alex2"]);
    assert.deepEqual([...mentionedAgentIds("@Katarina invoice please", roster)], ["kat"]);
});

test("emails and in-word @ are not mentions", () => {
    assert.equal(mentionedAgentIds("write to qa@example.com", roster).size, 0);
    assert.equal(mentionsEveryone("ops@all.example"), false);
    assert.equal(mentionsEveryone("@allison"), false);
    assert.equal(mentionsEveryone("Heads up @Everyone"), true);
});

test("decideDelivery: targets, direct threads, mentions, @all", () => {
    const base = { agentId: "qa", roster, agentStreak: 0 };
    assert.deepEqual(decideDelivery({ ...base, threadType: "team", message: agent("hi", "qa") }), { addressedToYou: false, routeReason: "self" });
    assert.equal(decideDelivery({ ...base, threadType: "direct", message: { ...human("hi"), targetAgentId: "qa" } }).routeReason, "targeted");
    assert.equal(decideDelivery({ ...base, threadType: "direct", message: { ...human("hi"), targetAgentId: "max" } }).addressedToYou, false);
    assert.deepEqual(decideDelivery({ ...base, threadType: "direct", message: human("hi") }), { addressedToYou: true, routeReason: "direct" });
    assert.deepEqual(decideDelivery({ ...base, threadType: "team", message: human("@QA test login") }), { addressedToYou: true, routeReason: "mention" });
    assert.equal(decideDelivery({ ...base, threadType: "team", message: human("status?") }).routeReason, "not_addressed");
    assert.deepEqual(decideDelivery({ ...base, threadType: "group", message: human("@all standup") }), { addressedToYou: true, routeReason: "all" });
    // @all is for people, and only in groups.
    assert.equal(decideDelivery({ ...base, threadType: "group", message: agent("@all standup") }).addressedToYou, false);
    assert.equal(decideDelivery({ ...base, threadType: "team", message: human("@all standup") }).addressedToYou, false);
    // An unknown future thread type is treated as shared, never as private.
    assert.equal(decideDelivery({ ...base, threadType: "channel", message: human("hello") }).addressedToYou, false);
});

test("decideDelivery: the loop guard stops agent chains in shared threads only", () => {
    const base = { agentId: "qa", roster, maxAgentTurns: 6 };
    assert.equal(decideDelivery({ ...base, threadType: "team", message: agent("@QA again"), agentStreak: 6 }).addressedToYou, true);
    assert.deepEqual(decideDelivery({ ...base, threadType: "team", message: agent("@QA again"), agentStreak: 7 }), { addressedToYou: false, routeReason: "loop_guard" });
    assert.equal(decideDelivery({ ...base, threadType: "group", message: agent("@QA again"), agentStreak: 7 }).routeReason, "loop_guard");
    // A person always gets through.
    assert.equal(decideDelivery({ ...base, threadType: "team", message: human("@QA please"), agentStreak: 0 }).addressedToYou, true);
});

test("agentStreaks counts agent runs, resets on people, ignores system notices", () => {
    const streaks = agentStreaks([
        { id: "1", senderType: "agent" },
        { id: "2", senderType: "agent" },
        { id: "3", senderType: "system" },
        { id: "4", senderType: "agent" },
        { id: "5", senderType: "human" },
        { id: "6", senderType: "agent" },
    ]);
    assert.deepEqual([...streaks.values()], [1, 2, 0, 3, 0, 1]);
});

test("loop limits read the environment safely", () => {
    assert.equal(agentLoopMaxTurns({}), 6);
    assert.equal(agentLoopMaxTurns({ EMPEROR_AGENT_LOOP_MAX_TURNS: "10" }), 10);
    assert.equal(agentLoopMaxTurns({ EMPEROR_AGENT_LOOP_MAX_TURNS: "1" }), 6);
    assert.equal(agentLoopMaxTurns({ EMPEROR_AGENT_LOOP_MAX_TURNS: "lots" }), 6);
    assert.equal(agentLoopHardCap({}), 18);
});
