import { test } from "node:test";
import assert from "node:assert/strict";
import { stripStopHint, STOP_HINT_MAX_INPUT } from "../../src/lib/run-events";
import { classifyFailure } from "../../src/lib/failure-cause";
import { checkLlmModelName, llmEndpointHost, normalizeLlmBaseUrl, trimTrailingSlashes } from "../../src/lib/llm-endpoint";
import { classifyAddress, normalizeEndpointHostname } from "../../src/lib/llm-endpoint-policy";
import { providerTroubleFromRuns } from "../../src/lib/provider-trouble";
import { quotedPromptText, taskBrief } from "../../src/lib/task-wake";

// Every pattern added with local Hermes mode, fed inputs built to make a
// backtracking regex go super-linear. A linear pass takes a few ms; the 500 ms ceiling
// leaves room for slow shared CI runners while still catching any blow-up.
const N = 300_000;
const HOSTILE: Record<string, string> = {
    spaces: " ".repeat(N),
    spacesThenX: `${" ".repeat(N)}x`,
    punctuationRun: `;${" ".repeat(N)},${" ".repeat(N)}!`,
    stopHintNearMiss: `waiting${" ".repeat(N)}press Esc to sto`,
    stopHintRepeated: `${"press Esc to stop ".repeat(N / 18)}x`,
    httpSpaces: `HTTP${" ".repeat(N)}x`,
    statusRepeated: "status ".repeat(N / 7),
    modelRepeated: "model ".repeat(N / 6),
    errorCode: "error code:".repeat(N / 11),
    apiRepeated: "api ".repeat(N / 4),
    connectRepeated: "connect".repeat(N / 7),
    slashes: `${"/".repeat(N)}x`,
    newlines: `${"\n\n".repeat(N / 2)}x`,
    crlf: "\r\n".repeat(N / 2),
    quotes: "\"".repeat(N),
    controls: "\u0001‮".repeat(N / 2),
    colons: ":".repeat(N),
    dots: ".".repeat(N),
};

function timed(label: string, fn: () => unknown) {
    const started = performance.now();
    fn();
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 500, `${label} took ${elapsed.toFixed(1)} ms`);
}

test("stripStopHint: same results as before, linear on hostile input", () => {
    assert.equal(stripStopHint("⏳ Provider temporarily unavailable — retrying in 30s (cycle 2/5); press Esc to stop"), "⏳ Provider temporarily unavailable — retrying in 30s (cycle 2/5)");
    assert.equal(stripStopHint("waiting; send /stop to cancel"), "waiting");
    assert.equal(stripStopHint("retrying  —  Cancel the request to stop.  "), "retrying");
    assert.equal(stripStopHint("retrying - PRESS ESC TO STOP"), "retrying");
    assert.equal(stripStopHint("press Esc to stop"), "");
    assert.equal(stripStopHint("Press Escape twice"), "Press Escape twice");
    assert.equal(stripStopHint("press Esc to stop.."), "press Esc to stop..", "only one trailing period belongs to the hint");
    assert.equal(stripStopHint("İ press Esc to stop"), "İ", "case folding that changes length never shifts the cut");
    const long = `${"x".repeat(STOP_HINT_MAX_INPUT)} press Esc to stop`;
    assert.equal(stripStopHint(long), long, "text over the cap is left as is");
    for (const [name, input] of Object.entries(HOSTILE)) timed(`stripStopHint(${name})`, () => stripStopHint(input));
});

test("failure classification stays linear on hostile provider text", () => {
    for (const [name, input] of Object.entries(HOSTILE)) {
        timed(`classifyFailure(${name})`, () => classifyFailure({ texts: [input, input] }));
        timed(`providerTroubleFromRuns(${name})`, () => providerTroubleFromRuns([
            { status: "failed", error: input, exitReason: input, startedAt: new Date(), endedAt: new Date() },
        ]));
    }
    assert.equal(classifyFailure({ texts: ["APIConnectionError: Connection error."] }), "provider_unreachable");
});

test("base URL, model and host helpers stay linear", () => {
    assert.equal(trimTrailingSlashes("http://x/v1///"), "http://x/v1");
    assert.equal(trimTrailingSlashes("///"), "");
    assert.deepEqual(normalizeLlmBaseUrl("http://x.example/v1//"), { ok: true, url: "http://x.example/v1", hint: null });
    for (const [name, input] of Object.entries(HOSTILE)) {
        timed(`trimTrailingSlashes(${name})`, () => trimTrailingSlashes(input));
        timed(`normalizeLlmBaseUrl(${name})`, () => normalizeLlmBaseUrl(`http://x.example/${input}`));
        timed(`checkLlmModelName(${name})`, () => checkLlmModelName(`a${input}`));
        timed(`llmEndpointHost(${name})`, () => llmEndpointHost(`http://[${input}]/v1`));
        timed(`classifyAddress(${name})`, () => classifyAddress(`::${input}`));
        timed(`normalizeEndpointHostname(${name})`, () => normalizeEndpointHostname(input));
    }
});

test("task wake text helpers stay linear and keep the quoted line closed", () => {
    for (const [name, input] of Object.entries(HOSTILE)) {
        timed(`taskBrief(${name})`, () => taskBrief({ inputJson: { description: input } }));
        timed(`quotedPromptText(${name})`, () => quotedPromptText(input));
    }
});
