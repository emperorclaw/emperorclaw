import test from "node:test";
import assert from "node:assert/strict";
import { directThreadLink, isDirectChatMode, normalizeDirectChatMode, operationsThreadTitle, singleHumanOwner } from "../../src/lib/direct-chat-mode";

test("normalizeDirectChatMode reads only 'private' as private", () => {
    assert.equal(normalizeDirectChatMode("private"), "private");
    assert.equal(normalizeDirectChatMode("shared"), "shared");
    assert.equal(normalizeDirectChatMode(undefined), "shared");
    assert.equal(normalizeDirectChatMode("PRIVATE"), "shared");
});

test("isDirectChatMode accepts exactly the two modes", () => {
    assert.ok(isDirectChatMode("shared"));
    assert.ok(isDirectChatMode("private"));
    assert.ok(!isDirectChatMode("team"));
    assert.ok(!isDirectChatMode(null));
});

test("operationsThreadTitle names the agent, with a fallback", () => {
    assert.equal(operationsThreadTitle("Scout"), "Scout · Operations");
    assert.equal(operationsThreadTitle("  "), "Agent · Operations");
    assert.equal(operationsThreadTitle(null), "Agent · Operations");
});

test("singleHumanOwner returns the one person behind every item, else null", () => {
    assert.equal(singleHumanOwner(["u1", "u1"]), "u1");
    assert.equal(singleHumanOwner(["u1", "u2"]), null, "a mixed batch goes to the Operations thread");
    assert.equal(singleHumanOwner(["u1", null]), null, "an item nobody owns makes the batch shared");
    assert.equal(singleHumanOwner([]), null);
});

test("directThreadLink names the exact thread and keeps the agent link", () => {
    assert.equal(directThreadLink("t1", "a1"), "/messages?agent=a1&thread=t1");
    assert.equal(directThreadLink("t1", null), "/messages?thread=t1");
});
