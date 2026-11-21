import test from "node:test";
import assert from "node:assert/strict";
import { loginDestination } from "../../src/lib/login-destination";

test("login returns to mobile/MCP consent and preserves the pending state", () => {
    const path = "/mobile/authorize?challenge=abc&state=def&deviceName=iPhone";
    assert.equal(loginDestination(path, "https://example.com"), path);
    assert.equal(loginDestination(`https://example.com${path}`, "https://example.com"), path);
    assert.equal(loginDestination("/authorize?state=mcp", "https://example.com"), "/authorize?state=mcp");
});

test("login rejects external origins, credentials, scheme tricks and login loops", () => {
    for (const target of [null, "", "https://evil.test", "//evil.test", "https://example.com.evil.test/", "https://example.com:444/", "http://example.com", "https://user:pass@example.com", "javascript:alert(1)", "/\\evil.test", "/\nevil.test", "/login?callbackUrl=/", "/signup"]) {
        assert.equal(loginDestination(target, "https://example.com"), "/", String(target));
    }
});
