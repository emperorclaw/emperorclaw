import { test } from "node:test";
import assert from "node:assert/strict";
import {
    ACTION_CATALOG,
    EXTERNAL_ACTION_KEYS,
    actionKeyForRestRequest,
    applyPolicyChanges,
    restActionForRequest,
    restActorRef,
    changedPolicyKeys,
    normalizePolicyMap,
    resolveActionMode,
} from "../../src/lib/action-policy";
import {
    ACTION_APPROVAL_KIND,
    ACTION_GRANT_TTL_MS,
    PREVIEW_MAX_CHARS,
    PREVIEW_MAX_FIELDS,
    actionBinding,
    hashActionArgs,
    matchActionApproval,
    previewActionArgs,
    redactForApproval,
    stableStringify,
    type ActionApprovalRecord,
    type ActionCall,
} from "../../src/lib/action-policy-rules";
import { selectPendingDecisions } from "../../src/lib/approval-status";

const H = 3_600_000;
const AGENT = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT = "22222222-2222-4222-8222-222222222222";

// ─── Resolution ─────────────────────────────────────────────────────────────

test("defaults: Emperor tools are allowed, risky external actions ask first", () => {
    assert.deepEqual(resolveActionMode("create_task", {}, {}), { mode: "allowed", source: "default" });
    for (const key of ["send_email", "post_social", "spend_money", "delete_data", "deploy"]) {
        assert.equal(resolveActionMode(key, {}, {}).mode, "ask", key);
    }
    assert.equal(resolveActionMode("browse_web", {}, {}).mode, "allowed");
    assert.equal(resolveActionMode("run_shell", {}, {}).mode, "allowed");
    assert.ok(ACTION_CATALOG.filter((e) => e.group === "emperor").every((e) => e.defaultMode === "allowed"));
    assert.deepEqual([...EXTERNAL_ACTION_KEYS].sort(), ["browse_web", "delete_data", "deploy", "post_social", "run_shell", "send_email", "spend_money"]);
});

test("the agent's own setting beats the company default, which beats the built-in default", () => {
    assert.deepEqual(resolveActionMode("send_email", {}, { send_email: "off" }), { mode: "off", source: "company" });
    assert.deepEqual(resolveActionMode("send_email", { send_email: "allowed" }, { send_email: "off" }), { mode: "allowed", source: "agent" });
    assert.deepEqual(resolveActionMode("create_task", { create_task: "ask" }, {}), { mode: "ask", source: "agent" });
});

test("unknown keys and invalid modes are ignored; actions outside the catalog are not governed", () => {
    assert.deepEqual(normalizePolicyMap({ send_email: "off", made_up: "off", deploy: "maybe", run_shell: null }), { send_email: "off" });
    assert.deepEqual(normalizePolicyMap(null), {});
    assert.deepEqual(normalizePolicyMap(["send_email"]), {});
    // An invalid stored mode falls through to the next level.
    assert.equal(resolveActionMode("send_email", { send_email: "sometimes" }, {}).mode, "ask");
    // Reads, request_approval and check_action are never governed.
    for (const key of ["list_tasks", "get_task", "request_approval", "check_action", "made_up"]) {
        assert.deepEqual(resolveActionMode(key, { [key]: "off" }, { [key]: "off" }), { mode: "allowed", source: "unlisted" }, key);
    }
});

test("applyPolicyChanges sets, clears with null, and rejects unknown actions or modes", () => {
    const applied = applyPolicyChanges({ send_email: "off", deploy: "ask" }, { send_email: null, create_task: "ask" });
    assert.ok("map" in applied);
    assert.deepEqual(applied.map, { deploy: "ask", create_task: "ask" });
    assert.match((applyPolicyChanges({}, { nope: "off" }) as { error: string }).error, /Unknown action/);
    assert.match((applyPolicyChanges({}, { send_email: "sometimes" }) as { error: string }).error, /off, ask, allowed or null/);
    assert.ok("error" in applyPolicyChanges({}, "send_email"));
    assert.deepEqual(changedPolicyKeys({ send_email: "off", deploy: "ask" }, { deploy: "ask", create_task: "ask" }), [
        { key: "create_task", before: null, after: "ask" },
        { key: "send_email", before: "off", after: null },
    ]);
});

test("REST requests map to the same action keys as the MCP tools", () => {
    assert.equal(actionKeyForRestRequest("POST", "/api/mcp/messages/send"), "send_message");
    assert.equal(actionKeyForRestRequest("post", "/api/mcp/tasks/"), "create_task");
    assert.equal(actionKeyForRestRequest("PATCH", "/api/mcp/tasks/abc"), "update_task");
    assert.equal(actionKeyForRestRequest("POST", "/api/mcp/tasks/abc/notes"), "add_task_note");
    assert.equal(actionKeyForRestRequest("POST", "/api/mcp/tasks/claim"), "claim_task");
    assert.equal(actionKeyForRestRequest("POST", "/api/mcp/resources"), "create_knowledge_note");
    assert.equal(actionKeyForRestRequest("PUT", "/api/mcp/views/v1/panels/p1"), "update_panel");
    assert.equal(actionKeyForRestRequest("GET", "/api/mcp/tasks"), null, "reads are never governed");
    assert.equal(actionKeyForRestRequest("POST", "/api/mcp/approvals"), null, "asking for approval is never governed");
    assert.equal(actionKeyForRestRequest("POST", "/api/mcp/action-policies/check"), null);
    assert.equal(actionKeyForRestRequest("POST", "/mcp"), null);
});

test("the gate reads the acting agent exactly where each route does", () => {
    const q = new URLSearchParams("agentId=from-query");
    const body = { agentId: "from-body", senderId: "the-sender", mode: "assign" };
    assert.equal(restActorRef(restActionForRequest("POST", "/api/mcp/tasks")!.actor, q, body), "from-body");
    assert.equal(restActorRef(restActionForRequest("POST", "/api/mcp/threads/t1/messages")!.actor, q, body), "the-sender");
    assert.equal(restActorRef("sender", q, { senderType: "human", senderId: "x" }), null);
    assert.equal(restActorRef(restActionForRequest("POST", "/api/mcp/tasks/t1/assign")!.actor, q, body), null, "assign names the assignee, not the actor");
    assert.equal(restActorRef("claim", q, { ...body, mode: "claim" }), "from-body");
    assert.equal(restActorRef(restActionForRequest("POST", "/api/mcp/objectives")!.actor, q, body), "from-query");
    assert.equal(restActorRef(restActionForRequest("PATCH", "/api/mcp/agents/a1")!.actor, q, body), null, "update_agent's id is its subject");
    assert.equal(restActorRef(restActionForRequest("POST", "/api/mcp/requests")!.actor, q, body), null);
});

// ─── Fingerprint ────────────────────────────────────────────────────────────

const ME = actionBinding(AGENT, null);

test("the argument hash ignores key order but not values, the action or the caller", () => {
    assert.equal(stableStringify({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } }), '{"a":{"c":null,"d":[1,{"x":1,"y":2}]},"b":1}');
    const h = hashActionArgs("send_email", { to: "a@b.c", subject: "Hi" }, ME);
    assert.equal(h, hashActionArgs("send_email", { subject: "Hi", to: "a@b.c" }, ME));
    assert.notEqual(h, hashActionArgs("send_email", { to: "a@b.c", subject: "Hi!" }, ME));
    assert.notEqual(h, hashActionArgs("post_social", { to: "a@b.c", subject: "Hi" }, ME));
    assert.notEqual(h, hashActionArgs("send_email", { to: "a@b.c", subject: "Hi" }, actionBinding(OTHER_AGENT, null)), "bound to the agent");
    assert.notEqual(hashActionArgs("deploy", {}, actionBinding(null, "t1")), hashActionArgs("deploy", {}, actionBinding(null, "t2")), "an agentless ask is bound to its token");
    assert.equal(hashActionArgs("deploy", undefined, ME), hashActionArgs("deploy", {}, ME));
});

test("per-turn bookkeeping is ignored at the top level only", () => {
    assert.equal(
        hashActionArgs("send_message", { text: "Hi", replyToMessageId: "m1", ack: true, __route: "/api/mcp/messages/send" }, ME),
        hashActionArgs("send_message", { text: "Hi", replyToMessageId: "m2", __route: "/api/mcp/messages/send" }, ME),
    );
    // The same names deeper down are real content and stay bound.
    assert.notEqual(
        hashActionArgs("create_task", { input: { runId: "r1", title: "x" } }, ME),
        hashActionArgs("create_task", { input: { runId: "r2", title: "x" } }, ME),
    );
});

test("the approval preview shows every field in full, keeps emails and ids, redacts secrets", () => {
    const preview = previewActionArgs({ agentId: AGENT, to: "ops@example.com", apiKey: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789", body: "x ".repeat(1500), cc: null, note: "" });
    assert.ok(preview.ok);
    const byField = new Map(preview.fields.map((f) => [f.field, f.value]));
    assert.equal(byField.get("agentId"), AGENT, "ids are shown");
    assert.equal(byField.get("to"), "ops@example.com", "recipients are shown");
    assert.ok(!byField.get("apiKey")?.includes("abcdefghijklmnop"), `secret leaked: ${byField.get("apiKey")}`);
    assert.equal(byField.get("body")?.length, 3000, "values are never clipped");
    assert.equal(byField.get("cc"), "null");
    assert.equal(byField.get("note"), "");
    // Bookkeeping is not part of the action, so not shown.
    const withTurn = previewActionArgs({ text: "Hi", replyToMessageId: "m1" });
    assert.ok(withTurn.ok && withTurn.fields.every((f) => f.field !== "replyToMessageId"));
    assert.deepEqual(previewActionArgs(null), { ok: true, fields: [] });
});

test("preview keys are redacted too, so an agent can't plant a link", () => {
    const preview = previewActionArgs({ "[Verify](https://evil.example/x)": "yes" });
    assert.ok(preview.ok);
    assert.ok(!preview.fields[0].field.includes("evil.example"), preview.fields[0].field);
});

test("arguments too large to show in full are refused, never cut", () => {
    const many = Object.fromEntries(Array.from({ length: PREVIEW_MAX_FIELDS + 1 }, (_, i) => [`f${i}`, i]));
    assert.equal(previewActionArgs(many).ok, false);
    assert.equal(previewActionArgs({ body: "x".repeat(4_001) }).ok, false);
    assert.equal(previewActionArgs({ a: "x".repeat(3_990), b: "x".repeat(3_990), c: "x".repeat(100) }).ok, false, "total bound");
    assert.equal(previewActionArgs({ a: "x".repeat(3_990), b: "x".repeat(3_990) }).ok, true);
    assert.ok(PREVIEW_MAX_CHARS >= 8_000);
});

// ─── Ask-first approvals: binding, expiry, single use ───────────────────────

function approval(over: Partial<ActionApprovalRecord> & { kind?: string } = {}): ActionApprovalRecord {
    const { kind = ACTION_APPROVAL_KIND, ...rest } = over;
    return {
        id: "a1",
        status: "approved",
        requesterAgentId: AGENT,
        actionType: "send_email",
        argsHash: "h1",
        metadataJson: { kind, actionKey: rest.actionType ?? "send_email" },
        requestedAt: new Date(1_000_000),
        resolvedAt: new Date(1_000_000 + H),
        consumedAt: null,
        ...rest,
    };
}

const call: ActionCall = { agentId: AGENT, actionKey: "send_email", argsHash: "h1" };
const NOW = 1_000_000 + 2 * H;

test("an approved, unused, fresh ask lets the matching call through", () => {
    assert.equal(matchActionApproval([approval()], call, NOW).kind, "grant");
});

test("an approval is bound to the exact agent, action and arguments", () => {
    assert.equal(matchActionApproval([approval({ requesterAgentId: OTHER_AGENT })], call, NOW).kind, "none");
    assert.equal(matchActionApproval([approval({ argsHash: "other" })], call, NOW).kind, "none");
    assert.equal(matchActionApproval([approval({ actionType: "deploy" })], call, NOW).kind, "none");
    assert.equal(matchActionApproval([approval({ kind: "agent_request" })], call, NOW).kind, "none", "a task approval is not an action grant");
    // An agentless (company-wide token) ask never answers an agent's call, nor the reverse.
    assert.equal(matchActionApproval([approval({ requesterAgentId: null })], call, NOW).kind, "none");
    assert.equal(matchActionApproval([approval()], { ...call, agentId: null }, NOW).kind, "none");
});

test("an approval is single use and expires 24h after the decision", () => {
    assert.equal(matchActionApproval([approval({ consumedAt: new Date(NOW - 1000) })], call, NOW).kind, "none");
    const decided = 1_000_000 + H;
    assert.equal(matchActionApproval([approval()], call, decided + ACTION_GRANT_TTL_MS).kind, "grant");
    assert.equal(matchActionApproval([approval()], call, decided + ACTION_GRANT_TTL_MS + 1).kind, "none");
});

test("a pending ask is waited on; a recent rejection or dismissal refuses; old ones don't", () => {
    assert.equal(matchActionApproval([approval({ status: "pending", resolvedAt: null })], call, NOW).kind, "pending");
    assert.equal(matchActionApproval([approval({ status: "rejected" })], call, NOW).kind, "refused");
    assert.equal(matchActionApproval([approval({ status: "dismissed" })], call, NOW).kind, "refused");
    assert.equal(matchActionApproval([approval({ status: "expired" })], call, NOW).kind, "none");
    assert.equal(matchActionApproval([approval({ status: "rejected" })], call, 1_000_000 + H + ACTION_GRANT_TTL_MS + 1).kind, "none");
    // A usable grant wins over an older pending one; a newer ask after a used grant is pending.
    const used = approval({ id: "old", consumedAt: new Date(NOW - 1) });
    const pending = approval({ id: "new", status: "pending", resolvedAt: null, requestedAt: new Date(NOW - 10) });
    assert.deepEqual(matchActionApproval([used, pending], call, NOW), { kind: "pending", approval: pending });
});

test("ask-first approvals count as decisions even with no task", () => {
    const ask = { id: "ask", metadataJson: { kind: ACTION_APPROVAL_KIND } };
    const orphan = { id: "orphan", metadataJson: {} };
    const result = selectPendingDecisions({
        pending: [ask, orphan], links: [], liveLinkedTasks: [], approvalRequiredTasks: [],
        standalone: (a) => (a.metadataJson as { kind?: string }).kind === ACTION_APPROVAL_KIND,
    });
    assert.deepEqual(result.approvals.map((a) => a.approval.id), ["ask"]);
    assert.equal(result.count, 1);
});

test("messages/send acts as from_user_id first, then agentId", () => {
    const route = restActionForRequest("POST", "/api/mcp/messages/send");
    assert.equal(route?.actor, "send");
    assert.equal(restActorRef("send", null, { from_user_id: "agent-x", agentId: "agent-y" }), "agent-x");
    assert.equal(restActorRef("send", null, { agentId: "agent-y" }), "agent-y");
    assert.equal(restActorRef("send", null, {}), null);
});

test("approval redaction keeps digits, emails and ids exactly as written", () => {
    assert.equal(redactForApproval("wire 5000 USD to a@b.com"), "wire 5000 USD to a@b.com");
    assert.equal(redactForApproval("to a@b.com cc c@d.com amount 1"), "to a@b.com cc c@d.com amount 1");
    assert.equal(redactForApproval("id 3f2b8c1e-1111-2222-3333-444455556666 qty 7"), "id 3f2b8c1e-1111-2222-3333-444455556666 qty 7");
    assert.match(redactForApproval("token sk-ant-abcdefghijklmnopqrstuvwxyz123456 x 9"), /\[secret\] x 9$/);
});
