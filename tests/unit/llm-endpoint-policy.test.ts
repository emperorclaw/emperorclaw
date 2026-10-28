import { test } from "node:test";
import assert from "node:assert/strict";
import {
    checkLlmEndpointForSave,
    checkLlmEndpointHost,
    classifyAddress,
    normalizeEndpointHostname,
    type LookupAll,
} from "../../src/lib/llm-endpoint-policy";
import { checkLlmModelName, llmEndpointHost, normalizeLlmBaseUrl } from "../../src/lib/llm-endpoint";

const OWN_PORTS = new Set([3000, 5433]);
const lookupTo = (...addresses: string[]): LookupAll => async () => addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
const noLookup: LookupAll = async () => { throw new Error("lookup must not run for this host"); };
const failingLookup: LookupAll = async () => { throw Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }); };

/** The check as the routes run it: the URL normalized first (the URL parser canonicalizes IPv4 spellings). */
async function check(raw: string, mode: "self-hosted" | "cloud", lookup: LookupAll = noLookup) {
    const normalized = normalizeLlmBaseUrl(raw);
    assert.ok(normalized.ok, `${raw} should parse`);
    return checkLlmEndpointHost(normalized.url, { mode, lookup, ownPorts: OWN_PORTS });
}

test("address classes: link-local, unspecified, multicast and reserved are blocked", () => {
    for (const address of ["169.254.169.254", "169.254.0.1", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.250", "255.255.255.255", "240.0.0.1",
        "::", "fe80::1", "febf::1", "ff02::1", "::ffff:169.254.169.254", "::ffff:a9fe:a9fe", "::ffff:0.0.0.0", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1"]) {
        assert.equal(classifyAddress(address), "blocked", address);
    }
    for (const address of ["127.0.0.1", "127.255.0.9", "::1", "::ffff:127.0.0.1"]) assert.equal(classifyAddress(address), "loopback", address);
    for (const address of ["10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.20", "100.64.0.1", "fd00::1", "fc12::1", "::ffff:192.168.1.1"]) {
        assert.equal(classifyAddress(address), "private", address);
    }
    for (const address of ["8.8.8.8", "172.32.0.1", "104.18.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(classifyAddress(address), "public", address);
    assert.equal(classifyAddress("not-an-ip"), "blocked");
});

test("metadata endpoints are blocked however they are spelled", async () => {
    const spellings = [
        "http://169.254.169.254/v1",
        "http://2852039166/v1", // decimal
        "http://0xa9fea9fe/v1", // hex
        "http://0251.0376.0251.0376/v1", // octal
        "http://0251.254.43518/v1", // mixed short form
        "http://169.254.169.254./v1", // trailing dot
        "http://[::ffff:169.254.169.254]/v1", // IPv6-mapped IPv4
        "http://[::ffff:a9fe:a9fe]/v1",
        "http://[fe80::1]/v1",
        "http://metadata.google.internal/v1",
        "http://metadata.google.internal./v1",
        "http://METADATA.GOOGLE.INTERNAL../v1",
        "http://metadata/computeMetadata/v1",
        "http://instance-data/latest",
    ];
    for (const mode of ["self-hosted", "cloud"] as const) {
        for (const raw of spellings) {
            const result = await check(raw, mode);
            assert.equal(result.ok, false, `${raw} (${mode})`);
            assert.equal(!result.ok && result.reason, "blocked", `${raw} (${mode})`);
        }
    }
});

test("a name is judged by every address it resolves to", async () => {
    // Rebinding-style answers: one good record is not enough.
    assert.equal((await check("http://llm.example.com/v1", "self-hosted", lookupTo("8.8.8.8", "169.254.169.254"))).ok, false);
    assert.equal((await check("http://llm.example.com/v1", "cloud", lookupTo("8.8.8.8", "10.0.0.2"))).ok, false);
    const ok = await check("https://llm.example.com/v1", "cloud", lookupTo("104.18.0.1"));
    assert.ok(ok.ok);
    assert.deepEqual(ok.ok && ok.addresses, [{ address: "104.18.0.1", family: 4 }], "the checked address is the one the request pins");
    const unresolved = await check("http://ollama.lan:11434/v1", "self-hosted", failingLookup);
    assert.equal(!unresolved.ok && unresolved.reason, "unresolved");
});

test("this stack's own services are never a model endpoint", async () => {
    for (const raw of ["http://postgres:5432/v1", "http://app:3000/v1", "http://caddy/v1", "http://localhost:3000/v1", "http://127.0.0.1:3000/v1", "http://[::1]:3000/v1", "http://127.0.0.1:5433/v1"]) {
        assert.equal((await check(raw, "self-hosted")).ok, false, raw);
    }
});

test("self-hosted allows the LAN, the Docker host and local model servers; cloud does not", async () => {
    const local = [
        ["http://host.docker.internal:11434/v1", lookupTo("192.168.65.254")],
        ["http://192.168.1.50:1234/v1", noLookup],
        ["http://10.0.0.7:8000/v1", noLookup],
        ["http://localhost:11434/v1", noLookup],
        ["http://127.0.0.1:1234/v1", noLookup],
        ["http://[fd00::5]:8000/v1", noLookup],
        ["http://ollama.lan:11434/v1", lookupTo("192.168.1.9")],
    ] as const;
    for (const [raw, lookup] of local) {
        assert.ok((await check(raw, "self-hosted", lookup)).ok, `${raw} (self-hosted)`);
        assert.equal((await check(raw, "cloud", lookup)).ok, false, `${raw} (cloud)`);
    }
    // host.docker.internal not resolving from the app container is still fine to save on a self-hosted install.
    const saved = await checkLlmEndpointForSave("http://host.docker.internal:11434/v1", { mode: "self-hosted", lookup: failingLookup, ownPorts: OWN_PORTS });
    assert.deepEqual(saved, { ok: true });
    assert.equal((await checkLlmEndpointForSave("http://unknown.example/v1", { mode: "cloud", lookup: failingLookup, ownPorts: OWN_PORTS })).ok, false);
    assert.equal((await checkLlmEndpointForSave("http://169.254.169.254/v1", { mode: "self-hosted", lookup: noLookup, ownPorts: OWN_PORTS })).ok, false);
});

test("host names are compared without case, brackets or trailing dots", () => {
    assert.equal(normalizeEndpointHostname("Metadata.Google.Internal..."), "metadata.google.internal");
    assert.equal(normalizeEndpointHostname("[::1]"), "::1");
    assert.equal(llmEndpointHost("http://[::1]:8000/v1"), "::1");
    assert.equal(llmEndpointHost("https://LLM.example.com/openai/v1"), "llm.example.com");
    assert.equal(llmEndpointHost(null), null);
});

test("model names: real ids pass, control characters and config syntax do not", () => {
    for (const model of ["deepseek/deepseek-chat", "openai/gpt-4o-mini", "llama3.1:8b", "qwen2.5-coder:32b-instruct-q4_K_M",
        "nvidia/nemotron-3-ultra-550b-a55b:free", "claude-sonnet-4-20250514", "gpt-5.6", "accounts/fireworks/models/llama-v3p1-8b-instruct", "a@b+c"]) {
        assert.deepEqual(checkLlmModelName(model), { ok: true, model }, model);
    }
    assert.deepEqual(checkLlmModelName("  gpt-4o  "), { ok: true, model: "gpt-4o" });
    assert.deepEqual(checkLlmModelName(""), { ok: true, model: "" }, "empty clears the model");
    assert.deepEqual(checkLlmModelName(undefined), { ok: true, model: "" });
    for (const bad of ["gpt\nmodel.provider evil", "gpt\tset\tmodel.base_url\thttp://evil", "gpt\rmodel.default evil", "gpt 4o", "\"quoted\"", "-flag", "x".repeat(201), "a;rm", "$(id)", 42]) {
        assert.equal(checkLlmModelName(bad).ok, false, JSON.stringify(bad));
    }
});
