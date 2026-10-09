import { test } from "node:test";
import assert from "node:assert/strict";
import { parseObjectiveStatusMarker } from "../../src/lib/objective-status-marker";

test("parses an isolated objective-status marker and strips it from the text", () => {
    const { marker, strippedText } = parseObjectiveStatusMarker(
        'Progress: shipped the API.\nEMPEROR_OBJECTIVE_STATUS {"objectiveId":"obj-1","action":"complete","completionSummary":"Done"}',
    );
    assert.equal(marker?.objectiveId, "obj-1");
    assert.equal(marker?.action, "complete");
    assert.equal(marker?.completionSummary, "Done");
    assert.equal(strippedText, "Progress: shipped the API.");
});

test("preserves ordinary text when there is no marker", () => {
    const { marker, strippedText } = parseObjectiveStatusMarker("Just a normal reply with no control line.");
    assert.equal(marker, null);
    assert.equal(strippedText, "Just a normal reply with no control line.");
});

test("a malformed marker is left as ordinary text", () => {
    const original = 'EMPEROR_OBJECTIVE_STATUS {not json}';
    const { marker, strippedText } = parseObjectiveStatusMarker(original);
    assert.equal(marker, null);
    assert.equal(strippedText, original);
});

test("an unknown action is never recognized", () => {
    const original = 'EMPEROR_OBJECTIVE_STATUS {"objectiveId":"obj-1","action":"delete"}';
    const { marker, strippedText } = parseObjectiveStatusMarker(original);
    assert.equal(marker, null);
    assert.equal(strippedText, original);
});

test("a marker embedded in a sentence is not recognized", () => {
    const original = 'I will EMPEROR_OBJECTIVE_STATUS {"objectiveId":"obj-1","action":"complete"} now';
    const { marker } = parseObjectiveStatusMarker(original);
    assert.equal(marker, null);
});

test("block markers carry the reason and drop the marker line", () => {
    const { marker, strippedText } = parseObjectiveStatusMarker(
        'EMPEROR_OBJECTIVE_STATUS {"objectiveId":"obj-9","action":"block","blockerReason":"Waiting on legal"}',
    );
    assert.equal(marker?.action, "block");
    assert.equal(marker?.blockerReason, "Waiting on legal");
    assert.equal(strippedText, "");
});
