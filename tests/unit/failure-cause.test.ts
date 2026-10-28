import { test } from "node:test";
import assert from "node:assert/strict";
import {
    agentFixMessage, classifyFailure, describeFailure, failureFix, fixAudience, shortFailureText, stalledHeadline, PROVIDER_KEY_DOC_HREF, RATE_LIMIT_RETRY_DELAY_MS, type FailureCause,
} from "../../src/lib/failure-cause";

// Real formats, collected from the producers: the Hermes bridge ledger
// (error_classification / abandoned_payload), the bridge outbox
// (CREDITS_REASON, give-up reasons), the run reaper ("lost"), Emperor's own
// API refusals, and the provider error text Hermes passes through.
const SAMPLES: Record<FailureCause, string[]> = {
    provider_credits: [
        "provider_credits_exhausted: HTTP 402",
        "LLM provider out of credits (HTTP 402): add credits for this agent's API key, then retry",
        "Error code: 402 - {'error': {'message': 'Insufficient credits. Add more using https://openrouter.ai/settings/credits', 'code': 402}}",
        "This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 1200.",
        "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.",
        "Error code: 429 - {'error': {'message': 'You exceeded your current quota, please check your plan and billing details.', 'type': 'insufficient_quota'}}",
        "Insufficient Balance",
    ],
    provider_auth: [
        "Error code: 401 - {'error': {'message': 'Incorrect API key provided: sk-proj-****abcd.', 'type': 'invalid_request_error', 'code': 'invalid_api_key'}}",
        "Error code: 401 - {'type': 'error', 'error': {'type': 'authentication_error', 'message': 'invalid x-api-key'}}",
        "No auth credentials found",
        "API key not valid. Please pass a valid API key.",
        "HTTP 403 Forbidden",
        // Hermes bridge ledger codes and chat-status reasons (emperor_bridge/ledger.py).
        "provider_auth_failed: HTTP 401",
        "The model provider rejected the API key (HTTP 401): update this agent's key, then retry",
    ],
    rate_limited: [
        "Error code: 429 - {'error': {'message': 'Rate limit reached for gpt-4o in organization org-x on tokens per min (TPM)', 'code': 'rate_limit_exceeded'}}",
        "RateLimitError: Too Many Requests",
        "Error code: 529 - {'type': 'error', 'error': {'type': 'overloaded_error', 'message': 'Overloaded'}}",
        "provider_rate_limited: HTTP 429",
    ],
    model_unavailable: [
        "Error code: 404 - {'error': {'message': 'The model `gpt-5-turbo` does not exist or you do not have access to it.', 'code': 'model_not_found'}}",
        "deepseek/deepseek-v9 is not a valid model ID",
        "No endpoints found for deepseek/deepseek-v9.",
        "Active model pricing required for capped agents",
        "provider_model_not_found",
        "The model provider doesn't serve this model (model_not_found): choose another model for this agent",
    ],
    provider_unreachable: [
        "provider_unreachable",
        "Can't reach the model provider (connection refused or timed out): check the provider settings, then retry",
        "APIConnectionError: Connection error.",
        "httpx.ConnectTimeout: timed out",
        "[Errno -2] Name or service not known",
        "⏳ Provider temporarily unavailable — retrying automatically in 30s (cycle 2/5)",
    ],
    budget: [
        "Budget exhausted",
        "budget unavailable",
        "budget check denied",
    ],
    runtime_offline: [
        "runtime_restart",
        "not_admitted: GatewayUnavailable",
        "The runtime stopped reporting",
        "Emperor reports a duplicate runtime for this agent",
        "gateway_error",
    ],
    stalled: [
        "idle_timeout",
        "The turn timed out after 900s",
    ],
    scope_denied: [
        "Project is outside this agent's scope",
        "Task's project is outside this agent's scope",
        "You can't reach that agent: it is outside your scope",
        "Access denied: this token is bound to a different agent",
    ],
    unknown: [
        "hermes_failed",
        "no_receipt",
        "salary tool crashed",
    ],
};

for (const [cause, samples] of Object.entries(SAMPLES) as [FailureCause, string[]][]) {
    test(`classify: ${cause} from real error strings`, () => {
        for (const sample of samples) assert.equal(classifyFailure({ texts: [sample], runStatus: "failed" }), cause, sample);
    });
}

test("classify: status and agent state when there is no text", () => {
    assert.equal(classifyFailure({ runStatus: "lost" }), "runtime_offline");
    assert.equal(classifyFailure({ runStatus: "timeout", texts: ["turn limit"] }), "stalled");
    assert.equal(classifyFailure({ stalled: true }), "stalled");
    assert.equal(classifyFailure({ offline: true }), "runtime_offline");
    assert.equal(classifyFailure({ budgetStatus: "paused", offline: true }), "budget");
    assert.equal(classifyFailure({ runStatus: "failed", texts: [null, ""] }), "unknown");
    // Text evidence wins over status: a lost run that reported a 402 is a credits problem.
    assert.equal(classifyFailure({ runStatus: "lost", texts: ["provider_credits_exhausted: HTTP 402"] }), "provider_credits");
});

test("headline and detail: one plain cause; the raw text only when unknown", () => {
    const credits = describeFailure({ texts: ["provider_credits_exhausted: HTTP 402"] }, { audience: "admin", agentId: "a1" });
    assert.equal(credits.headline, "LLM provider is out of credits");
    assert.equal(credits.detail, null);
    const unknown = describeFailure({ texts: ["salary tool crashed"], runStatus: "failed" }, { audience: "member" });
    assert.equal(unknown.headline, "Run failed");
    assert.equal(unknown.detail, "salary tool crashed");
    assert.equal(stalledHeadline(12 * 60_000), "No progress for 12 min");
    assert.equal(stalledHeadline(30_000), "No progress for 1 min");
    assert.equal(stalledHeadline(3 * 3_600_000), "No progress for 3 h");
    assert.equal(stalledHeadline(null), "No progress before it timed out");
});

test("audience from access", () => {
    assert.equal(fixAudience({ canAct: false, isOwnerOrAdmin: false }), "viewer");
    assert.equal(fixAudience({ canAct: false, isOwnerOrAdmin: true }), "viewer");
    assert.equal(fixAudience({ canAct: true, isOwnerOrAdmin: false }), "member");
    assert.equal(fixAudience({ canAct: true, isOwnerOrAdmin: true }), "admin");
});

test("fixes: viewers never get an action", () => {
    for (const cause of Object.keys(SAMPLES) as FailureCause[]) {
        assert.equal(failureFix(cause, { audience: "viewer", agentId: "a1", taskId: "t1", retryMessageId: "m1", canRestartRuntime: true }), null, cause);
    }
});

test("fixes: provider keys, budgets and scope are owner/admin only", () => {
    const ctx = { agentId: "a1", taskId: "t1" };
    for (const cause of ["provider_credits", "provider_auth", "budget", "scope_denied"] as const) {
        assert.equal(failureFix(cause, { ...ctx, audience: "member" }), null, cause);
        assert.ok(failureFix(cause, { ...ctx, audience: "admin" }), cause);
    }
    assert.deepEqual(failureFix("provider_credits", { ...ctx, audience: "admin" }), { label: "Open provider settings", action: { kind: "link", href: "/agents?agent=a1" } });
    assert.deepEqual(failureFix("provider_auth", { ...ctx, audience: "admin" }), { label: "Update key", action: { kind: "link", href: PROVIDER_KEY_DOC_HREF } });
    assert.deepEqual(failureFix("budget", { ...ctx, audience: "admin" }), { label: "Raise budget", action: { kind: "link", href: "/budgets" } });
    assert.deepEqual(failureFix("scope_denied", { ...ctx, audience: "admin" }), { label: "Open agent scope", action: { kind: "link", href: "/agents?agent=a1&tab=scope" } });
});

test("fixes: what members can act on", () => {
    assert.deepEqual(failureFix("model_unavailable", { audience: "member", agentId: "a1" }), { label: "Choose a model", action: { kind: "link", href: "/agents?agent=a1" } });
    assert.deepEqual(failureFix("runtime_offline", { audience: "member", agentId: "a1", canRestartRuntime: true }), { label: "Reconnect runtime", action: { kind: "restart_runtime", agentId: "a1" } });
    assert.deepEqual(failureFix("runtime_offline", { audience: "member", agentId: "a1" }), { label: "Reconnect runtime", action: { kind: "link", href: "/agents?agent=a1" } });
    assert.deepEqual(failureFix("stalled", { audience: "member", agentId: "a1", taskId: "t1" }), { label: "Nudge", action: { kind: "message_agent", agentId: "a1", taskId: "t1", mode: "nudge" } });
    // Retry: the viewer's own message first, else a retry directive on the task, else nothing to press.
    assert.deepEqual(failureFix("unknown", { audience: "member", agentId: "a1", taskId: "t1", retryMessageId: "m1" }), { label: "Retry", action: { kind: "retry_message", messageId: "m1" } });
    assert.deepEqual(failureFix("unknown", { audience: "member", agentId: "a1", taskId: "t1" }), { label: "Retry", action: { kind: "message_agent", agentId: "a1", taskId: "t1", mode: "retry" } });
    assert.equal(failureFix("unknown", { audience: "member", agentId: "a1" }), null);
});

test("fixes: an unreachable provider is a settings link for admins and Retry for members", () => {
    assert.deepEqual(failureFix("provider_unreachable", { audience: "admin", agentId: "a1", retryMessageId: "m1" }), { label: "Check provider settings", action: { kind: "link", href: "/agents?agent=a1" } });
    assert.deepEqual(failureFix("provider_unreachable", { audience: "member", agentId: "a1", retryMessageId: "m1" }), { label: "Retry", action: { kind: "retry_message", messageId: "m1" } });
    const view = describeFailure({ texts: ["provider_unreachable"], runStatus: "failed" }, { audience: "member", agentId: "a1" });
    assert.equal(view.headline, "Can't reach the model provider");
    assert.equal(view.detail, null);
});

test("classify: Emperor losing the runtime is still runtime_offline, not the provider", () => {
    assert.equal(classifyFailure({ texts: ["connection refused"] }), "runtime_offline");
    assert.equal(classifyFailure({ texts: ["not_admitted: GatewayUnavailable"] }), "runtime_offline");
});

test("fixes: a rate limit holds Retry for a short delay", () => {
    const failedAt = "2026-10-27T10:00:00.000Z";
    const fix = failureFix("rate_limited", { audience: "member", agentId: "a1", taskId: "t1", failedAt });
    assert.equal(fix?.label, "Retry");
    assert.equal(fix?.notBefore, new Date(Date.parse(failedAt) + RATE_LIMIT_RETRY_DELAY_MS).toISOString());
});

test("nudge and retry directives name the task", () => {
    assert.match(agentFixMessage({ kind: "message_agent", agentId: "a1", taskId: "t1", mode: "nudge" }), /^Task Directive for TASK-t1:\nNo progress/);
    assert.match(agentFixMessage({ kind: "message_agent", agentId: "a1", taskId: "t1", mode: "retry" }), /failed\. Please try it again\.$/);
});

test("fixes: Nudge and task Retry go to the task's current assignee, else the run's agent", () => {
    const ctx = { audience: "member" as const, agentId: "runner", taskId: "t1" };
    assert.deepEqual(failureFix("stalled", { ...ctx, taskAssigneeId: "current" }), { label: "Nudge", action: { kind: "message_agent", agentId: "current", taskId: "t1", mode: "nudge" } });
    assert.deepEqual(failureFix("unknown", { ...ctx, taskAssigneeId: "current" }), { label: "Retry", action: { kind: "message_agent", agentId: "current", taskId: "t1", mode: "retry" } });
    // Unassigned: the agent that ran it is the only one left to ask.
    assert.deepEqual(failureFix("stalled", { ...ctx, taskAssigneeId: null }), { label: "Nudge", action: { kind: "message_agent", agentId: "runner", taskId: "t1", mode: "nudge" } });
    // Fixes about the agent itself still point at the agent that failed.
    assert.deepEqual(failureFix("model_unavailable", { ...ctx, taskAssigneeId: "current" }), { label: "Choose a model", action: { kind: "link", href: "/agents?agent=runner" } });
});

// Real-looking provider and runtime errors that quote credentials back.
const LEAKS: Array<{ raw: string; secret: string }> = [
    { raw: "Error code: 401 - Incorrect API key provided: sk-proj-Ab3dEf6hIj9kLm2NoPq5RsTu8VwXyZ1a2b3c4d5e. You can find your API key at platform", secret: "sk-proj-Ab3dEf6hIj9kLm2NoPq5RsTu8VwXyZ1a2b3c4d5e" },
    { raw: "anthropic: invalid x-api-key sk-ant-api03-Zq9vXw8Yt7Us6Rr5Qp4On3Mm2Ll1Kk0Jj", secret: "sk-ant-api03-Zq9vXw8Yt7Us6Rr5Qp4On3Mm2Ll1Kk0Jj" },
    { raw: "stripe refused key sk_live_51HxYzAbCdEfGhIjKlMn", secret: "sk_live_51HxYzAbCdEfGhIjKlMn" },
    { raw: "request failed with header Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", secret: "dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U" },
    { raw: "upstream said: Authorization: Token 9f2c1ab7de34", secret: "9f2c1ab7de34" },
    { raw: "GET /v1beta/models/gemini-pro:generateContent?key=AIzaSyD4kq7Xw2Vb9Nc3Mz8Lp1Ox6Iu5Yt0Re4 returned 400", secret: "AIzaSyD4kq7Xw2Vb9Nc3Mz8Lp1Ox6Iu5Yt0Re4" },
    { raw: "callback /hooks?access_token=ya29.a0AfH6SMBx7 then &api_key=abc123def", secret: "ya29.a0AfH6SMBx7" },
    { raw: "token=ghp_1234567890abcdefABCDEF rejected", secret: "ghp_1234567890abcdefABCDEF" },
    { raw: "boto3 NoCredentials for AKIAIOSFODNN7EXAMPLE in us-east-1", secret: "AKIAIOSFODNN7EXAMPLE" },
    { raw: "signature mismatch for blob wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY+3x9", secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY+3x9" },
    { raw: "checksum 9e107d9d372bb6826bd81d3542a419d6 did not match", secret: "9e107d9d372bb6826bd81d3542a419d6" },
];

test("shown failure text is redacted: keys, bearer tokens, query credentials, AWS keys, blobs", () => {
    for (const { raw, secret } of LEAKS) {
        const shown = shortFailureText(raw, 500);
        assert.ok(shown, raw);
        assert.ok(!shown!.includes(secret), `leaked ${secret} in: ${shown}`);
        assert.match(shown!, /\[secret\]/, raw);
    }
    // The unknown cause's detail goes through the same pass.
    const view = describeFailure({ texts: ["hermes_failed: bad header Authorization: Bearer abcdefgh12345678"] }, { audience: "member" });
    assert.equal(view.cause, "unknown");
    assert.ok(!view.detail!.includes("abcdefgh12345678"), view.detail!);
    // Ordinary failure text survives.
    assert.equal(shortFailureText("hermes_failed"), "hermes_failed");
    assert.equal(shortFailureText("the key insight is that the token expired"), "the key insight is that the token expired");
});

test("classification still reads the raw text (redaction is for display only)", () => {
    assert.equal(classifyFailure({ texts: ["Error code: 401 - Incorrect API key provided: sk-proj-Ab3dEf6hIj9kLm2NoPq5RsTu8Vw"] }), "provider_auth");
});
