import { test } from "node:test";
import assert from "node:assert/strict";
import {
    brakeLevel,
    costBrakeLimits,
    costBrakeMode,
    DEFAULT_COST_BRAKE_LIMITS,
    episodeStart,
    evaluatePairEpisode,
    evaluateTaskScope,
    pairEpisodeKey,
    shadowLogLine,
    stallTurns,
    wouldBrakeDedupeKey,
    type A2aRun,
} from "../../src/lib/cost-brake";

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 1, 9, 0);
const at = (min: number) => T0 + min * MIN;
const limits = DEFAULT_COST_BRAKE_LIMITS;

let seq = 0;
function run(overrides: Partial<A2aRun> & { startMin: number }): A2aRun {
    const { startMin, ...rest } = overrides;
    seq += 1;
    return {
        id: `r${seq}`,
        agentId: seq % 2 ? "builder" : "architect",
        wakerId: seq % 2 ? "architect" : "builder",
        threadId: "pair-thread",
        taskId: null,
        tokens: 1_500_000,
        startedAt: at(startMin),
        endedAt: at(startMin + 10),
        progressed: false,
        ...rest,
    };
}

test("mode and limits come from env, validated, defaulting to shadow and the design defaults", () => {
    assert.equal(costBrakeMode({}), "shadow");
    assert.equal(costBrakeMode({ EMPEROR_COST_BRAKE_MODE: "off" }), "off");
    assert.equal(costBrakeMode({ EMPEROR_COST_BRAKE_MODE: "OFF " }), "off");
    assert.equal(costBrakeMode({ EMPEROR_COST_BRAKE_MODE: "enforce" }), "shadow", "no enforce path yet");
    assert.deepEqual(costBrakeLimits({}), { pairTokens: 8_000_000, taskTokens: 25_000_000, stallTurns: 4, softPct: 70 });
    assert.deepEqual(
        costBrakeLimits({ EMPEROR_COST_BRAKE_PAIR_TOKENS: "4000000", EMPEROR_COST_BRAKE_STALL_TURNS: "abc", EMPEROR_COST_BRAKE_SOFT_PCT: "150" }),
        { pairTokens: 4_000_000, taskTokens: 25_000_000, stallTurns: 4, softPct: 70 },
    );
});

test("brakeLevel: soft at 70%, hard at 100% of tokens; stall soft at limit-1, hard at limit", () => {
    assert.deepEqual(brakeLevel({ usedTokens: 5_000_000, limitTokens: 8_000_000, softPct: 70 }), { level: "ok", reasons: [] });
    assert.deepEqual(brakeLevel({ usedTokens: 5_600_000, limitTokens: 8_000_000, softPct: 70 }), { level: "soft", reasons: ["tokens"] });
    assert.deepEqual(brakeLevel({ usedTokens: 8_000_000, limitTokens: 8_000_000, softPct: 70 }), { level: "hard", reasons: ["tokens"] });
    assert.deepEqual(brakeLevel({ usedTokens: 0, limitTokens: 8_000_000, softPct: 70, stall: 3, stallLimit: 4 }), { level: "soft", reasons: ["stall"] });
    assert.deepEqual(brakeLevel({ usedTokens: 9_000_000, limitTokens: 8_000_000, softPct: 70, stall: 4, stallLimit: 4 }), { level: "hard", reasons: ["tokens", "stall"] });
});

test("stallTurns counts trailing no-progress runs; any progress (an artifact too) resets it", () => {
    assert.equal(stallTurns([]), 0);
    assert.equal(stallTurns([{ startedAt: 1, progressed: false }, { startedAt: 2, progressed: true }, { startedAt: 3, progressed: false }, { startedAt: 4, progressed: false }]), 2);
    assert.equal(stallTurns([{ startedAt: 4, progressed: true }, { startedAt: 1, progressed: false }]), 0, "order-independent");
});

test("a slow loop still brakes: one exchange every 20 minutes, no progress, no human", () => {
    const runs = [0, 20, 40, 60].map((m) => run({ startMin: m, tokens: 1_000_000 }));
    const evaluation = evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs, renewal: { resets: [] }, limits, windowStart: at(-60) });
    assert.equal(evaluation.stallTurns, 4);
    assert.equal(evaluation.level, "hard");
    assert.deepEqual(evaluation.reasons, ["stall"]);
    assert.equal(evaluation.usedTokens, 4_000_000);
});

test("tokens cross the pair limit even when some runs progressed (artifacts reset stall, not budget)", () => {
    const runs = [0, 10, 20, 30, 40, 50].map((m, i) => run({ startMin: m, progressed: i === 4 }));
    const evaluation = evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs, renewal: { resets: [] }, limits, windowStart: at(-60) });
    assert.equal(evaluation.usedTokens, 9_000_000);
    assert.equal(evaluation.stallTurns, 1);
    assert.equal(evaluation.level, "hard");
    assert.deepEqual(evaluation.reasons, ["tokens"]);
});

test("a human message or Resume starts a fresh episode; time alone never does", () => {
    const runs = [0, 10, 20, 30, 40, 50].map((m) => run({ startMin: m }));
    const human = evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs, renewal: { resets: [at(35)] }, limits, windowStart: at(-60) });
    assert.equal(human.episodeStart, at(35));
    assert.equal(human.runs, 2);
    assert.equal(human.level, "ok");
    // Five hours of quiet in the middle: still one episode.
    const slow = [0, 300, 600, 900].map((m) => run({ startMin: m }));
    assert.equal(evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs: slow, renewal: { resets: [] }, limits, windowStart: at(-60) }).episodeStart, at(0), "anchored on its first run");
});

test("renewal by task progress: only a state the task has not had since the last reset", () => {
    const w = at(0);
    // inbox -> in_progress (new: renews), -> blocked (new: renews), -> in_progress (seen: no renew)
    assert.equal(episodeStart({ resets: [], initialState: "inbox", stateChanges: [{ at: at(10), state: "in_progress" }] }, w), at(10));
    assert.equal(episodeStart({ resets: [], initialState: "inbox", stateChanges: [
        { at: at(10), state: "in_progress" }, { at: at(20), state: "blocked" }, { at: at(30), state: "in_progress" }, { at: at(40), state: "blocked" },
    ] }, w), at(20), "repeated flips between the same states never renew again");
    // A human touch clears the seen set: the next new state renews.
    assert.equal(episodeStart({ resets: [at(25)], initialState: "inbox", stateChanges: [
        { at: at(10), state: "in_progress" }, { at: at(20), state: "blocked" }, { at: at(30), state: "in_progress" },
    ] }, w), at(30));
});

test("in_progress <-> review flips never renew, even the first time", () => {
    const w = at(0);
    assert.equal(episodeStart({ resets: [], initialState: "in_progress", stateChanges: [{ at: at(10), state: "review" }] }, w), w);
    assert.equal(episodeStart({ resets: [], initialState: "in_progress", stateChanges: [
        { at: at(10), state: "review" }, { at: at(20), state: "in_progress" }, { at: at(30), state: "review" }, { at: at(40), state: "in_progress" },
    ] }, w), w);
    // review -> done is genuine progress.
    assert.equal(episodeStart({ resets: [], initialState: "in_progress", stateChanges: [{ at: at(10), state: "review" }, { at: at(20), state: "done" }] }, w), at(20));
    // A same-state "change" is no change.
    assert.equal(episodeStart({ resets: [], initialState: "blocked", stateChanges: [{ at: at(10), state: "blocked" }] }, w), w);
});

test("review ping-pong on a task still brakes: the flips do not renew the pair budget", () => {
    const runs = [0, 10, 20, 30, 40, 50].map((m) => run({ startMin: m, taskId: "t1" }));
    const evaluation = evaluatePairEpisode({
        agentA: "architect", agentB: "builder", taskId: "t1", runs,
        renewal: { resets: [], initialState: "in_progress", stateChanges: [15, 25, 35, 45].map((m, i) => ({ at: at(m), state: i % 2 ? "in_progress" : "review" })) },
        limits, windowStart: at(-60),
    });
    assert.equal(evaluation.usedTokens, 9_000_000);
    assert.equal(evaluation.level, "hard");
});

test("state progress never renews a task-less (chat) pair episode", () => {
    const runs = [0, 10, 20, 30, 40, 50].map((m) => run({ startMin: m }));
    const evaluation = evaluatePairEpisode({
        agentA: "builder", agentB: "architect", taskId: null, runs,
        renewal: { resets: [], stateChanges: [{ at: at(35), state: "done" }] },
        limits, windowStart: at(-60),
    });
    assert.equal(evaluation.episodeStart, at(0));
});

test("moving to a new or private thread does not open a fresh pair budget", () => {
    // Same pair, three threads (team room, a private pair thread, another group).
    const runs = [
        run({ startMin: 0, threadId: "team" }), run({ startMin: 10, threadId: "team" }),
        run({ startMin: 20, threadId: "private-pair" }), run({ startMin: 30, threadId: "private-pair" }),
        run({ startMin: 40, threadId: "group-2" }), run({ startMin: 50, threadId: "group-2" }),
    ];
    const evaluation = evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs, renewal: { resets: [] }, limits, windowStart: at(-60) });
    assert.equal(evaluation.runs, 6);
    assert.equal(evaluation.usedTokens, 9_000_000);
    assert.equal(evaluation.level, "hard");
    // The key ignores the thread and the direction of the pair.
    assert.equal(pairEpisodeKey("builder", "architect", null), pairEpisodeKey("architect", "builder", null));
    assert.notEqual(pairEpisodeKey("builder", "architect", "t1"), pairEpisodeKey("builder", "architect", null));
});

test("the pair episode ignores runs of other pairs and other tasks", () => {
    const runs = [
        run({ startMin: 0, tokens: 7_000_000 }),
        run({ startMin: 5, tokens: 7_000_000, agentId: "qa", wakerId: "builder" }),
        run({ startMin: 6, tokens: 7_000_000, taskId: "t2" }),
    ];
    const evaluation = evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs, renewal: { resets: [] }, limits, windowStart: at(-60) });
    assert.equal(evaluation.runs, 1);
    assert.equal(evaluation.level, "soft");
});

test("task scope sums every pair on the task and renews only on a human touch", () => {
    const runs = [
        ...[0, 10, 20, 30, 40, 50, 60, 70, 80].map((m) => run({ startMin: m, taskId: "t1", tokens: 2_000_000 })),
        ...[5, 15, 25, 35, 45, 55, 65, 75].map((m) => run({ startMin: m, taskId: "t1", tokens: 1_000_000, agentId: "qa", wakerId: "builder" })),
        run({ startMin: 90, taskId: "other", tokens: 50_000_000 }),
    ];
    const evaluation = evaluateTaskScope({ taskId: "t1", agentA: "builder", agentB: "architect", runs, resets: [], limits, windowStart: at(-60) });
    assert.equal(evaluation.usedTokens, 26_000_000);
    assert.equal(evaluation.level, "hard");
    assert.equal(evaluation.stallLimit, null);
    const touched = evaluateTaskScope({ taskId: "t1", agentA: "builder", agentB: "architect", runs, resets: [at(42)], limits, windowStart: at(-60) });
    assert.equal(touched.usedTokens, 12_000_000);
    assert.equal(touched.level, "ok");
});

test("the would-brake identity is per scope episode, and the log line is structured", () => {
    const runs = [0, 20, 40, 60].map((m) => run({ startMin: m }));
    const evaluation = evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs, renewal: { resets: [] }, limits, windowStart: at(-60) });
    assert.equal(wouldBrakeDedupeKey(evaluation), `pair:architect:builder:chat:${at(0)}`);
    // A later evaluation (the window start moved) keeps the same identity.
    const later = evaluatePairEpisode({ agentA: "builder", agentB: "architect", taskId: null, runs, renewal: { resets: [] }, limits, windowStart: at(-30) });
    assert.equal(wouldBrakeDedupeKey(later), wouldBrakeDedupeKey(evaluation));
    const line = shadowLogLine(evaluation, { companyId: "c1", runId: "r9", threadId: "pair-thread" });
    assert.ok(line.startsWith("[cost-brake] shadow would-brake {"));
    const payload = JSON.parse(line.slice(line.indexOf("{")));
    assert.equal(payload.scope, "pair");
    assert.deepEqual(payload.reasons, ["stall"]);
    assert.equal(payload.stallTurns, 4);
});
