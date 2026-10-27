import test from "node:test";
import assert from "node:assert/strict";
import {
    auditSentenceText, auditTargetHref, changedFields, describeAuditEntry, formatAuditValue, redactAuditPayload, scopeAuditFields,
} from "../../src/lib/audit-format";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN_ID = "33333333-3333-4333-8333-333333333333";

test("redaction keeps only the target's allowlisted fields", () => {
    const payload = redactAuditPayload("agent", {
        before: { name: "Scout", memory: "private notes", llmApiKeyEncrypted: "abc", doctrineJson: { soul: "…" } },
        after: { name: "Scout 2", role: "QA", skillsJson: ["x"], monthlyBudgetCents: 500, prompt: "do the thing" },
        meta: { label: "Scout 2", tokenId: TOKEN_ID, text: "hello", apiKey: "sk-123" },
    });
    assert.deepEqual(payload, {
        before: { name: "Scout" },
        after: { name: "Scout 2", role: "QA", monthlyBudgetCents: 500 },
        meta: { label: "Scout 2", tokenId: TOKEN_ID },
    });
});

test("redaction drops chat text, note bodies and secrets on every target", () => {
    for (const target of ["task", "knowledge_note", "company", "member", "approval"]) {
        const payload = redactAuditPayload(target, {
            after: { text: "a private chat message", content: "# note body", configText: "body", secretText: "s", token: "ec_live_abcdef123456", password: "hunter2", resolutionNote: "why" },
            meta: { message: "hi", note: "x", body: "y" },
        });
        assert.deepEqual(payload, {}, `${target} kept a free-text or secret field`);
    }
});

test("redaction scrubs secrets inside allowlisted labels and rejects malformed values", () => {
    const payload = redactAuditPayload("task", {
        after: { title: "Deploy with key sk-abcdefghijklmnop", state: "in progress; DROP TABLE", priority: "high", projectId: "not-a-uuid" },
    });
    assert.equal(payload.after?.title, "Deploy with key [secret]");
    assert.equal(payload.after?.state, undefined, "an enum with odd characters is dropped");
    assert.equal(payload.after?.priority, undefined, "a number field only keeps numbers");
    assert.equal(payload.after?.projectId, undefined, "an id field only keeps uuids");
});

test("redaction caps label length and keeps unknown targets empty", () => {
    const payload = redactAuditPayload("project", { after: { name: "x".repeat(500) } });
    assert.ok(String(payload.after?.name).length <= 160);
    assert.deepEqual(redactAuditPayload("artifact", { after: { name: "file.pdf" }, meta: { tokenId: TOKEN_ID } }), { meta: { tokenId: TOKEN_ID } });
});

test("changedFields keeps only the keys whose value changed", () => {
    assert.deepEqual(
        changedFields({ name: "A", role: "QA", llmModel: "m1" }, { name: "A", role: "Dev", llmModel: "m1" }),
        { before: { role: "QA" }, after: { role: "Dev" } },
    );
    assert.deepEqual(changedFields({ a: [1, 2] }, { a: [1, 2] }), { before: {}, after: {} });
});

test("scopeAuditFields flattens a scope_json into sorted id lists", () => {
    assert.deepEqual(scopeAuditFields({ mode: "restricted", customerIds: ["b", "a"], projectIds: [] }), {
        scopeMode: "restricted", scopeCustomerIds: ["a", "b"], scopeProjectIds: [], scopeAgentIds: null,
    });
    assert.equal(scopeAuditFields(null).scopeMode, "all");
});

test("the sentence names the actor, verb, target and detail", () => {
    const sentence = describeAuditEntry({
        action: "task.state_changed", targetType: "task", targetId: AGENT_ID, actorType: "human", actorName: "Ana",
        payload: { before: { state: "inbox" }, after: { state: "review" }, meta: { label: "Fix login" } },
    });
    assert.equal(auditSentenceText(sentence), "Ana moved task Fix login to Review");
});

test("the sentence resolves assignees, budgets and falls back for unnamed actors", () => {
    assert.equal(auditSentenceText(describeAuditEntry({
        action: "task.assigned", targetType: "task", targetId: AGENT_ID, actorType: "agent", actorName: null,
        payload: { after: { assigneeType: "agent", assigneeId: AGENT_ID }, meta: { label: "Write copy" } },
    }, { [AGENT_ID]: "Scout" })), "An agent reassigned task Write copy to Scout");
    assert.equal(auditSentenceText(describeAuditEntry({
        action: "agent.budget_changed", targetType: "agent", targetId: AGENT_ID, actorType: "system", actorName: null,
        payload: { before: { monthlyBudgetCents: 0 }, after: { monthlyBudgetCents: 2500 }, meta: { label: "Scout" } },
    })), "System changed the budget of agent Scout to $25.00 a month");
    assert.equal(auditSentenceText(describeAuditEntry({
        action: "company.settings_changed", targetType: "company", targetId: AGENT_ID, actorType: "human", actorName: "Ana",
        payload: { after: { directChatMode: "private" }, meta: { setting: "directChatMode" } },
    })), "Ana changed company settings (direct chat mode)");
    assert.equal(auditSentenceText(describeAuditEntry({
        action: "member.role_changed", targetType: "member", targetId: USER_ID, actorType: "human", actorName: "Ana",
        payload: { before: { role: "member" }, after: { role: "admin" }, meta: { label: "bo@example.com" } },
    })), "Ana changed the role of bo@example.com to admin");
});

test("unknown legacy actions still read as a sentence", () => {
    const sentence = describeAuditEntry({ action: "register_agent", targetType: "agent", targetId: AGENT_ID, actorType: "system", actorName: null, payload: { after: { name: "Scout" } } });
    assert.equal(auditSentenceText(sentence), "System created agent Scout");
});

test("target links go to the task page, agent panel, project and settings", () => {
    assert.equal(auditTargetHref("task", AGENT_ID, {}), `/projects/tasks/${AGENT_ID}`);
    assert.equal(auditTargetHref("agent", AGENT_ID, {}), `/agents?agent=${AGENT_ID}`);
    assert.equal(auditTargetHref("project", AGENT_ID, {}), `/projects?project=${AGENT_ID}`);
    assert.equal(auditTargetHref("member", USER_ID, {}), "/settings/members");
    assert.equal(auditTargetHref("approval", AGENT_ID, { after: { taskIds: [USER_ID] } }), `/projects/tasks/${USER_ID}`);
    assert.equal(auditTargetHref("artifact", AGENT_ID, {}), null);
});

test("diff values read as words", () => {
    assert.equal(formatAuditValue("monthlyBudgetCents", 0), "no limit");
    assert.equal(formatAuditValue("state", "in_progress"), "In progress");
    assert.equal(formatAuditValue("scopeAgentIds", null), "all");
    assert.equal(formatAuditValue("scopeProjectIds", [AGENT_ID], { [AGENT_ID]: "Site" }), "Site");
    assert.equal(formatAuditValue("leadAgentId", AGENT_ID), "(removed)");
});

test("a person's email label is kept; free text in it is still redacted", () => {
    const member = redactAuditPayload("member", { meta: { label: "Bo@Example.com", email: "bo@example.com" } });
    assert.deepEqual(member.meta, { label: "bo@example.com", email: "bo@example.com" });
    const invitation = redactAuditPayload("invitation", { after: { email: "new@example.com", role: "member" }, meta: { label: "new@example.com" } });
    assert.equal(invitation.meta?.label, "new@example.com");
    assert.equal(redactAuditPayload("member", { meta: { label: "Ana (ana@example.com) token=abc123" } }).meta?.label, "Ana ([email]) token=[secret]");
    // Other targets still scrub an email out of a label.
    assert.equal(redactAuditPayload("customer", { meta: { label: "bo@example.com" } }).meta?.label, "[email]");
    // An older member row whose label was redacted falls back to the stored email.
    assert.equal(describeAuditEntry({
        action: "invitation.revoked", targetType: "invitation", targetId: USER_ID, actorType: "human", actorName: "Ana",
        payload: { before: { email: "old@example.com" }, meta: { label: "[email]" } },
    }).label, "old@example.com");
});

test("pricing changes are allowlisted and read as a sentence", () => {
    const payload = redactAuditPayload("pricing", {
        before: { inputPricePer1k: 27, label: "x", apiKey: "sk-123" },
        after: { inputPricePer1k: 30, provider: "deepseek", model: "deepseek-chat", active: true },
        meta: { label: "DeepSeek Chat" },
    });
    assert.deepEqual(payload, {
        before: { inputPricePer1k: 27 },
        after: { inputPricePer1k: 30, provider: "deepseek", model: "deepseek-chat", active: true },
        meta: { label: "DeepSeek Chat" },
    });
    assert.equal(auditSentenceText(describeAuditEntry({ action: "pricing.updated", targetType: "pricing", targetId: AGENT_ID, actorType: "human", actorName: "Ana", payload })), "Ana changed pricing for DeepSeek Chat");
    assert.equal(formatAuditValue("inputPricePer1k", 30), "$0.30 per 1M tokens");
    assert.equal(auditTargetHref("pricing", AGENT_ID, payload), "/costs?tab=budgets");
});

test("audit builders never throw into the mutation", async () => {
    const { recordAgentChange, recordAudits, recordProjectAudit, recordTaskChange, taskChangeEntries } = await import("../../src/lib/audit");
    const hostile = new Proxy({ id: AGENT_ID }, { get: () => { throw new Error("boom"); } }) as never;
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
        assert.deepEqual(taskChangeEntries(AGENT_ID, { type: "system", id: null }, hostile, hostile), []);
        await recordTaskChange(AGENT_ID, { type: "system", id: null }, hostile, hostile);
        await recordAgentChange(AGENT_ID, { type: "system", id: null }, hostile, hostile);
        await recordProjectAudit(AGENT_ID, { type: "system", id: null }, "project.created", hostile);
        await recordAudits([hostile]);
    } finally {
        console.error = originalError;
    }
    assert.ok(errors.length >= 4, "each failure is logged");
});
