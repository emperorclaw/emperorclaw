import { test } from "node:test";
import assert from "node:assert/strict";

import { planLlmEndpointEdit, type LlmEndpointDraft } from "../../src/lib/llm-endpoint-edit";

const draft = (overrides: Partial<LlmEndpointDraft>): LlmEndpointDraft => ({
    currentProvider: "openai",
    provider: "openai",
    baseUrl: "",
    apiKey: "",
    noKey: false,
    ...overrides,
});

test("keeping the provider needs no key and sends no key field", () => {
    const plan = planLlmEndpointEdit(draft({}));
    assert.equal(plan.endpointChanged, false);
    assert.equal(plan.keyRequired, false);
    assert.deepEqual(plan.fields, { llmProvider: "openai" });
});

test("switching provider asks for that provider's key and sends it in the same PATCH", () => {
    const missing = planLlmEndpointEdit(draft({ provider: "anthropic", model: "" }));
    assert.equal(missing.keyRequired, true);
    assert.equal(missing.fields, null);
    assert.match(missing.error ?? "", /API key/);

    const plan = planLlmEndpointEdit(draft({ provider: "anthropic", apiKey: "  sk-ant-new  ", model: "" }));
    assert.equal(plan.error, null);
    assert.deepEqual(plan.fields, { llmProvider: "anthropic", llmModel: "", llmApiKey: "sk-ant-new" });
});

test("a named provider can't be saved keyless", () => {
    const plan = planLlmEndpointEdit(draft({ provider: "deepseek", noKey: true }));
    assert.equal(plan.fields, null);
});

test("clearing the provider needs no key (the server drops it)", () => {
    const plan = planLlmEndpointEdit(draft({ provider: "" }));
    assert.equal(plan.keyRequired, false);
    assert.deepEqual(plan.fields, { llmProvider: "" });
});

test("moving to a custom endpoint needs its base URL and model, and accepts no key", () => {
    assert.match(planLlmEndpointEdit(draft({ provider: "custom", noKey: true, model: "llama3.1:8b" })).error ?? "", /base URL/);
    assert.match(planLlmEndpointEdit(draft({ provider: "custom", noKey: true, baseUrl: "http://host.docker.internal:11434/v1/", model: "" })).error ?? "", /model/);

    const plan = planLlmEndpointEdit(draft({ provider: "custom", noKey: true, baseUrl: "http://host.docker.internal:11434/v1/", model: "llama3.1:8b" }));
    assert.equal(plan.error, null);
    assert.deepEqual(plan.fields, {
        llmProvider: "custom",
        llmModel: "llama3.1:8b",
        llmBaseUrl: "http://host.docker.internal:11434/v1",
        llmApiKey: null,
    });
});

test("a localhost base URL is accepted with the Docker host hint", () => {
    const plan = planLlmEndpointEdit(draft({ provider: "custom", apiKey: "k", baseUrl: "http://localhost:11434/v1", model: "m" }));
    assert.equal(plan.error, null);
    assert.match(plan.baseUrlHint ?? "", /host\.docker\.internal/);
});

test("an invalid base URL is refused before the request", () => {
    const plan = planLlmEndpointEdit(draft({ provider: "custom", apiKey: "k", baseUrl: "ftp://models", model: "m" }));
    assert.equal(plan.fields, null);
    assert.match(plan.error ?? "", /http/);
});

test("a custom agent keeps its base URL when left blank and needs no key for a model change", () => {
    const plan = planLlmEndpointEdit(draft({ currentProvider: "custom", provider: "custom", model: "qwen2.5" }));
    assert.equal(plan.endpointChanged, false);
    assert.equal(plan.keyRequired, false);
    assert.deepEqual(plan.fields, { llmProvider: "custom", llmModel: "qwen2.5" });
});

test("a new base URL for a custom agent is an endpoint change that needs a key or no key", () => {
    const base = { currentProvider: "custom", provider: "custom", baseUrl: "https://gateway.example.com/v1", model: "m" } as const;
    assert.equal(planLlmEndpointEdit(draft(base)).fields, null);
    assert.deepEqual(planLlmEndpointEdit(draft({ ...base, noKey: true })).fields, {
        llmProvider: "custom",
        llmModel: "m",
        llmBaseUrl: "https://gateway.example.com/v1",
        llmApiKey: null,
    });
});

test("the base URL only travels with the custom provider", () => {
    const plan = planLlmEndpointEdit(draft({ currentProvider: "custom", provider: "openai", baseUrl: "http://host.docker.internal:1/v1", apiKey: "sk", model: "" }));
    assert.deepEqual(plan.fields, { llmProvider: "openai", llmModel: "", llmApiKey: "sk" });
});
