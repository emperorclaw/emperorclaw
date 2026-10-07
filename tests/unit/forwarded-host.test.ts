import { test } from "node:test";
import assert from "node:assert/strict";
import { firstForwardedHost } from "../../src/lib/env";

test("firstForwardedHost returns the first entry of a comma-separated list", () => {
    assert.equal(firstForwardedHost("app.example.com, proxy.internal, proxy2.internal"), "app.example.com");
    assert.equal(firstForwardedHost("a.example.com, b.example.com"), "a.example.com");
});

test("firstForwardedHost handles a single host and trims whitespace", () => {
    assert.equal(firstForwardedHost("app.example.com"), "app.example.com");
    assert.equal(firstForwardedHost(" app.example.com , other.example.com"), "app.example.com");
});

test("firstForwardedHost returns null for empty/absent input", () => {
    assert.equal(firstForwardedHost(null), null);
    assert.equal(firstForwardedHost(undefined), null);
    assert.equal(firstForwardedHost(""), null);
    assert.equal(firstForwardedHost("   "), null);
});
