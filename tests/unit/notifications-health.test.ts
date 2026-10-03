import { test } from "node:test";
import assert from "node:assert/strict";
import { detectWebhookFormat, notificationEmailHtml, webhookPayload } from "../../src/lib/notifications";
import { scoreAgent } from "../../src/lib/agent-health";

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
    assert.deepEqual(scoreAgent(base), { status: "healthy", reasons: [] });
    assert.equal(scoreAgent({ ...base, unanswered: 2 }).status, "attention");
    assert.deepEqual(scoreAgent({ ...base, online: false, unanswered: 2 }).reasons[0], "offline with work waiting");
    assert.equal(scoreAgent({ ...base, online: false, unanswered: 2 }).status, "down");
    assert.equal(scoreAgent({ ...base, online: false, requests: 0, replies: 0 }).status, "idle");
    assert.equal(scoreAgent({ ...base, failed: 1 }).reasons[0], "1 message failed");
    assert.equal(scoreAgent({ ...base, budgetStatus: "paused_budget" }).reasons[0], "budget paused budget");
});
