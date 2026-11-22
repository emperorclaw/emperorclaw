import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { deliveryLabelKey, previewStatusKey } from "../../src/lib/chat/delivery-state";

// The four states the bridge writes through updateThreadExecutionState
// (EXECUTION_STATES in src/lib/project-workflow.ts).
test("a prompt the runtime has not taken reads Queued, one the bridge took reads Seen", () => {
    assert.equal(deliveryLabelKey("queued"), "queued", "offline host or a waiting turn keeps its own copy");
    assert.equal(deliveryLabelKey("seen"), "seen", "the bridge picked the prompt up: not Queued any more");
    assert.equal(deliveryLabelKey("acting"), "beingHandled", "the running turn keeps its pill");
    assert.equal(deliveryLabelKey("cancelled"), "cancelled");
});

test("resolved and unknown newer states never leak an empty label", () => {
    // resolved renders the thread-level Read/Sent receipt, never this footer.
    assert.equal(deliveryLabelKey("resolved"), "queued");
    assert.equal(deliveryLabelKey(null), "queued");
    assert.equal(deliveryLabelKey(undefined), "queued");
    assert.equal(deliveryLabelKey("some_future_state"), "queued");
});

test("the preview hides its Responding line only while the thinking row already says it", () => {
    assert.equal(previewStatusKey("running", true), null, "one indicator, not two");
    assert.equal(previewStatusKey("running", false), "responding", "still the only signal when the row is gone");
});

test("the preview keeps every settled and failure state, row or no row", () => {
    for (const row of [true, false]) {
        assert.equal(previewStatusKey("succeeded", row), "finishing");
        assert.equal(previewStatusKey("sealed", row), "stepComplete");
        assert.equal(previewStatusKey("capped", row), "previewCapped");
        assert.equal(previewStatusKey("failed", row), "interrupted");
        assert.equal(previewStatusKey("", row), "interrupted");
    }
});

test("the Seen label exists in both locales so the footer never renders a raw key", () => {
    for (const locale of ["en.json", "zh-CN.json"]) {
        const messages = JSON.parse(readFileSync(path.join(__dirname, "..", "..", "messages", locale), "utf8"));
        assert.equal(typeof messages.directChat.seen, "string", `${locale} has no directChat.seen`);
        assert.ok(messages.directChat.seen.trim().length > 0, `${locale} directChat.seen is empty`);
        assert.notEqual(messages.directChat.seen, messages.directChat.queued, `${locale}: Seen must not reuse Queued's copy`);
    }
});
