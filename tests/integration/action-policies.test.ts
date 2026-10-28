/**
 * Agent action permissions (off / ask first / allowed), through the real MCP
 * server, the agent REST API and the human routes, against a real DB:
 *   - off refuses with a message the agent can act on, and nothing runs;
 *   - ask creates one approval (no project, decision kind) and blocks;
 *   - an approval lets exactly one matching call through, then asks again;
 *   - other arguments stay blocked; check_action follows the same rules;
 *   - another company's approvals and settings never apply;
 *   - only owners and admins edit; changes are recorded with before/after.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, resetDb, seedAgent } from "./_helper";
import { actAs, bearer, call, mcpClientFor, seedHuman, seedMcpToken } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

async function company(name: string) {
    const db = await getDb();
    const { users, companies } = await getSchema();
    const [creator] = await db.insert(users).values({ email: `c-${randomUUID()}@example.com`, passwordHash: "x" }).returning();
    const [row] = await db.insert(companies).values({ name, createdByUserId: creator.id }).returning();
    return row.id;
}

async function setAgentPolicies(agentId: string, map: Record<string, string>) {
    const db = await getDb();
    const { agents } = await getSchema();
    const { eq } = await import("drizzle-orm");
    await db.update(agents).set({ actionPoliciesJson: map }).where(eq(agents.id, agentId));
}

async function approvalsOf(companyId: string) {
    const db = await getDb();
    const { approvals } = await getSchema();
    const { eq } = await import("drizzle-orm");
    return db.select().from(approvals).where(eq(approvals.companyId, companyId));
}

async function projectNames(companyId: string) {
    const db = await getDb();
    const { projects } = await getSchema();
    const { eq } = await import("drizzle-orm");
    return (await db.select({ goal: projects.goal }).from(projects).where(eq(projects.companyId, companyId))).map((p) => p.goal).sort();
}

const decide = async (approvalId: string, status: "approved" | "rejected") =>
    call((await import("@/app/api/approvals/[id]/route")).PATCH as never, `/api/approvals/${approvalId}`, { method: "PATCH", body: { status }, params: { id: approvalId } });

const putAgentPolicies = async (agentId: string, policies: Record<string, unknown>) =>
    call((await import("@/app/api/agents/[id]/action-policies/route")).PUT as never, `/api/agents/${agentId}/action-policies`, { method: "PUT", body: { policies }, params: { id: agentId } });

const getAgentPolicies = async (agentId: string) =>
    call((await import("@/app/api/agents/[id]/action-policies/route")).GET as never, `/api/agents/${agentId}/action-policies`, { params: { id: agentId } });

function parse(text: string) {
    return JSON.parse(text) as Record<string, unknown>;
}

maybe("off refuses an Emperor tool over MCP and REST; nothing runs", async () => {
    await resetDb();
    const co = await company("Off Co");
    const agent = await seedAgent(co, { name: "Ada" });
    await setAgentPolicies(agent.id, { create_project: "off" });

    const mcp = await mcpClientFor(co, agent.id);
    const res = await mcp.tool("create_project", { goal: "Forbidden project" });
    assert.equal(res.isError, true);
    const body = parse(res.text);
    assert.equal(body.executed, false);
    assert.equal(body.status, "off");
    assert.match(String(body.message), /turned off/);

    // REST, with a company-wide token naming the agent (how fleet bridges call).
    const token = await seedMcpToken(co, null);
    const { POST } = await import("@/app/api/mcp/projects/route");
    const rest = await call(POST as never, "/api/mcp/projects", {
        method: "POST", headers: { ...bearer(token), "Idempotency-Key": randomUUID() }, body: { goal: "Forbidden by REST", agentId: agent.id },
    });
    assert.equal(rest.status, 403, rest.text);
    assert.match(String(rest.json.error), /turned off/);

    assert.deepEqual(await projectNames(co), []);
    assert.equal((await approvalsOf(co)).length, 0, "off never asks");

    // Reads stay allowed, and an operator connection (no agent) is not governed.
    assert.equal((await mcp.tool("list_projects", {})).isError, false);
    const operator = await mcpClientFor(co, null);
    assert.equal((await operator.tool("create_project", { goal: "Operator project" })).isError, false);
});

maybe("ask creates one approval and blocks; approval lets exactly one matching call through", async () => {
    await resetDb();
    const co = await company("Ask Co");
    const agent = await seedAgent(co, { name: "Ben" });
    const owner = await seedHuman(co, "owner");
    await setAgentPolicies(agent.id, { create_project: "ask" });
    const mcp = await mcpClientFor(co, agent.id);

    const first = await mcp.tool("create_project", { goal: "Launch site" });
    assert.equal(first.isError, true);
    const pending = parse(first.text);
    assert.equal(pending.status, "approval_pending");
    const approvalId = String(pending.approvalId);
    assert.deepEqual(await projectNames(co), [], "nothing ran while waiting");

    // Asking again with the same arguments waits on the same approval.
    assert.equal(parse((await mcp.tool("create_project", { goal: "Launch site" })).text).approvalId, approvalId);
    const rows = await approvalsOf(co);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, "pending");
    assert.equal(rows[0].projectId, null);
    assert.equal(rows[0].requesterAgentId, agent.id);
    assert.equal(rows[0].actionType, "create_project");
    assert.equal((rows[0].metadataJson as { kind?: string }).kind, "action_policy");

    // It is a decision in the Inbox even though it has no task.
    const { listPendingDecisions } = await import("@/lib/approvals");
    assert.deepEqual((await listPendingDecisions(co)).approvals.map((a) => a.approval.id), [approvalId]);

    actAs(owner);
    const decision = await decide(approvalId, "approved");
    assert.equal(decision.status, 200, decision.text);

    // Different arguments are still blocked (a new ask), and don't use the approval up.
    const other = await mcp.tool("create_project", { goal: "Another site" });
    assert.equal(parse(other.text).status, "approval_pending");
    assert.notEqual(parse(other.text).approvalId, approvalId);
    assert.deepEqual(await projectNames(co), []);

    // The exact call runs once...
    const ok = await mcp.tool("create_project", { goal: "Launch site" });
    assert.equal(ok.isError, false, ok.text);
    assert.deepEqual(await projectNames(co), ["Launch site"]);
    // ...and only once: the next identical call asks again.
    const again = await mcp.tool("create_project", { goal: "Launch site" });
    assert.equal(parse(again.text).status, "approval_pending");
    assert.notEqual(parse(again.text).approvalId, approvalId);
    assert.deepEqual(await projectNames(co), ["Launch site"]);
    const used = (await approvalsOf(co)).find((a) => a.id === approvalId);
    assert.ok(used?.consumedAt, "the approval is marked used");
});

maybe("a rejection refuses the same request; REST asks answer 409 with the approval id", async () => {
    await resetDb();
    const co = await company("Reject Co");
    const agent = await seedAgent(co, { name: "Cy" });
    const owner = await seedHuman(co, "owner");
    await setAgentPolicies(agent.id, { create_project: "ask" });
    const token = await seedMcpToken(co, agent.id);
    const { POST } = await import("@/app/api/mcp/projects/route");
    const post = () => call(POST as never, "/api/mcp/projects", { method: "POST", headers: { ...bearer(token), "Idempotency-Key": randomUUID() }, body: { goal: "Risky" } });

    const asked = await post();
    assert.equal(asked.status, 409, asked.text);
    const [row] = await approvalsOf(co);
    assert.ok(String(asked.json.error).includes(row.id), "the message names the approval");

    actAs(owner);
    assert.equal((await decide(row.id, "rejected")).status, 200);
    const refused = await post();
    assert.equal(refused.status, 403);
    assert.match(String(refused.json.error), /rejected/);
    assert.equal((await approvalsOf(co)).length, 1, "a refused request is not asked again");
    assert.deepEqual(await projectNames(co), []);
});

maybe("check_action: risky external actions ask first, then allow one matching use", async () => {
    await resetDb();
    const co = await company("Check Co");
    const agent = await seedAgent(co, { name: "Dee" });
    const owner = await seedHuman(co, "owner");
    const mcp = await mcpClientFor(co, agent.id);
    const details = { to: "client@example.com", subject: "Quote" };

    const asked = parse((await mcp.tool("check_action", { action: "send_email", details })).text);
    assert.equal(asked.decision, "approval_pending");
    assert.equal(asked.mayProceed, false);
    assert.equal(parse((await mcp.tool("check_action", { action: "browse_web", details: { url: "https://example.com" } })).text).mayProceed, true);

    actAs(owner);
    assert.equal((await decide(String(asked.approvalId), "approved")).status, 200);

    assert.equal(parse((await mcp.tool("check_action", { action: "send_email", details: { ...details, subject: "Other" } })).text).mayProceed, false, "other details stay blocked");
    // REST form of the same check (what the Hermes plugin calls).
    const token = await seedMcpToken(co, agent.id);
    const { POST } = await import("@/app/api/mcp/action-policies/check/route");
    const ok = await call(POST as never, "/api/mcp/action-policies/check", { method: "POST", headers: bearer(token), body: { action: "send_email", details } });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.json.mayProceed, true);
    assert.equal(ok.json.approvalId, asked.approvalId);
    assert.equal(parse((await mcp.tool("check_action", { action: "send_email", details })).text).mayProceed, false, "single use");

    await setAgentPolicies(agent.id, { run_shell: "off" });
    const off = parse((await mcp.tool("check_action", { action: "run_shell", details: { command: "ls" } })).text);
    assert.equal(off.decision, "off");
    assert.equal(off.mayProceed, false);
});

maybe("another company's approvals and settings never apply", async () => {
    await resetDb();
    const coA = await company("A");
    const coB = await company("B");
    const agentA = await seedAgent(coA, { name: "Eve" });
    const agentB = await seedAgent(coB, { name: "Eve" });
    const ownerA = await seedHuman(coA, "owner");
    const ownerB = await seedHuman(coB, "owner");

    // Company A turns email off for everyone; B keeps the default (ask).
    actAs(ownerA);
    const { PUT } = await import("@/app/api/action-policies/route");
    assert.equal((await call(PUT as never, "/api/action-policies", { method: "PUT", body: { policies: { send_email: "off" } } })).status, 200);
    const details = { to: "x@example.com" };
    assert.equal(parse((await (await mcpClientFor(coA, agentA.id)).tool("check_action", { action: "send_email", details })).text).decision, "off");
    const askB = parse((await (await mcpClientFor(coB, agentB.id)).tool("check_action", { action: "send_email", details })).text);
    assert.equal(askB.decision, "approval_pending");

    // A's owner can neither decide B's approval nor read B's agent settings.
    assert.equal((await decide(String(askB.approvalId), "approved")).status, 404);
    assert.equal((await getAgentPolicies(agentB.id)).status, 404);
    assert.equal((await putAgentPolicies(agentB.id, { send_email: "allowed" })).status, 404);
    const [rowB] = await approvalsOf(coB);
    assert.equal(rowB.status, "pending");

    // B approves its own; A's agent with the same details still gets "off".
    actAs(ownerB);
    assert.equal((await decide(String(askB.approvalId), "approved")).status, 200);
    assert.equal(parse((await (await mcpClientFor(coA, agentA.id)).tool("check_action", { action: "send_email", details })).text).decision, "off");
    assert.equal(parse((await (await mcpClientFor(coB, agentB.id)).tool("check_action", { action: "send_email", details })).text).mayProceed, true);
});

maybe("only owners and admins edit permissions; each change is recorded with before and after", async () => {
    await resetDb();
    const co = await company("Roles Co");
    const agent = await seedAgent(co, { name: "Finn" });
    const member = await seedHuman(co, "member");
    const viewer = await seedHuman(co, "viewer");
    const admin = await seedHuman(co, "admin");

    actAs(viewer);
    const seen = await getAgentPolicies(agent.id);
    assert.equal(seen.status, 200);
    assert.equal(seen.json.canEdit, false);
    assert.equal((await putAgentPolicies(agent.id, { send_email: "allowed" })).status, 403);
    actAs(member);
    assert.equal((await putAgentPolicies(agent.id, { send_email: "allowed" })).status, 403);
    const { PUT } = await import("@/app/api/action-policies/route");
    assert.equal((await call(PUT as never, "/api/action-policies", { method: "PUT", body: { policies: { deploy: "off" } } })).status, 403);

    actAs(admin);
    assert.equal((await putAgentPolicies(agent.id, { nope: "off" })).status, 400);
    const saved = await putAgentPolicies(agent.id, { send_email: "allowed", deploy: "off" });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.json.agentPolicies, { send_email: "allowed", deploy: "off" });
    assert.equal((await putAgentPolicies(agent.id, { send_email: null })).status, 200);

    const db = await getDb();
    const { auditLog } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const audit = (await db.select().from(auditLog).where(eq(auditLog.companyId, co)))
        .filter((row) => row.action === "agent.permission_changed")
        .map((row) => ({ target: row.targetId, actor: row.actorId, payload: row.payloadJson as { before?: Record<string, unknown>; after?: Record<string, unknown> } }));
    assert.equal(audit.length, 3);
    assert.ok(audit.every((row) => row.target === agent.id && row.actor === admin.userId));
    const changes = audit.map((row) => `${row.payload.after?.actionKey}:${row.payload.before?.permission ?? "-"}>${row.payload.after?.permission ?? "-"}`).sort();
    assert.deepEqual(changes, ["deploy:->off", "send_email:->allowed", "send_email:allowed>-"]);
});

async function seedThread(companyId: string, type: "team" | "direct" = "team", directAgentId: string | null = null) {
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const [thread] = await db.insert(messageThreads).values({ companyId, type, title: `${type} thread`, directAgentId }).returning();
    return thread;
}

async function seedHumanMessage(companyId: string, threadId: string, text: string, targetAgentId: string | null) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const [message] = await db.insert(threadMessages).values({ companyId, threadId, senderType: "human", text, targetAgentId, deliveryState: "queued" }).returning();
    return message;
}

const sendRoute = async () => (await import("@/app/api/mcp/messages/send/route")).POST;
const threadPostRoute = async () => (await import("@/app/api/mcp/threads/[id]/messages/route")).POST;

maybe("chat replies: a verified reply passes 'ask'; forged or foreign reply ids are governed on both routes", async () => {
    await resetDb();
    const co = await company("Reply Co");
    const agent = await seedAgent(co, { name: "Gus" });
    const other = await seedAgent(co, { name: "Hal" });
    const token = await seedMcpToken(co, null); // company-wide, how fleet bridges call
    const team = await seedThread(co);
    const elsewhere = await seedThread(co, "direct", agent.id);
    const forMe = await seedHumanMessage(co, team.id, "Gus, status please?", agent.id);
    const mentioned = await seedHumanMessage(co, team.id, "@Gus can you check this?", null);
    const forOther = await seedHumanMessage(co, team.id, "Hal, status please?", other.id);
    const otherThread = await seedHumanMessage(co, elsewhere.id, "Gus, over here", agent.id);
    const send = await sendRoute();
    const post = (body: Record<string, unknown>) => call(send as never, "/api/mcp/messages/send", { method: "POST", headers: { ...bearer(token), "Idempotency-Key": randomUUID() }, body });

    // Defaults: replies go through.
    const defaultReply = await post({ text: "Default reply", agentId: agent.id, thread_id: team.id, replyToMessageId: forMe.id });
    assert.equal(defaultReply.status, 200, defaultReply.text);

    await setAgentPolicies(agent.id, { send_message: "ask" });
    const reply = await post({ text: "On it", agentId: agent.id, thread_id: team.id, replyToMessageId: forMe.id });
    assert.equal(reply.status, 200, reply.text);
    const mentionReply = await post({ text: "Checked", agentId: agent.id, replyToMessageId: mentioned.id });
    assert.equal(mentionReply.status, 200, mentionReply.text);
    assert.equal((await approvalsOf(co)).length, 0, "verified replies never ask");

    // Not addressed to this agent, another thread than the one posted to, a made-up id, or none: governed.
    for (const forged of [
        { replyToMessageId: forOther.id, thread_id: team.id },
        { replyToMessageId: otherThread.id, thread_id: team.id },
        { replyToMessageId: randomUUID(), thread_id: team.id },
        { thread_id: team.id },
    ]) {
        const res = await post({ text: `Forged ${JSON.stringify(forged)}`, agentId: agent.id, ...forged });
        assert.equal(res.status, 409, `${JSON.stringify(forged)}: ${res.text}`);
    }
    // Another company's message id is no reply either.
    const theirs = await company("Their Co");
    const theirAgent = await seedAgent(theirs, { name: "Gus" });
    const theirMessage = await seedHumanMessage(theirs, (await seedThread(theirs)).id, "hi", theirAgent.id);
    assert.equal((await post({ text: "Cross-company", agentId: agent.id, replyToMessageId: theirMessage.id })).status, 409);

    // The raw thread route has no reply exemption at all, and acts as senderId.
    const threadPost = await threadPostRoute();
    const viaThread = await call(threadPost as never, `/api/mcp/threads/${team.id}/messages`, {
        method: "POST", headers: bearer(token), params: { id: team.id },
        body: { text: "Via thread route", senderId: agent.id, replyToMessageId: forMe.id },
    });
    assert.equal(viaThread.status, 409, viaThread.text);
    await setAgentPolicies(agent.id, { send_message: "off" });
    const off = await call(threadPost as never, `/api/mcp/threads/${team.id}/messages`, {
        method: "POST", headers: bearer(token), params: { id: team.id }, body: { text: "Off", senderId: agent.id },
    });
    assert.equal(off.status, 403, off.text);
    // A verified reply on /messages/send still goes through when off.
    assert.equal((await post({ text: "Answer anyway", agentId: agent.id, thread_id: team.id, replyToMessageId: forMe.id })).status, 200);
});

maybe("no agent named: the company policy applies, never a free pass", async () => {
    await resetDb();
    const co = await company("Agentless Co");
    const owner = await seedHuman(co, "owner");
    actAs(owner);
    const { PUT } = await import("@/app/api/action-policies/route");
    assert.equal((await call(PUT as never, "/api/action-policies", { method: "PUT", body: { policies: { create_project: "off" } } })).status, 200);

    const token = await seedMcpToken(co, null);
    const { POST } = await import("@/app/api/mcp/projects/route");
    const rest = await call(POST as never, "/api/mcp/projects", { method: "POST", headers: { ...bearer(token), "Idempotency-Key": randomUUID() }, body: { goal: "No agent named" } });
    assert.equal(rest.status, 403, rest.text);
    const unknown = await call(POST as never, "/api/mcp/projects", { method: "POST", headers: { ...bearer(token), "Idempotency-Key": randomUUID() }, body: { goal: "Ghost agent", agentId: "Nobody" } });
    assert.equal(unknown.status, 403, "an agent name that doesn't resolve is not a way around it");

    const operator = await mcpClientFor(co, null);
    assert.equal(parse((await operator.tool("create_project", { goal: "Operator project" })).text).status, "off");
    const asked = parse((await operator.tool("check_action", { action: "send_email", details: { to: "a@example.com" } })).text);
    assert.equal(asked.decision, "approval_pending", "an agentless ask is created, bound to the connection");
    const [row] = await approvalsOf(co);
    assert.equal(row.requesterAgentId, null);
    assert.deepEqual(await projectNames(co), []);
});

maybe("asks are bounded: one pending ask per exact call, at most 20 per agent, nothing too large to show", async () => {
    await resetDb();
    const co = await company("Bounds Co");
    const agent = await seedAgent(co, { name: "Ivy" });
    const mcp = await mcpClientFor(co, agent.id);

    const same = { action: "send_email", details: { to: "x@example.com", subject: "Same" } };
    const [a, b] = await Promise.all([mcp.tool("check_action", same), mcp.tool("check_action", same)]);
    assert.equal(parse(a.text).approvalId, parse(b.text).approvalId, "concurrent identical asks share one approval");
    assert.equal((await approvalsOf(co)).length, 1);

    const tooBig = parse((await mcp.tool("check_action", { action: "deploy", details: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, i])) })).text);
    assert.equal(tooBig.decision, "refused");
    assert.equal(tooBig.mayProceed, false);
    assert.match(String(tooBig.message), /can't be shown for approval/);
    assert.equal((await approvalsOf(co)).length, 1, "nothing too large is asked");

    for (let i = 1; i < 20; i++) {
        assert.equal(parse((await mcp.tool("check_action", { action: "send_email", details: { to: "x@example.com", subject: `Mail ${i}` } })).text).decision, "approval_pending");
    }
    const capped = parse((await mcp.tool("check_action", { action: "send_email", details: { to: "x@example.com", subject: "One too many" } })).text);
    assert.equal(capped.decision, "refused");
    assert.match(String(capped.message), /already waiting/);
    const rows = await approvalsOf(co);
    assert.equal(rows.length, 20);
    assert.ok(rows.every((r) => r.argsHash), "each ask stores its fingerprint");
    assert.ok(JSON.stringify(rows[0].metadataJson).includes("x@example.com"), "recipients are shown to the approver");
});
