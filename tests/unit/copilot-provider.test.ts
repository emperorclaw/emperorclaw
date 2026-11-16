import { test } from "node:test";
import assert from "node:assert/strict";

import {
    COPILOT_CLASSIC_PAT_ERROR, COPILOT_DEFAULT_MODEL, COPILOT_MODELS, COPILOT_PROVIDER, COPILOT_TOKEN_ENV,
    checkCopilotToken, isCopilotModel, llmKeyError, modelFitsProvider, modelOptionsFor, resolvePickedProvider,
} from "../../src/lib/copilot-provider";
import { resolveAgentModelConfiguration } from "../../src/lib/agent-model-config";
import { PROVIDER_DOCS, PROVIDER_INDEX } from "../../src/lib/llm-config-docs";
import { DEFAULT_HOST_MODEL, HOST_LLM_PROVIDERS } from "../../src/lib/runtime-hosts/commands";

// Fake, low-entropy tokens: shapes only.
const OAUTH = `gho_${"x".repeat(36)}`;
const APP_USER = `ghu_${"y".repeat(36)}`;
const FINE_GRAINED = `github_pat_${"z".repeat(60)}`;
const CLASSIC = `ghp_${"q".repeat(36)}`;

test("copilot token: OAuth, app-user and fine-grained tokens are accepted", () => {
    for (const token of [OAUTH, APP_USER, FINE_GRAINED, `  ${OAUTH}\n`]) assert.deepEqual(checkCopilotToken(token), { ok: true });
});

test("copilot token: classic PATs are refused with a clear message that never echoes the token", () => {
    const checked = checkCopilotToken(CLASSIC);
    assert.equal(checked.ok, false);
    assert.ok(!checked.ok && checked.error === COPILOT_CLASSIC_PAT_ERROR);
    assert.ok(!checked.ok && !checked.error.includes("q".repeat(10)));
});

test("copilot token: other shapes are refused without echoing them", () => {
    for (const token of ["sk-abcdef1234567890", "gho_ with space", "plainsecretvalue", `x${OAUTH}`]) {
        const checked = checkCopilotToken(token);
        assert.equal(checked.ok, false, token);
        assert.ok(!checked.ok && !checked.error.includes(token.trim()), token);
    }
});

test("llmKeyError: checks only copilot keys, and only when a key is given", () => {
    assert.equal(llmKeyError("copilot", OAUTH), null);
    assert.equal(llmKeyError("copilot", CLASSIC), COPILOT_CLASSIC_PAT_ERROR);
    assert.equal(llmKeyError("copilot", ""), null);
    assert.equal(llmKeyError("deepseek", CLASSIC), null);
    assert.equal(llmKeyError(null, CLASSIC), null);
});

test("copilot models: the default is in the curated list and every id is a plain model id", () => {
    assert.ok(isCopilotModel(COPILOT_DEFAULT_MODEL));
    assert.equal(new Set(COPILOT_MODELS).size, COPILOT_MODELS.length);
    for (const model of COPILOT_MODELS) assert.match(model, /^[a-z0-9][a-z0-9.-]*$/, model);
    assert.equal(isCopilotModel("deepseek-chat"), false);
    assert.equal(isCopilotModel(null), false);
});

test("copilot models: a Copilot model never moves the agent to the vendor that prices it", () => {
    const pricing = [
        { provider: "openai", model: "gpt-5-mini" },
        { provider: "anthropic", model: "claude-sonnet-4.5" },
        { provider: "deepseek", model: "deepseek-chat" },
    ];
    const none = { llmProvider: null, llmModel: null };
    assert.deepEqual(resolveAgentModelConfiguration({ current: none, provider: "copilot", model: "gpt-5-mini", pricing }),
        { llmProvider: "copilot", llmModel: "gpt-5-mini" });
    assert.deepEqual(resolveAgentModelConfiguration({ current: { llmProvider: "copilot", llmModel: "gpt-5-mini" }, model: "claude-sonnet-4.5", pricing }),
        { llmProvider: "copilot", llmModel: "claude-sonnet-4.5" });
    // Switching to Copilot keeps a model Copilot serves, clears one it does not.
    assert.deepEqual(resolveAgentModelConfiguration({ current: { llmProvider: "openai", llmModel: "gpt-5-mini" }, provider: "copilot", pricing }),
        { llmProvider: "copilot", llmModel: "gpt-5-mini" });
    assert.deepEqual(resolveAgentModelConfiguration({ current: { llmProvider: "deepseek", llmModel: "deepseek-chat" }, provider: "copilot", pricing }),
        { llmProvider: "copilot", llmModel: null });
    // Leaving Copilot for a vendor still follows the vendor's pricing.
    assert.deepEqual(resolveAgentModelConfiguration({ current: { llmProvider: "copilot", llmModel: "gpt-5-mini" }, provider: "anthropic", pricing }),
        { llmProvider: "anthropic", llmModel: null });
});

test("copilot: offered on runtime hosts with the Copilot default model", () => {
    assert.ok((HOST_LLM_PROVIDERS as readonly string[]).includes(COPILOT_PROVIDER));
    assert.equal(DEFAULT_HOST_MODEL.copilot, COPILOT_DEFAULT_MODEL);
});

test("copilot: documented for agents with its token env var and every curated model", () => {
    const doc = PROVIDER_DOCS[COPILOT_PROVIDER];
    assert.equal(doc.envVar, COPILOT_TOKEN_ENV);
    assert.equal(COPILOT_TOKEN_ENV, "COPILOT_GITHUB_TOKEN");
    for (const model of COPILOT_MODELS) assert.ok(doc.docs.includes(model), model);
    assert.ok(doc.docs.includes("ghp_"), "warns about classic PATs");
    assert.ok(PROVIDER_INDEX.some((p) => p.id === COPILOT_PROVIDER && p.envVar === COPILOT_TOKEN_ENV));
});

// ── model pickers (hire dialog, agent detail) ──────────────────────────────

const priced = [
    { provider: "openai", model: "gpt-5-mini", label: "GPT-5 mini", inputPricePer1k: 0.25, outputPricePer1k: 2 },
    { provider: "anthropic", model: "claude-sonnet-4.5", label: "Claude Sonnet 4.5", inputPricePer1k: 3, outputPricePer1k: 15 },
    { provider: "copilot", model: "gpt-4.1", label: "GPT-4.1 (Copilot)", inputPricePer1k: 0.01, outputPricePer1k: 0.02 },
];

test("picker options: a Copilot agent is offered Copilot's models, all on copilot", () => {
    const options = modelOptionsFor("copilot", priced);
    assert.deepEqual(options.map((o) => o.model), [...COPILOT_MODELS]);
    assert.ok(options.every((o) => o.provider === "copilot"));
    const mini = options.find((o) => o.model === "gpt-5-mini")!;
    assert.equal(mini.inputPricePer1k, 0, "not priced as OpenAI's row");
    const priced41 = options.find((o) => o.model === "gpt-4.1")!;
    assert.equal(priced41.label, "GPT-4.1 (Copilot)", "an admin's copilot pricing row is used");
    assert.equal(priced41.inputPricePer1k, 0.01);
    assert.equal(modelOptionsFor("openai", priced), priced, "other providers keep the priced catalog");
    assert.equal(modelOptionsFor(null, priced), priced);
});

test("picker selection: choosing Copilot then gpt-5-mini keeps the agent on Copilot", () => {
    assert.equal(resolvePickedProvider("copilot", { provider: "openai", model: "gpt-5-mini" }), "copilot");
    assert.equal(resolvePickedProvider("copilot", { provider: "copilot", model: "claude-sonnet-4.5" }), "copilot");
    // A model Copilot does not serve moves the agent, as for any provider.
    assert.equal(resolvePickedProvider("copilot", { provider: "deepseek", model: "deepseek-chat" }), "deepseek");
    assert.equal(resolvePickedProvider("anthropic", { provider: "openai", model: "gpt-5-mini" }), "openai");
    assert.equal(resolvePickedProvider("", { provider: "openai", model: "gpt-5-mini" }), "openai");
});

test("provider change: Copilot keeps the models it serves, other vendors keep only their own", () => {
    assert.equal(modelFitsProvider("copilot", "gpt-5-mini", priced), true);
    assert.equal(modelFitsProvider("copilot", "deepseek-chat", priced), false);
    assert.equal(modelFitsProvider("anthropic", "gpt-5-mini", priced), false);
    assert.equal(modelFitsProvider("openai", "gpt-5-mini", priced), true);
    assert.equal(modelFitsProvider("openai", "my-local-model", priced), true, "unknown models are kept");
    assert.equal(modelFitsProvider("", "gpt-5-mini", priced), false, "no provider clears a priced model, as before");
    assert.equal(modelFitsProvider("openai", "", priced), true);
});
