import { test } from "node:test";
import assert from "node:assert/strict";
import {
    agentMessageWakesAgent,
    agentStreakState,
    agentStreaks,
    decideDelivery,
    isLoopGuardResume,
    isNoWakeMessage,
    loopNotesResetEnabled,
    RESERVED_MESSAGE_METADATA_KEYS,
    streakProgressTimestamps,
    stripReservedMetadata,
    type StreakMessage,
} from "../../src/lib/message-routing";
import { deliveryVerdictCopy } from "../../src/lib/run-ledger-copy";

/**
 * 0.30 cost-brake slice: wake:false (FYI) posts, task notes no longer resetting
 * the loop streak by default, and server-only loop markers.
 */

const roster = [
    { id: "builder", name: "Builder" },
    { id: "architect", name: "Hermes-Architect" },
    { id: "qa", name: "QA" },
];

const fyi = (overrides: Record<string, unknown> = {}) => ({
    senderType: "agent",
    senderId: "builder",
    targetAgentId: null as string | null,
    text: "@Hermes-Architect FYI: deployed build 42.",
    metadataJson: { noWake: true } as unknown,
    ...overrides,
});

test("wake:false in a room: a mention wakes nobody (verdict fyi) and the message never forms a loop", () => {
    const message = fyi();
    assert.equal(agentMessageWakesAgent(message, roster, false), false);
    for (const agentId of ["architect", "qa"]) {
        assert.deepEqual(
            decideDelivery({ agentId, message, threadType: "group", roster, agentStreak: 1 }),
            { addressedToYou: false, routeReason: "fyi" },
        );
    }
    // Without the flag, the same mention wakes the architect.
    const loud = fyi({ metadataJson: {} });
    assert.equal(agentMessageWakesAgent(loud, roster, false), true);
    assert.equal(decideDelivery({ agentId: "architect", message: loud, threadType: "group", roster, agentStreak: 1 }).routeReason, "mention");
});

test("wake:false in a pair thread: the counterpart is not woken, even with a target set", () => {
    const message = fyi({ text: "Done, nothing else needed.", targetAgentId: "architect" });
    assert.equal(agentMessageWakesAgent(message, roster, true), false);
    assert.deepEqual(
        decideDelivery({ agentId: "architect", message, threadType: "group", roster, agentStreak: 1, isAgentPair: true }),
        { addressedToYou: false, routeReason: "fyi" },
    );
    // A normal pair post still wakes the counterpart.
    const loud = fyi({ text: "Can you check X?", metadataJson: {} });
    assert.equal(agentMessageWakesAgent(loud, roster, true), true);
    assert.equal(decideDelivery({ agentId: "architect", message: loud, threadType: "group", roster, agentStreak: 1, isAgentPair: true }).routeReason, "agent_pair");
});

test("wake:false posts neither count toward nor reset the streak", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 10, min));
    const msgs: StreakMessage[] = [
        { id: "a1", senderType: "agent", createdAt: at(0), wakesAgent: true },
        { id: "a2", senderType: "agent", createdAt: at(1), wakesAgent: agentMessageWakesAgent(fyi(), roster, true) },
        { id: "a3", senderType: "agent", createdAt: at(2), wakesAgent: true },
    ];
    const streaks = agentStreaks(msgs);
    assert.equal(streaks.get("a1"), 1);
    assert.equal(streaks.get("a2"), 1);
    assert.equal(streaks.get("a3"), 2);
});

test("a human's or system message never carries the FYI verdict (noWake is honored only on agent posts)", () => {
    const humanMessage = { senderType: "human", senderId: "u1", targetAgentId: null, text: "@Builder please look", metadataJson: { noWake: true } };
    assert.equal(decideDelivery({ agentId: "builder", message: humanMessage, threadType: "group", roster, agentStreak: 0 }).routeReason, "mention");
});

test("noWake, loopGuard and the cost-brake keys are reserved: callers cannot forge them", () => {
    for (const key of ["noWake", "loopGuard", "loopGuardResume", "costBrake", "costBrakeResume", "convertedFrom"]) {
        assert.ok((RESERVED_MESSAGE_METADATA_KEYS as readonly string[]).includes(key), key);
    }
    const stripped = stripReservedMetadata({ noWake: true, loopGuard: true, resumable: true, loopGuardResume: true, costBrakeResume: { extraTokens: 1 }, keep: 1 });
    assert.deepEqual(stripped, { resumable: true, keep: 1 });
    assert.equal(isNoWakeMessage({ noWake: true }), true);
    assert.equal(isNoWakeMessage({ noWake: "true" }), false);
});

test("a Resume marker resets the streak only on a system or human message; a forged agent marker is ignored", () => {
    assert.equal(isLoopGuardResume({ loopGuardResume: true }, "system"), true);
    assert.equal(isLoopGuardResume({ loopGuardResume: true }, "human"), true);
    assert.equal(isLoopGuardResume({ loopGuardResume: true }, "agent"), false);
    assert.equal(isLoopGuardResume({ loopGuardResume: true }, null), false);

    const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 10, min));
    const forged = { loopGuardResume: true };
    const msgs: StreakMessage[] = [1, 2, 3].map((n) => ({ id: `a${n}`, senderType: "agent", createdAt: at(n), wakesAgent: true }));
    // An agent post carrying the marker: counts as a normal agent message.
    msgs.push({ id: "forged", senderType: "agent", createdAt: at(4), wakesAgent: true, resumes: isLoopGuardResume(forged, "agent") });
    assert.equal(agentStreakState(msgs).streak, 4);
    // The real (system) marker resets.
    msgs.push({ id: "real", senderType: "system", createdAt: at(5), resumes: isLoopGuardResume(forged, "system") });
    msgs.push({ id: "a5", senderType: "agent", createdAt: at(6), wakesAgent: true });
    assert.equal(agentStreakState(msgs).streak, 1);
});

test("task notes no longer reset the streak unless EMPEROR_LOOP_NOTES_RESET=1", () => {
    const at = (min: number) => new Date(Date.UTC(2026, 10, 5, 10, min)).getTime();
    const msgs: StreakMessage[] = [0, 1, 2, 3, 4, 5].map((n) => ({ id: `a${n}`, senderType: "agent", createdAt: new Date(at(n)), wakesAgent: true }));
    const notes = [at(2.5)];
    const core: number[] = [];

    assert.equal(loopNotesResetEnabled({}), false);
    assert.equal(loopNotesResetEnabled({ EMPEROR_LOOP_NOTES_RESET: "0" }), false);
    assert.equal(loopNotesResetEnabled({ EMPEROR_LOOP_NOTES_RESET: "1" }), true);

    const off = streakProgressTimestamps(msgs, core, notes, {});
    assert.deepEqual(off, []);
    assert.equal(agentStreakState(msgs, off).streak, 6, "a note is not progress by default");

    const on = streakProgressTimestamps(msgs, core, notes, { EMPEROR_LOOP_NOTES_RESET: "1" });
    assert.equal(agentStreakState(msgs, on).streak, 3, "legacy: the note resets");

    // Core progress (a state change, an assignment, an artifact) always resets.
    const withCore = streakProgressTimestamps(msgs, [at(3.5)], notes, {});
    assert.equal(agentStreakState(msgs, withCore).streak, 2);
});

test("the delivery inspector names the fyi verdict", () => {
    assert.match(deliveryVerdictCopy({ routeReason: "fyi", addressed: false, agentStreak: 0, maxTurns: 12 }).label, /wake:false/);
});
