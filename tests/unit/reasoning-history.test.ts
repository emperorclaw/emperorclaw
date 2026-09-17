import { test } from "node:test";
import assert from "node:assert/strict";

import {
    REASONING_HISTORY_MAX_CHARS,
    truncateReasoningForStorage,
} from "../../src/lib/reasoning-history";

test("text under the cap is stored verbatim, trimmed", () => {
    assert.equal(truncateReasoningForStorage("  I should read the config first.  "), "I should read the config first.");
});

test("a runaway turn is capped and the cut is visible", () => {
    const stored = truncateReasoningForStorage("thinking ".repeat(100_000));
    assert.ok(stored);
    assert.ok(stored.length <= REASONING_HISTORY_MAX_CHARS);
    assert.ok(stored.endsWith("[reasoning truncated]"));
});

test("the server cap does not trust a client's length", () => {
    // The bridge caps before sending; this assertion is about the server-side
    // cap holding even when a client sends far more than it claims to.
    const stored = truncateReasoningForStorage("x".repeat(REASONING_HISTORY_MAX_CHARS * 4));
    assert.ok(stored!.length <= REASONING_HISTORY_MAX_CHARS);
});

test("nothing worth storing yields null so the write is skipped", () => {
    assert.equal(truncateReasoningForStorage(""), null);
    assert.equal(truncateReasoningForStorage("   \n  "), null);
    assert.equal(truncateReasoningForStorage(undefined), null);
    assert.equal(truncateReasoningForStorage(null), null);
    assert.equal(truncateReasoningForStorage(42), null);
});
