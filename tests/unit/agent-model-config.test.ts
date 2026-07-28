import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveAgentModelConfiguration } from "../../src/lib/agent-model-config";

const pricing = [
    { provider: "openai", model: "gpt-5-mini" },
    { provider: "anthropic", model: "claude-sonnet" },
];

test("known model selection carries its provider atomically", () => {
    assert.deepEqual(resolveAgentModelConfiguration({
        current: { llmProvider: "anthropic", llmModel: "claude-sonnet" },
        provider: "anthropic",
        model: "gpt-5-mini",
        pricing,
    }), {
        llmProvider: "openai",
        llmModel: "gpt-5-mini",
    });
});

test("provider-only change clears a known incompatible model", () => {
    assert.deepEqual(resolveAgentModelConfiguration({
        current: { llmProvider: "anthropic", llmModel: "claude-sonnet" },
        provider: "openai",
        pricing,
    }), {
        llmProvider: "openai",
        llmModel: null,
    });
});

test("legacy model-only updates infer provider when unambiguous", () => {
    assert.deepEqual(resolveAgentModelConfiguration({
        current: { llmProvider: null, llmModel: null },
        model: "claude-sonnet",
        pricing,
    }), {
        llmProvider: "anthropic",
        llmModel: "claude-sonnet",
    });
});

test("unknown custom models remain supported", () => {
    assert.deepEqual(resolveAgentModelConfiguration({
        current: { llmProvider: null, llmModel: null },
        provider: "local",
        model: "my-private-model",
        pricing,
    }), {
        llmProvider: "local",
        llmModel: "my-private-model",
    });
});

test("empty strings explicitly clear configuration", () => {
    assert.deepEqual(resolveAgentModelConfiguration({
        current: { llmProvider: "openai", llmModel: "gpt-5-mini" },
        provider: "",
        model: "",
        pricing,
    }), {
        llmProvider: null,
        llmModel: null,
    });
});
