import { test } from "node:test";
import assert from "node:assert/strict";
import {
    clampCadenceMinutes,
    clampMaxFollowups,
    objectiveFollowupText,
    objectiveStatusText,
    parseObjectiveCommand,
    OBJECTIVE_DEFAULT_CADENCE_MINUTES,
    OBJECTIVE_MAX_CADENCE_MINUTES,
    OBJECTIVE_MIN_CADENCE_MINUTES,
} from "../../src/lib/agent-objective";

test("parseObjectiveCommand: /goal starts an objective (Emperor-owned)", () => {
    assert.deepEqual(parseObjectiveCommand("/goal Ship the report"), { action: "start", objective: "Ship the report" });
    assert.deepEqual(parseObjectiveCommand("/objective Ship the report"), { action: "start", objective: "Ship the report" });
    // A literal objective that begins with dashes is not a flag.
    assert.deepEqual(parseObjectiveCommand("/goal -- actually keep going"), { action: "start", objective: "actually keep going" });
});

test("parseObjectiveCommand: control words map to actions", () => {
    assert.equal(parseObjectiveCommand("/goal status")?.action, "status");
    assert.equal(parseObjectiveCommand("/goal show")?.action, "status");
    assert.equal(parseObjectiveCommand("/goal")?.action, "status");
    assert.equal(parseObjectiveCommand("/goal pause")?.action, "pause");
    assert.equal(parseObjectiveCommand("/goal resume")?.action, "resume");
    assert.equal(parseObjectiveCommand("/goal clear")?.action, "stop");
    assert.equal(parseObjectiveCommand("/goal stop")?.action, "stop");
    assert.equal(parseObjectiveCommand("/goal done")?.action, "complete");
    assert.equal(parseObjectiveCommand("/goal draft something")?.action, "unsupported");
});

test("parseObjectiveCommand: non-commands are ignored", () => {
    assert.equal(parseObjectiveCommand("hello"), null);
    assert.equal(parseObjectiveCommand("goal: do it"), null);
});

test("cadence and budget are clamped to safe bounds", () => {
    assert.equal(clampCadenceMinutes(undefined), OBJECTIVE_DEFAULT_CADENCE_MINUTES);
    assert.equal(clampCadenceMinutes(1), OBJECTIVE_MIN_CADENCE_MINUTES);
    assert.equal(clampCadenceMinutes(9999999), OBJECTIVE_MAX_CADENCE_MINUTES);
    assert.equal(clampCadenceMinutes(90), 90);
    assert.equal(clampMaxFollowups(0), 1);
    assert.equal(clampMaxFollowups(9999), 100);
});

test("objectiveFollowupText carries compact instructions, the tool and the tool-less fallback", () => {
    const text = objectiveFollowupText({ id: "obj-123", objective: "Publish the beta", cadenceMinutes: 60, followupCount: 2, maxFollowups: 20 });
    assert.match(text, /Publish the beta/);
    assert.match(text, /followup 3\/20/);
    assert.match(text, /update_objective/);
    assert.match(text, /blockerReason/);
    assert.match(text, /completionSummary/);
    // The tool-less fallback marker is present, carries the objective id, and
    // is taught as an isolated last line.
    assert.match(text, /EMPEROR_OBJECTIVE_STATUS \{"objectiveId":"obj-123"/);
});

test("objectiveStatusText describes status, blocker and completion", () => {
    assert.match(objectiveStatusText(null), /No objective/);
    const text = objectiveStatusText({
        id: "o1", objective: "Publish the beta", status: "blocked", cadenceMinutes: 60,
        maxFollowups: 20, followupCount: 3, blockerReason: "Waiting on legal", completionSummary: null,
        lastPromptAt: null, nextRunAt: null, startedAt: new Date(), completedAt: null, updatedAt: new Date(),
    });
    assert.match(text, /Status: blocked/);
    assert.match(text, /Blocker: Waiting on legal/);
    assert.match(text, /followups 3\/20/);
});
