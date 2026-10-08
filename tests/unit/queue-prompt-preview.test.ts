import { strict as assert } from "node:assert";
import { test } from "node:test";
import { queuePromptPreview } from "../../src/lib/queue-prompt-preview";

test("queue labels hide code payloads and audio URLs", () => {
    assert.equal(queuePromptPreview("```json\n{\"internal\":true}\n```"), "Code or structured content");
    assert.equal(queuePromptPreview("[audio:/api/private/file]"), "Voice message");
    assert.equal(queuePromptPreview("## Review [report](/private/file)\n**today**"), "Review report today");
});
test("queue labels bound large prompts without changing the source", () => {
    const text = "🙂".repeat(10000);
    assert.equal(Array.from(queuePromptPreview(text)).length, 140);
    assert.equal(text.length, 20000);
});
