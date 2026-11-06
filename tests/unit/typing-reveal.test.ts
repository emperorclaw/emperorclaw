import { test } from "node:test";
import assert from "node:assert/strict";
import {
    REVEAL_FRESH_MS,
    REVEAL_MAX_MS,
    REVEAL_MIN_MS,
    isFreshMessage,
    revealDurationMs,
    revealStartOf,
    revealedText,
    wordEnds,
    markLiveReveal,
} from "../../src/lib/typing-reveal";

test("wordEnds: each word with its trailing whitespace", () => {
    assert.deepEqual(wordEnds("Hello  big\nworld"), [7, 11, 16]);
    assert.deepEqual(wordEnds("   "), []);
    assert.deepEqual(wordEnds(""), []);
});

test("revealDurationMs is clamped between the min and the max", () => {
    assert.equal(revealDurationMs("hi"), REVEAL_MIN_MS);
    assert.equal(revealDurationMs(""), REVEAL_MIN_MS);
    assert.equal(revealDurationMs("word ".repeat(5000)), REVEAL_MAX_MS);
    const mid = revealDurationMs("word ".repeat(20));
    assert.ok(mid > REVEAL_MIN_MS && mid < REVEAL_MAX_MS, String(mid));
});

test("revealedText grows by whole words and ends with the exact text", () => {
    const text = "One two three four **five**";
    const duration = 1000;
    assert.equal(revealedText(text, 0, duration), "");
    assert.equal(revealedText(text, 200, duration), "One");
    assert.equal(revealedText(text, 500, duration), "One two three");
    assert.equal(revealedText(text, 1000, duration), text);
    assert.equal(revealedText(text, 5000, duration), text);
    let previous = "";
    for (let t = 0; t <= duration; t += 50) {
        const shown = revealedText(text, t, duration);
        assert.ok(text.startsWith(shown), "always a prefix");
        assert.ok(shown.length >= previous.length, "never shrinks");
        previous = shown;
    }
});

test("isFreshMessage: only a recent message animates", () => {
    const now = Date.parse("2026-11-06T12:00:00Z");
    assert.equal(isFreshMessage(new Date(now - 1000).toISOString(), now), true);
    assert.equal(isFreshMessage(new Date(now - REVEAL_FRESH_MS - 1).toISOString(), now), false);
    assert.equal(isFreshMessage(null, now), false);
    assert.equal(isFreshMessage("not a date", now), false);
});

test("markLiveReveal does nothing on the server", () => {
    markLiveReveal([{ id: "m1", senderType: "agent", text: "hi", createdAt: new Date() }]);
    assert.equal(revealStartOf("m1"), null);
});
