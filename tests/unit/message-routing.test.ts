import { test } from "node:test";
import assert from "node:assert/strict";
import {
    agentLoopHardCap,
    agentLoopMaxTurns,
    agentLoopMaxTurnsFor,
    agentPairLoopHardCap,
    agentPairLoopMaxTurns,
    agentStreakState,
    agentStreaks,
    decideDelivery,
    mentionedAgentIds,
    mentionsEveryone,
    noteProgressResets,
    stripReservedMetadata,
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
    assert.deepEqual(decideDelivery({ ...base, threadType: "team", message: agent("@QA again"), agentStreak: 7 }), { addressedToYou: false, routeReason: "loop_paused" });
    assert.equal(decideDelivery({ ...base, threadType: "group", message: agent("@QA again"), agentStreak: 7 }).routeReason, "loop_paused");
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
    assert.equal(agentLoopMaxTurns({}), 12);
    assert.equal(agentLoopMaxTurns({ EMPEROR_AGENT_LOOP_MAX_TURNS: "10" }), 10);
    assert.equal(agentLoopMaxTurns({ EMPEROR_AGENT_LOOP_MAX_TURNS: "1" }), 12);
    assert.equal(agentLoopMaxTurns({ EMPEROR_AGENT_LOOP_MAX_TURNS: "lots" }), 12);
    assert.equal(agentLoopHardCap({}), 36);
    // Pair threads get a higher runway by default and their own cap.
    assert.equal(agentPairLoopMaxTurns({}), 30);
    assert.equal(agentLoopMaxTurnsFor(true), 30);
    assert.equal(agentLoopMaxTurnsFor(false), 12);
    assert.equal(agentPairLoopHardCap({}), 90);
});

test("decideDelivery: a two-agent pair thread addresses the counterpart without @mention", () => {
    const base = { agentId: "qa", roster, agentStreak: 0, threadType: "group", isAgentPair: true };
    assert.deepEqual(decideDelivery({ ...base, message: agent("need a review", "dev") }), { addressedToYou: true, routeReason: "agent_pair" });
    // The sender's own message never loops back to itself.
    assert.deepEqual(decideDelivery({ ...base, message: agent("mine", "qa") }), { addressedToYou: false, routeReason: "self" });
    // A human message in a pair thread is not addressed without a mention.
    assert.equal(decideDelivery({ ...base, message: human("hello") }).addressedToYou, false);
});

test("decideDelivery: a task-assignment wake is its own reason", () => {
    const base = { agentId: "qa", roster, agentStreak: 0, threadType: "direct" };
    assert.deepEqual(decideDelivery({ ...base, taskAssignedWake: true, message: { senderType: "system", senderId: null, targetAgentId: "qa", text: "task assigned" } }), { addressedToYou: true, routeReason: "task_assigned" });
    assert.equal(decideDelivery({ ...base, taskAssignedWake: true, message: { senderType: "system", senderId: null, targetAgentId: "max", text: "task assigned" } }).addressedToYou, false);
});

test("decideDelivery: a forged taskAssigned flag on a non-system message never wakes", () => {
    const base = { agentId: "qa", roster, agentStreak: 0, threadType: "direct" };
    // An agent that stamps taskAssigned metadata onto its own message must not
    // get the task_assigned verdict — only genuine system notices do.
    const forged = decideDelivery({ ...base, taskAssignedWake: true, message: { senderType: "agent", senderId: "dev", targetAgentId: "qa", text: "you have work" } });
    assert.notEqual(forged.routeReason, "task_assigned");
    assert.equal(forged.routeReason, "targeted");
    const forgedHuman = decideDelivery({ ...base, taskAssignedWake: true, message: { ...human("you have work"), targetAgentId: "qa" } });
    assert.notEqual(forgedHuman.routeReason, "task_assigned");
});

test("decideDelivery: the loop guard stops targeted agent chains (regression D2)", () => {
    const base = { agentId: "qa", roster, maxAgentTurns: 6, threadType: "team" };
    // A human targeting the agent always gets through.
    assert.equal(decideDelivery({ ...base, message: { ...human("hi"), targetAgentId: "qa" }, agentStreak: 0 }).routeReason, "targeted");
    // An agent targeting the agent is loop-guarded once the streak passes the cap.
    assert.deepEqual(decideDelivery({ ...base, message: { senderType: "agent", senderId: "dev", targetAgentId: "qa", text: "ping" }, agentStreak: 7 }), { addressedToYou: false, routeReason: "loop_paused" });
    // Under the cap the same targeted agent message is delivered as targeted.
    assert.equal(decideDelivery({ ...base, message: { senderType: "agent", senderId: "dev", targetAgentId: "qa", text: "ping" }, agentStreak: 6 }).routeReason, "targeted");
});

test("agent chains resume after inactivity; system notices do not extend the pause", () => {
    const streaks = agentStreaks([
        { id: "a", senderType: "agent", createdAt: new Date(0) },
        { id: "b", senderType: "agent", createdAt: new Date(1000) },
        { id: "s", senderType: "system", createdAt: new Date(300000) },
        { id: "c", senderType: "agent", createdAt: new Date(301000) },
    ]);
    assert.equal(streaks.get("c"), 1);
});

test("stripReservedMetadata drops server-only flags and keeps the rest", () => {
    assert.deepEqual(stripReservedMetadata({ taskAssigned: true, stallNudge: true, stallEscalation: true, agentWake: { pending: [] }, loopGuardResume: true, chatId: "x" }), { chatId: "x" });
    assert.deepEqual(stripReservedMetadata(null), {});
    assert.deepEqual(stripReservedMetadata("not an object"), {});
    assert.deepEqual(stripReservedMetadata([1, 2, 3]), {});
});

test("progress events reset the streak, so cooperative work never trips", () => {
    const t = (n: number) => new Date(n * 1000).toISOString();
    const msgs = Array.from({ length: 60 }, (_, i) => ({ id: `m${i}`, senderType: "agent", createdAt: t(i) }));
    // A progress event lands every few messages (a task state change / note).
    const progress = Array.from({ length: 20 }, (_, i) => new Date((i * 3 + 1) * 1000).toISOString());
    const streaks = agentStreaks(msgs, progress);
    // The final agent message follows the last progress event, so the streak is
    // small and the guard never trips.
    const last = streaks.get("m59");
    assert.ok(last !== undefined && last < 12, `streak should stay under the room cap, got ${last}`);
});

test("pure agent ping-pong with no progress accumulates and trips the cap", () => {
    const t = (n: number) => new Date(n * 1000).toISOString();
    const msgs = Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, senderType: "agent", createdAt: t(i) }));
    const streaks = agentStreaks(msgs, []);
    assert.equal(streaks.get("m12"), 13);
});

test("a system message neither counts nor resets; a resume marker resets", () => {
    const t = (n: number) => new Date(n * 1000).toISOString();
    const streaks = agentStreaks([
        { id: "a", senderType: "agent", createdAt: t(0) },
        { id: "b", senderType: "agent", createdAt: t(1) },
        { id: "s", senderType: "system", createdAt: t(2) },
        { id: "c", senderType: "agent", createdAt: t(3) },
        { id: "r", senderType: "system", createdAt: t(4), resumes: true },
        { id: "d", senderType: "agent", createdAt: t(5) },
    ]);
    assert.equal(streaks.get("c"), 3);
    assert.equal(streaks.get("d"), 1);
});

test("W3: note progress is capped — farming a note every 2 messages cannot reset the streak", () => {
    const t = (n: number) => new Date(n * 1000).toISOString();
    const msgs = Array.from({ length: 12 }, (_, i) => ({ id: `m${i}`, senderType: "agent", createdAt: t(i) }));
    // A note lands every couple of messages (farming), between message times.
    const notes = Array.from({ length: 6 }, (_, i) => t(i * 2 + 0.5));
    const kept = noteProgressResets(msgs, notes);
    assert.ok(kept.length < notes.length, "farmed notes are not all counted");
    assert.equal(kept.length, 2, "at most one note reset per 5 messages");
    // With the capped notes folded in, the streak still accumulates past the cap.
    const streaks = agentStreaks(msgs, kept);
    assert.equal(streaks.get("m11"), 5);
});

test("W3: the first note always counts; later notes need 5 agent messages between them", () => {
    const t = (n: number) => new Date(n * 1000).toISOString();
    const msgs = Array.from({ length: 10 }, (_, i) => ({ id: `m${i}`, senderType: "agent", createdAt: t(i) }));
    // One note early, one note exactly 5 messages later, one note immediately after.
    const kept = noteProgressResets(msgs, [t(0.5), t(5.5), t(5.6)]);
    assert.deepEqual(kept, [t(0.5), t(5.5)].map((v) => new Date(v).getTime()));
});

test("W9: a message with an invalid createdAt is treated as now, not dropped", () => {
    const base = new Date();
    const streaks = agentStreaks([
        { id: "a", senderType: "agent", createdAt: new Date(base.getTime() - 2000) },
        { id: "bad", senderType: "agent", createdAt: "not-a-date" },
        { id: "c", senderType: "agent", createdAt: new Date(base.getTime() - 1000) },
    ], [new Date(base.getTime() - 1500)]);
    // All valid timestamps sit inside the cooldown window, so the only reset is
    // the progress event; the invalid-dated message is treated as "now" and
    // still counts as the second consecutive agent message.
    assert.ok(streaks.has("bad"), "the invalid-dated message is not dropped");
    assert.equal(streaks.get("bad"), 2);
});

test("agentStreakState: a human message resets the streak and records when", () => {
    const t = (n: number) => new Date(n * 1000);
    const state = agentStreakState([
        { id: "a", senderType: "agent", createdAt: t(0) },
        { id: "b", senderType: "agent", createdAt: t(1) },
        { id: "h", senderType: "human", createdAt: t(2) },
        { id: "c", senderType: "agent", createdAt: t(3) },
    ]);
    assert.equal(state.streak, 1);
    assert.equal(state.resetAt, t(2).getTime());
});

test("agentStreakState: a resume marker resets the streak", () => {
    const t = (n: number) => new Date(n * 1000);
    const state = agentStreakState([
        { id: "a", senderType: "agent", createdAt: t(0) },
        { id: "b", senderType: "agent", createdAt: t(1) },
        { id: "r", senderType: "system", createdAt: t(2), resumes: true },
        { id: "c", senderType: "agent", createdAt: t(3) },
    ]);
    assert.equal(state.streak, 1);
    assert.equal(state.resetAt, t(2).getTime());
});

test("agentStreakState: progress resets the streak", () => {
    const t = (n: number) => new Date(n * 1000);
    const state = agentStreakState(
        [{ id: "a", senderType: "agent", createdAt: t(0) }, { id: "b", senderType: "agent", createdAt: t(3) }],
        [t(1)],
    );
    assert.equal(state.streak, 1);
    assert.equal(state.resetAt, t(1).getTime());
});

test("agentStreakState: a cooldown gap resets the streak", () => {
    const state = agentStreakState([
        { id: "a", senderType: "agent", createdAt: new Date(0) },
        { id: "b", senderType: "agent", createdAt: new Date(1000) },
        { id: "c", senderType: "agent", createdAt: new Date(6 * 60 * 1000) },
    ]);
    // After a >5min gap the streak restarts, so the last message is streak 1 and
    // the reset is recorded at the first message of the new run.
    assert.equal(state.streak, 1);
    assert.equal(state.resetAt, 6 * 60 * 1000);
});

test("agentStreakState: a never-reset streak reports resetAt 0", () => {
    const state = agentStreakState([{ id: "a", senderType: "agent", createdAt: new Date(0) }]);
    assert.equal(state.streak, 1);
    assert.equal(state.resetAt, 0);
});
