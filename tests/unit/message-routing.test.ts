import { test } from "node:test";
import assert from "node:assert/strict";
import {
    agentLoopHardCap,
    agentLoopMaxTurns,
    agentLoopMaxTurnsFor,
    agentMessageWakesAgent,
    agentPairLoopHardCap,
    agentPairLoopMaxTurns,
    agentStreakState,
    agentStreaks,
    answeredCutoffByThread,
    decideDelivery,
    filterAnsweredMessages,
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
    // Pair messages keep targetAgentId for old runtimes; the verdict is still agent_pair.
    assert.deepEqual(decideDelivery({ ...base, message: { ...agent("need a review", "dev"), targetAgentId: "qa" } }), { addressedToYou: true, routeReason: "agent_pair" });
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


test("multiword mentions survive Unicode spaces, format marks, and accent forms", () => {
    const people = [{id:"jose",name:"José Zúñiga"},{id:"other",name:"José Pérez"},{id:"long",name:"María José de la Cruz"}];
    for (const separator of [" ", "\u00a0", "\u202f", "\u2009", "\t", "\u200b", "\u2060", "\ufeff"]) {
        const text = `@José${separator}Zúñiga, revisa esto`;
        assert.deepEqual([...mentionedAgentIds(text,people)],["jose"],JSON.stringify(text));
        assert.equal(decideDelivery({agentId:"jose",roster:people,threadType:"group",message:agent(text),agentStreak:1}).routeReason,"mention");
        assert.equal(decideDelivery({agentId:"other",roster:people,threadType:"group",message:agent(text),agentStreak:1}).addressedToYou,false);
        assert.equal(decideDelivery({agentId:"jose",roster:people,threadType:"group",message:agent(text),agentStreak:13}).routeReason,"loop_paused");
    }
    assert.deepEqual([...mentionedAgentIds("\u200e@\u200bJose\u0301 Zun\u0303iga",people)],["jose"]);
    assert.deepEqual([...mentionedAgentIds("＠María José de la Cruz: por favor",people)],["long"]);
    assert.equal(mentionedAgentIds("@José",people).size,0);
    assert.equal(mentionedAgentIds("@José\nZúñiga",people).size,0,"Names never cross paragraph boundaries");
    assert.equal(mentionedAgentIds("josé@José Zúñiga",people).size,0,"Unicode emails do not become mentions");
});

test("duplicate full names never broadcast a mention to multiple agents", () => {
    const people=[{id:"a",name:"José Zúñiga"},{id:"b",name:"Jose Zuniga"}];
    assert.equal(mentionedAgentIds("@José\u00a0Zúñiga revisa esto",people).size,0);
});

test("filterAnsweredMessages suppresses answered messages by instant, TZ-safe", () => {
    const replied = new Date("2026-10-09T12:00:05Z");
    const asked = new Date("2026-10-09T12:00:00Z");
    const messages = [
        { threadId: "t1", senderType: "agent", targetAgentId: "me", deliveryState: "resolved", createdAt: asked, text: "question" },
        { threadId: "t2", senderType: "agent", targetAgentId: "me", deliveryState: "resolved", createdAt: asked, text: "unanswered elsewhere" },
    ];
    const kept = filterAnsweredMessages(messages, new Map([["t1", replied]]), "me");
    assert.deepEqual(kept.map((m) => m.text), ["unanswered elsewhere"], "the answered thread's older message is dropped");
    // A reply older than the message keeps the message.
    const earlierReply = new Date("2026-10-09T11:59:59Z");
    assert.equal(filterAnsweredMessages(messages, new Map([["t1", earlierReply]]), "me").length, 2);
});

test("filterAnsweredMessages keeps a queued direct follow-up addressed to this agent", () => {
    const replied = new Date("2026-10-09T12:00:05Z");
    const asked = new Date("2026-10-09T12:00:00Z");
    const messages = [
        { threadId: "t1", senderType: "human", targetAgentId: "me", deliveryState: "queued", createdAt: asked, text: "human follow-up" },
        { threadId: "t1", senderType: "system", targetAgentId: "me", deliveryState: "queued", createdAt: asked, text: "system follow-up" },
        // A resolved item is not a held follow-up and stays suppressed.
        { threadId: "t1", senderType: "human", targetAgentId: "me", deliveryState: "resolved", createdAt: asked, text: "old human" },
    ];
    const kept = filterAnsweredMessages(messages, new Map([["t1", replied]]), "me");
    assert.deepEqual(kept.map((m) => m.text), ["human follow-up", "system follow-up"]);
});

test("answeredCutoffByThread keys on the answered message, not the reply instant", () => {
    // A serial runtime answers the human @all (18:48) at 18:54; a peer mention
    // that arrived at 18:52 while it was busy must stay pending.
    const humanAtAll = new Date("2026-10-10T18:48:17Z");
    const peerMention = new Date("2026-10-10T18:52:51Z");
    const reply = new Date("2026-10-10T18:54:42Z");

    const cutoff = answeredCutoffByThread(
        [{ threadId: "g1", createdAt: reply, replyToId: "human-msg" }],
        new Map([["human-msg", humanAtAll]]),
    );
    assert.equal(cutoff.get("g1")!.toISOString(), humanAtAll.toISOString(), "cutoff is the answered message's instant");

    const messages = [
        { threadId: "g1", senderType: "human", targetAgentId: null, deliveryState: "queued", createdAt: humanAtAll, text: "human @all" },
        { threadId: "g1", senderType: "agent", targetAgentId: null, deliveryState: "resolved", createdAt: peerMention, text: "@me while busy" },
    ];
    // The answered human message is dropped; the peer mention that arrived during
    // the turn is kept and queued instead of being swallowed.
    const kept = filterAnsweredMessages(messages, cutoff, "me");
    assert.deepEqual(kept.map((m) => m.text), ["@me while busy"]);
});

test("answeredCutoffByThread falls back to the reply instant without a reported source", () => {
    const reply = new Date("2026-10-10T18:54:42Z");
    const cutoff = answeredCutoffByThread(
        [{ threadId: "g1", createdAt: reply, replyToId: null }],
        new Map(),
    );
    assert.equal(cutoff.get("g1")!.toISOString(), reply.toISOString());
});

// ── Loop guard: only messages that wake another agent count ────────────────

const team = [
    { id: "builder", name: "Builder" },
    { id: "architect", name: "Hermes-Architect" },
    { id: "hqa", name: "Hermes-QA" },
];

type RoomMessage = { id: string; senderType: string; senderId: string | null; targetAgentId: string | null; text: string; createdAt: string };

/** What the sync route does: stamp wakesAgent, compute streaks, then route. */
function routeRoom(messages: RoomMessage[], agentId: string, opts: { isAgentPair?: boolean; threadType?: string } = {}) {
    const isAgentPair = Boolean(opts.isAgentPair);
    const streaks = agentStreaks(messages.map((m) => ({
        id: m.id,
        senderType: m.senderType,
        createdAt: m.createdAt,
        wakesAgent: m.senderType === "agent" ? agentMessageWakesAgent(m, team, isAgentPair) : undefined,
    })));
    const last = messages[messages.length - 1];
    return {
        streak: streaks.get(last.id),
        decision: decideDelivery({
            agentId,
            message: last,
            threadType: opts.threadType ?? "group",
            roster: team,
            agentStreak: streaks.get(last.id) ?? 0,
            isAgentPair,
        }),
    };
}

const at = (n: number) => new Date(n * 1000).toISOString();
const roomAgent = (i: number, senderId: string, text: string, targetAgentId: string | null = null): RoomMessage =>
    ({ id: `m${i}`, senderType: "agent", senderId, targetAgentId, text, createdAt: at(i) });

test("agentMessageWakesAgent: targets, mentions of others, and pair threads wake; broadcasts do not", () => {
    assert.equal(agentMessageWakesAgent({ senderId: "builder", targetAgentId: null, text: "Cron 22:12Z — worker is back" }, team, false), false);
    assert.equal(agentMessageWakesAgent({ senderId: "builder", targetAgentId: null, text: "@Hermes-Architect decide" }, team, false), true);
    assert.equal(agentMessageWakesAgent({ senderId: "builder", targetAgentId: "architect", text: "decide" }, team, false), true);
    // Mentioning only yourself, or @all, wakes no agent.
    assert.equal(agentMessageWakesAgent({ senderId: "builder", targetAgentId: null, text: "@Builder here: status ok" }, team, false), false);
    assert.equal(agentMessageWakesAgent({ senderId: "builder", targetAgentId: null, text: "@all standup done" }, team, false), false);
    // In a pair thread every message addresses the counterpart.
    assert.equal(agentMessageWakesAgent({ senderId: "builder", targetAgentId: null, text: "status" }, team, true), true);
});

test("status broadcasts never burn the loop budget: an escalation after 20 broadcasts is delivered", () => {
    const msgs: RoomMessage[] = [{ id: "h", senderType: "human", senderId: "u1", targetAgentId: null, text: "go", createdAt: at(0) }];
    for (let i = 1; i <= 20; i++) msgs.push(roomAgent(i, "builder", `Cron tick ${i} — worker is back`));
    msgs.push(roomAgent(21, "builder", "@Hermes-Architect, I need your decision"));
    const { streak, decision } = routeRoom(msgs, "architect");
    assert.equal(streak, 1);
    assert.deepEqual(decision, { addressedToYou: true, routeReason: "mention" });
});

test("a mention ping-pong still trips the guard on the 13th message", () => {
    const msgs: RoomMessage[] = [];
    for (let i = 1; i <= 13; i++) {
        msgs.push(i % 2 ? roomAgent(i, "builder", "@Hermes-Architect your turn") : roomAgent(i, "architect", "@Builder your turn"));
    }
    const { streak, decision } = routeRoom(msgs, "architect");
    assert.equal(streak, 13);
    assert.deepEqual(decision, { addressedToYou: false, routeReason: "loop_paused" });
    assert.equal(routeRoom(msgs.slice(0, 12), "builder").decision.routeReason, "mention");
});

test("broadcasts inside a mention ping-pong neither count nor reset the streak", () => {
    const msgs: RoomMessage[] = [];
    let i = 0;
    for (let turn = 1; turn <= 13; turn++) {
        i += 1;
        msgs.push(turn % 2 ? roomAgent(i, "builder", "@Hermes-Architect your turn") : roomAgent(i, "architect", "@Builder your turn"));
        i += 1;
        msgs.push(roomAgent(i, "hqa", `FYI: tests green (${turn})`));
    }
    msgs.pop(); // end on the 13th mention
    const { streak, decision } = routeRoom(msgs, "architect");
    assert.equal(streak, 13);
    assert.equal(decision.routeReason, "loop_paused");
    // A broadcast reports the unchanged streak of the run it sits in.
    const streaks = agentStreaks(msgs.map((m) => ({ ...m, wakesAgent: agentMessageWakesAgent(m, team, false) })));
    assert.equal(streaks.get("m2"), 1);
    assert.equal(streaks.get("m4"), 2);
});

test("a human message still resets a counted streak", () => {
    const msgs: RoomMessage[] = [];
    for (let i = 1; i <= 12; i++) msgs.push(roomAgent(i, i % 2 ? "builder" : "architect", i % 2 ? "@Hermes-Architect go" : "@Builder go"));
    msgs.push({ id: "h", senderType: "human", senderId: "u1", targetAgentId: null, text: "keep going", createdAt: at(13) });
    msgs.push(roomAgent(14, "builder", "@Hermes-Architect go"));
    const { streak, decision } = routeRoom(msgs, "architect");
    assert.equal(streak, 1);
    assert.equal(decision.routeReason, "mention");
});

test("pair threads count every agent message, mention or not", () => {
    const msgs: RoomMessage[] = [];
    for (let i = 1; i <= 31; i++) msgs.push(roomAgent(i, i % 2 ? "builder" : "architect", "status update"));
    const { streak, decision } = routeRoom(msgs, "architect", { isAgentPair: true });
    assert.equal(streak, 31);
    assert.equal(decision.routeReason, "loop_paused");
    assert.equal(routeRoom(msgs.slice(0, 30), "builder", { isAgentPair: true }).decision.routeReason, "agent_pair");
});

test("legacy callers without wakesAgent count every agent message", () => {
    const msgs = Array.from({ length: 13 }, (_, i) => ({ id: `m${i}`, senderType: "agent", createdAt: at(i) }));
    assert.equal(agentStreaks(msgs).get("m12"), 13);
    assert.equal(agentStreakState(msgs).streak, 13);
    // An explicit false is skipped, by both the streak and its state.
    const skipped = msgs.map((m, i) => ({ ...m, wakesAgent: i % 2 === 0 }));
    assert.equal(agentStreaks(skipped).get("m12"), 7);
    assert.equal(agentStreakState(skipped).streak, 7);
});

test("a broadcast does not extend the cooldown window", () => {
    const streaks = agentStreaks([
        { id: "a", senderType: "agent", createdAt: new Date(0) },
        { id: "b", senderType: "agent", createdAt: new Date(200000), wakesAgent: false },
        { id: "c", senderType: "agent", createdAt: new Date(301000) },
    ]);
    assert.equal(streaks.get("c"), 1);
});

test("broadcasts cannot earn task-note resets", () => {
    const msgs = [
        { id: "a", senderType: "agent", createdAt: at(0) },
        ...Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, senderType: "agent", createdAt: at(1 + i), wakesAgent: false })),
    ];
    // The first note always counts; the second would need 5 counted messages.
    assert.deepEqual(noteProgressResets(msgs, [at(0.5), at(7.5)]), [new Date(at(0.5)).getTime()]);
});

// ── Short, unambiguous mention aliases ──────────────────────────────────────

test("a single name token aliases an agent when it is unambiguous", () => {
    assert.deepEqual([...mentionedAgentIds("@Architect please decide", team)], ["architect"]);
    assert.deepEqual([...mentionedAgentIds("@SEO check the titles", [...team, { id: "seo", name: "SEO-Expert" }])], ["seo"]);
    assert.equal(decideDelivery({ agentId: "architect", roster: team, threadType: "group", message: agent("@Architect decide", "builder"), agentStreak: 1 }).routeReason, "mention");
});

test("an exact name wins over a token alias", () => {
    const qa = [{ id: "qa", name: "QA" }, { id: "hqa", name: "Hermes-QA" }];
    assert.deepEqual([...mentionedAgentIds("@QA run the suite", qa)], ["qa"]);
    const builders = [{ id: "b", name: "Builder" }, { id: "mb", name: "Max Builder" }];
    assert.deepEqual([...mentionedAgentIds("@Builder ship it", builders)], ["b"]);
});

test("a token shared by several agents matches nobody", () => {
    const hermes = [{ id: "architect", name: "Hermes-Architect" }, { id: "hqa", name: "Hermes-QA" }];
    assert.equal(mentionedAgentIds("@Hermes anyone?", hermes).size, 0);
    assert.deepEqual([...mentionedAgentIds("@Hermes anyone?", [...hermes, { id: "h", name: "Hermes" }])], ["h"]);
});

test("tokens shorter than three characters never alias", () => {
    const roster2 = [{ id: "ux", name: "Hermes-UX" }];
    assert.equal(mentionedAgentIds("@UX review", roster2).size, 0);
    assert.deepEqual([...mentionedAgentIds("@Hermes review", roster2)], ["ux"]);
});

test("broadcast-style words never alias to a single agent", () => {
    const roster2 = [{ id: "dev", name: "Dev-Team" }, { id: "rounder", name: "Hermes All-Rounder" }];
    assert.equal(mentionedAgentIds("@team please look", roster2).size, 0);
    assert.equal(mentionedAgentIds("@all please look", roster2).size, 0);
    assert.deepEqual([...mentionedAgentIds("@Dev-Team please look", roster2)], ["dev"]);
});

test("token aliases can be turned off for partial rosters", () => {
    assert.equal(mentionedAgentIds("@Architect decide", [{ id: "architect", name: "Hermes-Architect" }], { tokenAliases: false }).size, 0);
    assert.deepEqual([...mentionedAgentIds("@Hermes-Architect decide", [{ id: "architect", name: "Hermes-Architect" }], { tokenAliases: false })], ["architect"]);
});
