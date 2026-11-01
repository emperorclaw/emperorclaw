import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWebhookFormat, notificationEmailHtml, webhookPayload } from "../../src/lib/notifications";
import { providerIssueFromReason, scoreAgent } from "../../src/lib/agent-health";
import { classifyFailure, isCreditsFailureText } from "../../src/lib/failure-cause";

test("webhook format is detected from the URL host", () => {
    assert.equal(detectWebhookFormat("https://hooks.slack.com/services/T/B/x"), "slack");
    assert.equal(detectWebhookFormat("https://discord.com/api/webhooks/1/abc"), "discord");
    assert.equal(detectWebhookFormat("https://example.com/hook"), "generic");
    assert.equal(detectWebhookFormat("not a url"), "generic");
});

test("webhook payloads match each platform", () => {
    const input = { kind: "approval" as const, title: "Viktor requests approval", body: "Send the Q4 campaign" };
    assert.deepEqual(webhookPayload("slack", input, "https://emperor.example/approvals"), {
        text: "*Viktor requests approval*\nSend the Q4 campaign\nhttps://emperor.example/approvals",
    });
    const discord = webhookPayload("discord", input, null) as { content: string };
    assert.ok(discord.content.startsWith("**Viktor requests approval**"));
    const generic = webhookPayload("generic", input, "https://e/x") as Record<string, unknown>;
    assert.equal(generic.kind, "approval");
    assert.equal(generic.source, "emperorclaw");
});

test("notification emails escape agent-written content", () => {
    const html = notificationEmailHtml('<script>alert(1)</script> "hi"', "<img src=x onerror=alert(1)>", "https://e/x?a=1&b=2");
    assert.ok(!html.includes("<script>"));
    assert.ok(!html.includes("<img"));
    assert.ok(html.includes("&lt;script&gt;"));
    assert.ok(html.includes("a=1&amp;b=2"));
});

test("scoreAgent: down only when offline with work waiting", () => {
    const base = { online: true, unanswered: 0, failed: 0, overdueTasks: 0, budgetStatus: "active", requests: 3, replies: 3 };
    assert.deepEqual(scoreAgent(base), { status: "healthy", reasons: [], reasonCopies: [] });
    assert.equal(scoreAgent({ ...base, unanswered: 2 }).status, "attention");
    assert.deepEqual(scoreAgent({ ...base, online: false, unanswered: 2 }).reasons[0], "offline with work waiting");
    assert.equal(scoreAgent({ ...base, online: false, unanswered: 2 }).status, "down");
    assert.equal(scoreAgent({ ...base, online: false, requests: 0, replies: 0 }).status, "idle");
    assert.equal(scoreAgent({ ...base, failed: 1 }).reasons[0], "1 message failed");
    assert.equal(scoreAgent({ ...base, budgetStatus: "paused_budget" }).reasons[0], "budget paused budget");
});

test("scoreAgent: an out-of-credits provider is named and the agent is down", () => {
    const base = { online: true, unanswered: 0, failed: 1, overdueTasks: 0, budgetStatus: "active", requests: 3, replies: 2 };
    const issue = providerIssueFromReason("LLM provider out of credits (HTTP 402): add credits for this agent's API key, then retry");
    assert.equal(issue, "LLM provider out of credits");
    const scored = scoreAgent({ ...base, providerIssue: issue });
    assert.deepEqual({ status: scored.status, reasons: scored.reasons }, { status: "down", reasons: ["LLM provider out of credits", "1 message failed"] });
    assert.deepEqual(scored.reasonCopies.map((c) => c.key), ["agents.health.reasons.providerCredits", "agents.health.reasons.failed"]);
    // Online and heartbeating is not enough: it still cannot answer.
    assert.equal(scoreAgent({ ...base, providerIssue: issue }).status, "down");
    assert.equal(scoreAgent({ ...base, providerIssue: null }).status, "attention");
});

test("providerIssueFromReason only matches credit exhaustion", () => {
    assert.equal(providerIssueFromReason("Billing or credits exhausted: HTTP 402: Insufficient credits."), "LLM provider out of credits");
    assert.equal(providerIssueFromReason("Hermes exited with status 1"), null);
    assert.equal(providerIssueFromReason("read 4021 bytes"), null);
    assert.equal(providerIssueFromReason(null), null);
    assert.equal(providerIssueFromReason(42), null);
});

test("providerIssueFromReason uses the same credits wording as failure-cause", () => {
    for (const reason of [
        "Payment Required",
        "Your credit balance is too low to access the Anthropic API",
        "You exceeded your current quota, please check your plan and billing details",
        "402",
        "402: no credits left",
        "Error code: 402 - {'error': 'insufficient_quota'}",
    ]) {
        assert.equal(providerIssueFromReason(reason), "LLM provider out of credits", reason);
        assert.equal(isCreditsFailureText(reason), true, reason);
    }
    // What the run view calls out of credits, health does too.
    assert.equal(classifyFailure({ texts: ["Your credit balance is too low"] }), "provider_credits");
    for (const reason of ["Request timed out after 402 seconds", "HTTP 401 Unauthorized", "status 4020", ""]) {
        assert.equal(providerIssueFromReason(reason), null, reason);
    }
});
