import { test } from "node:test";
import assert from "node:assert/strict";
import { llmSecretPayload, normalizeLlmBaseUrl, parseLlmSecret } from "../../src/lib/llm-endpoint";
import { runtimeSetupOf } from "../../src/lib/runtime-setup";
import { providerTroubleFromRuns, providerTroubleLabel } from "../../src/lib/provider-trouble";

test("base URL: http(s) only, normalized without a trailing slash", () => {
    assert.deepEqual(normalizeLlmBaseUrl(" http://host.docker.internal:11434/v1/ "), { ok: true, url: "http://host.docker.internal:11434/v1", hint: null });
    assert.deepEqual(normalizeLlmBaseUrl("https://llm.example.com/openai/v1"), { ok: true, url: "https://llm.example.com/openai/v1", hint: null });
    for (const bad of ["", "llm.example.com/v1", "ftp://x/v1", "file:///etc/passwd", "javascript:alert(1)"]) {
        assert.equal(normalizeLlmBaseUrl(bad).ok, false, bad);
    }
    assert.equal(normalizeLlmBaseUrl("https://user:pw@llm.example.com/v1").ok, false, "credentials belong in the key field");
    assert.equal(normalizeLlmBaseUrl("https://llm.example.com/v1?key=x").ok, false);
    assert.equal(normalizeLlmBaseUrl(`https://x.example/${"a".repeat(600)}`).ok, false);
});

test("base URL: localhost is accepted with the host.docker.internal hint", () => {
    for (const raw of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://[::1]:8000/v1"]) {
        const checked = normalizeLlmBaseUrl(raw);
        assert.equal(checked.ok, true, raw);
        if (checked.ok) assert.match(checked.hint ?? "", /host\.docker\.internal/, raw);
    }
    const checked = normalizeLlmBaseUrl("http://localhost:11434/v1");
    assert.ok(checked.ok && checked.hint?.includes("http://host.docker.internal:11434/v1"));
});

test("LLM secret payload carries the key and the base URL", () => {
    assert.deepEqual(llmSecretPayload({ apiKey: " sk-1 ", baseUrl: "http://h/v1" }), { apiKey: "sk-1", baseUrl: "http://h/v1" });
    assert.deepEqual(llmSecretPayload({ baseUrl: "http://h/v1" }), { baseUrl: "http://h/v1" });
    assert.equal(llmSecretPayload({ apiKey: "  " }), null);
    assert.deepEqual(parseLlmSecret({ apiKey: "sk-1" }), { apiKey: "sk-1", baseUrl: null });
    assert.deepEqual(parseLlmSecret({ baseUrl: "http://h/v1" }), { apiKey: null, baseUrl: "http://h/v1" });
    assert.deepEqual(parseLlmSecret(null), { apiKey: null, baseUrl: null });
});

test("runtime setup record: only a well-formed record is read", () => {
    const at = "2026-10-27T10:00:00.000Z";
    assert.deepEqual(runtimeSetupOf({ runtimeSetup: { status: "failed", message: "Image pull failed", at } }), { status: "failed", message: "Image pull failed", at });
    assert.equal(runtimeSetupOf({ runtimeSetup: { status: "weird", message: "x", at } }), null);
    assert.equal(runtimeSetupOf({ agentWake: {} }), null);
    assert.equal(runtimeSetupOf(null), null);
});

const now = new Date("2026-10-27T12:00:00.000Z");
const run = (minutesAgo: number, status: string, error: string | null) => ({
    status, error, exitReason: null,
    startedAt: new Date(now.getTime() - (minutesAgo + 1) * 60_000), endedAt: new Date(now.getTime() - minutesAgo * 60_000),
});

test("provider trouble: the latest run failed on the provider; failures in a row are counted", () => {
    const trouble = providerTroubleFromRuns([run(1, "failed", "provider_unreachable"), run(3, "failed", "provider_unreachable"), run(20, "succeeded", null)], now);
    assert.equal(trouble?.cause, "provider_unreachable");
    assert.equal(trouble?.failedRuns, 2);
    assert.equal(trouble?.headline, "Can't reach the model provider");
    assert.equal(providerTroubleLabel("provider_unreachable"), "model unreachable");
    // One failed run is enough when it is the only recent one.
    assert.equal(providerTroubleFromRuns([run(2, "failed", "provider_auth_failed: HTTP 401")], now)?.cause, "provider_auth");
});

test("provider trouble: none after a success, for other failures, or for old runs", () => {
    assert.equal(providerTroubleFromRuns([run(1, "succeeded", null), run(3, "failed", "provider_unreachable")], now), null);
    assert.equal(providerTroubleFromRuns([run(1, "failed", "hermes_failed"), run(3, "failed", "provider_unreachable")], now), null);
    assert.equal(providerTroubleFromRuns([run(1, "cancelled", null), run(3, "failed", "provider_unreachable")], now), null);
    assert.equal(providerTroubleFromRuns([run(120, "failed", "provider_unreachable")], now), null);
    assert.equal(providerTroubleFromRuns([], now), null);
});
