import test from "node:test";
import assert from "node:assert/strict";
import { isRuntimeRoutingName, validateSecretName, validateSecretValue } from "../../src/lib/agent-secrets";

test("secret names accept uppercase env-style identifiers", () => {
    for (const name of ["A_", "X1", "API_KEY", "OPENAI_API_KEY", "A".repeat(64)]) {
        assert.deepEqual(validateSecretName(name), { ok: true, name }, name);
    }
});

test("secret names reject anything outside the uppercase env pattern", () => {
    for (const name of ["A", "", "api_key", "ApiKey", "1KEY", "_KEY", "KEY-NAME", "KEY NAME", "A".repeat(65)]) {
        assert.equal(validateSecretName(name).ok, false, JSON.stringify(name));
    }
    assert.equal(validateSecretName(null).ok, false);
    assert.equal(validateSecretName(42).ok, false);
});

test("reserved names and prefixes are rejected", () => {
    for (const name of [
        "PATH", "HOME", "USER", "SHELL", "LANG", "TERM", "TMPDIR", "PYTHONPATH", "VIRTUAL_ENV", "PYTHONHOME",
        "LD_PRELOAD", "LD_LIBRARY_PATH", "NODE_OPTIONS",
        "ENV", "IFS", "BASH_ENV", "PS4", "PROMPT_COMMAND", "SSH_AUTH_SOCK", "SSH_ASKPASS", "EDITOR", "VISUAL", "PAGER",
    ]) {
        assert.equal(validateSecretName(name).ok, false, name);
    }
    for (const name of [
        "EMPEROR_CLAW_TOKEN", "EMPEROR_SECRET", "MCP_EMPERORCLAW_TOKEN", "HERMES_PROFILE", "HERMES_HOME_DIR",
        "LD_SOMETHING", "DYLD_INSERT_LIBRARIES", "PYTHONSTARTUP", "GIT_CONFIG_COUNT", "NODE_PATH",
        "NPM_CONFIG_TOKEN", "BASH_FUNC_MAIN",
    ]) {
        assert.equal(validateSecretName(name).ok, false, name);
    }
    assert.equal(validateSecretName("PATH_TO_FILE").ok, true, "the prefix rule is exact, not a PATH prefix");
});

test("runtime routing names are recognized", () => {
    for (const name of [
        "OPENAI_BASE_URL", "SOME_API_BASE", "SOME_API_URL", "MY_ENDPOINT", "HTTPS_PROXY", "CUSTOM_HOST",
        "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "NO_PROXY",
    ]) {
        assert.equal(isRuntimeRoutingName(name), true, name);
        assert.equal(validateSecretName(name).ok, true, `${name} is valid, just admin-only`);
    }
    for (const name of ["API_KEY", "BASE_URL_VALUE_EXTRA", "TOKEN"]) {
        assert.equal(isRuntimeRoutingName(name), false, name);
    }
});

test("secret values accept non-empty single-line strings up to 8192 characters", () => {
    assert.deepEqual(validateSecretValue("x"), { ok: true, value: "x" });
    assert.deepEqual(validateSecretValue("sk-live with spaces=and/slashes"), { ok: true, value: "sk-live with spaces=and/slashes" });
    assert.deepEqual(validateSecretValue("a".repeat(8192)), { ok: true, value: "a".repeat(8192) });
});

test("secret values reject empty, oversized, multi-line and non-string values", () => {
    for (const value of ["", "a".repeat(8193), "line\nbreak", "carriage\rreturn", "null\0byte"]) {
        assert.equal(validateSecretValue(value).ok, false, JSON.stringify(value).slice(0, 40));
    }
    assert.equal(validateSecretValue(null).ok, false);
    assert.equal(validateSecretValue({ value: "x" }).ok, false);
});

test("secret values reject every control character and line separator", () => {
    const rejected = [
        ...Array.from({ length: 0x20 }, (_, code) => `a${String.fromCharCode(code)}b`),
        "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b",
    ];
    for (const value of rejected) {
        const result = validateSecretValue(value);
        assert.equal(result.ok, false, JSON.stringify(value));
        if (!result.ok) {
            assert.equal(result.error, "The secret value cannot contain control characters or line separators.");
        }
    }
    assert.equal(validateSecretValue("a\tb").ok, false, "a tab is a control character too");
});
