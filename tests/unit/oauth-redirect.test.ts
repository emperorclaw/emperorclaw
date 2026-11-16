import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowedRedirectUri } from "../../src/lib/oauth-redirect";

test("https redirect URIs are allowed", () => {
    assert.equal(isAllowedRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
});

test("loopback http redirect URIs are allowed for native clients like `codex mcp login` (RFC 8252)", () => {
    for (const uri of ["http://127.0.0.1:53682/callback", "http://localhost:8976/callback", "http://[::1]:4000/cb", "http://LOCALHOST/cb", "http://[0:0:0:0:0:0:0:1]/cb", "HTTPS://example.com/cb"]) {
        assert.equal(isAllowedRedirectUri(uri), true, uri);
    }
});

test("non-loopback http, other schemes, fragments, credentials and junk are refused", () => {
    for (const uri of [
        "http://example.com/callback",
        "http://127.0.0.1.evil.com/callback",
        "http://localhost.evil.com/callback",
        "http://localhost./callback",
        "http://user@127.0.0.1/callback",
        "http://10.0.0.5/callback",
        "javascript:alert(1)",
        "custom-app://callback",
        "https://example.com/cb#frag",
        "https://user:pw@example.com/cb",
        "not a url",
        "",
        42,
        null,
    ]) {
        assert.equal(isAllowedRedirectUri(uri), false, String(uri));
    }
});
