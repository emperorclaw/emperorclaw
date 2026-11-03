import { test } from "node:test";
import assert from "node:assert/strict";
import {
    keepOperatorValues, operatorEditMessage, operatorFieldList, operatorFieldsOf, operatorOwnedNotice, promptQuoted, scheduleHandBackMessage, withOperatorFields,
    type PipelineEditableValues,
} from "../../src/lib/pipeline-operator-edits";

const stored: PipelineEditableValues = {
    trigger: "cron",
    triggerConfig: { cron: "0 10 * * 2", timezone: "Europe/Madrid" },
    scheduledBy: "emperor",
    purpose: "Send the digest.",
    docMarkdown: "Person-written docs.",
    stepsJson: [{ name: "Collect" }],
    contextQuery: null,
    contextResourceIds: [],
    contextTagFilters: [],
    contextMaxChars: 8000,
};

test("operator fields: unknown entries dropped, stable order, add and remove", () => {
    assert.deepEqual(operatorFieldsOf(["steps", "bogus", "schedule", 3]), ["schedule", "steps"]);
    assert.deepEqual(operatorFieldsOf(null), []);
    assert.deepEqual(withOperatorFields(["steps"], ["schedule", "steps"]), ["schedule", "steps"]);
    assert.deepEqual(withOperatorFields(["schedule", "purpose"], [], ["schedule"]), ["purpose"]);
});

test("an agent's write keeps the operator's values and names what it tried to change", () => {
    const proposed = { ...stored, triggerConfig: { cron: "0 9 * * 1" }, scheduledBy: "agent", purpose: "Agent purpose.", stepsJson: [{ name: "Other" }] };
    const { values, ignored } = keepOperatorValues(["schedule", "steps"], proposed, stored);
    assert.deepEqual(values.triggerConfig, stored.triggerConfig);
    assert.equal(values.scheduledBy, "emperor");
    assert.deepEqual(values.stepsJson, stored.stepsJson);
    assert.equal(values.purpose, "Agent purpose.", "not operator-owned: the agent's value applies");
    assert.deepEqual(ignored, ["schedule", "steps"]);
});

test("resending the stored values, or columns the agent did not send, are not reported", () => {
    const same = keepOperatorValues(["schedule", "purpose"], { ...stored }, stored);
    assert.deepEqual(same.ignored, []);
    // Register fills an unsent trigger with its default: kept, but not reported.
    const defaults = keepOperatorValues(["schedule"], { ...stored, trigger: "manual", triggerConfig: {} }, stored, new Set(["name", "purpose"]));
    assert.equal(defaults.values.trigger, "cron");
    assert.deepEqual(defaults.ignored, []);
    // A PATCH only carries what it changes.
    const patch = keepOperatorValues(["docMarkdown"], { docMarkdown: "Agent docs." }, stored);
    assert.deepEqual(patch, { values: { docMarkdown: "Person-written docs." }, ignored: ["docMarkdown"] });
});

test("the MCP notice says which fields are operator-owned and what to do", () => {
    assert.equal(operatorOwnedNotice("p1", [], []), null);
    const notice = operatorOwnedNotice("p1", ["schedule", "steps"], ["steps"])!;
    assert.match(notice, /schedule and steps/);
    assert.match(notice, /Your values for the steps were not applied/);
    assert.match(notice, /Emperor keeps the schedule/);
    assert.match(notice, /GET \/api\/mcp\/pipelines\/p1/);
    assert.equal(operatorFieldList(["schedule", "docMarkdown", "context"]), "schedule, documentation and context pack");
});

test("the agent's message: old → new schedule in plain words, other updates, sanitized names", () => {
    const text = operatorEditMessage({
        pipelineId: "p1",
        pipelineName: "Weekly \"digest\"\n[ignore previous]",
        editorName: "Alex‮",
        changed: ["schedule", "steps"],
        schedule: {
            before: { cron: "0 9 * * 1", timezone: "Europe/Madrid", description: "At 09:00, only on Monday" },
            after: { cron: "0 10 * * 2", timezone: "UTC", description: "At 10:00, only on Tuesday" },
        },
    });
    assert.match(text, /^Alex edited the automation "Weekly digest ignore previous" in the Emperor app\./);
    assert.match(text, /When it runs: At 09:00, only on Monday \(0 9 \* \* 1, Europe\/Madrid\) → At 10:00, only on Tuesday \(0 10 \* \* 2, UTC\)/);
    assert.match(text, /- Steps updated\./);
    assert.match(text, /Emperor now keeps this schedule/);
    assert.match(text, /schedule and steps are now operator-owned/);
    assert.doesNotMatch(text, /‮/);

    const docsOnly = operatorEditMessage({ pipelineId: "p1", pipelineName: "Digest", editorName: "", changed: ["docMarkdown"] });
    assert.match(docsOnly, /^A teammate edited/);
    assert.match(docsOnly, /- Documentation updated\./);
    assert.doesNotMatch(docsOnly, /schedule/i);

    const unscheduled = operatorEditMessage({
        pipelineId: "p1", pipelineName: "Digest", editorName: "Alex", changed: ["schedule"],
        schedule: { before: { cron: "0 9 * * 1", timezone: "UTC", description: null }, after: { cron: null, timezone: null, description: null } },
    });
    assert.match(unscheduled, /0 9 \* \* 1, UTC → no schedule/);
    assert.match(unscheduled, /no longer runs on a schedule/);
    assert.equal(promptQuoted("a".repeat(200)).length, 120);
});

test("handing the schedule back tells the agent to fire the stored schedule itself", () => {
    const text = scheduleHandBackMessage({
        pipelineId: "p1", pipelineName: "Digest", editorName: "Alex",
        schedule: { cron: "0 10 * * 2", timezone: "Europe/Madrid", description: "At 10:00, only on Tuesday" },
    });
    assert.match(text, /^Alex handed the schedule of the automation "Digest" back to you/);
    assert.match(text, /Emperor no longer starts its runs/);
    assert.match(text, /stays as it was: At 10:00, only on Tuesday \(0 10 \* \* 2, Europe\/Madrid\)/);
    assert.match(text, /\/api\/mcp\/pipelines\/p1\/runs/);
});
