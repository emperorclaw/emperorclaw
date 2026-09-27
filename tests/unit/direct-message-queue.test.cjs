const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("direct chat exposes a per-message queue instead of only a global stop", () => {
    const ui = read("src/components/agent-direct-chat.tsx");
    assert.match(ui, /Message queue/);
    assert.match(ui, /Handling now/);
    assert.match(ui, /onCancel/);
    assert.match(ui, /onRetry/);
});

test("queue mutations are sender-scoped and state-guarded", () => {
    const service = read("src/lib/direct-message-queue.ts");
    assert.match(service, /eq\(threadMessages\.senderId, input\.userId\)/);
    assert.match(service, /inArray\(threadMessages\.deliveryState, fromStates\)/);
    assert.match(service, /"cancelled"/);
    assert.match(service, /"queued"/);
});

test("direct-chat duplicate prompts are rejected while still outstanding", () => {
    const route = read("src/app/api/chat/route.ts");
    assert.match(route, /normalizedPrompt/);
    assert.match(route, /\["queued", "seen", "acting"\]/);
    assert.match(route, /deduplicated: true/);
});
