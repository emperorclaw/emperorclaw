import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
const maybe = dbAvailable ? test : test.skip;

process.env.EMPEROR_CLAW_MASTER_KEY ??= "test-master-key-for-request-callbacks";

/** A requests-only token, as Settings → Access Tokens creates it. */
async function seedRequestsToken(companyId: string, name = "Acme Portal", callbackUrl?: string) {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_req_${randomUUID().replace(/-/g, "")}`;
    const tokenHash = createHash("sha256").update(raw).digest("hex");
    const { prepareCallbackUrl } = await import("@/lib/agent-requests");
    const callback = callbackUrl ? prepareCallbackUrl(callbackUrl) : null;
    if (callback && "error" in callback) throw new Error(callback.error);
    const [token] = await db.insert(companyTokens).values({
        companyId, tokenHash, name, scope: "requests",
        callbackUrlEncrypted: callback?.encrypted ?? null, callbackUrlHint: callback?.hint ?? null,
    }).returning();
    return { raw, tokenHash, tokenId: token.id };
}

const auth = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

maybe("a platform sends a request: it reaches the agent's direct chat from the source, as a task", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Viktor", provider: "hermes" });
    const { raw } = await seedRequestsToken(companyId);

    const route = await import("@/app/api/mcp/requests/route");
    const body = { agentId: "viktor", prompt: "Prepare a quote for 40 chairs\n\nDeliver to Madrid by Friday.", requestedBy: "ana@client.example", externalRef: "ORD-77" };
    const res = await route.POST(makeRequest("http://localhost/api/mcp/requests", { method: "POST", headers: auth(raw, { "Idempotency-Key": "click-1" }), body }));
    assert.equal(res.status, 201);
    const { request } = await res.json();
    assert.equal(request.status, "queued");
    assert.equal(request.source, "Acme Portal", "the token's name is the source");
    assert.equal(request.agent.name, "Viktor");
    assert.equal(request.task.title, "Prepare a quote for 40 chairs");

    // The task belongs to the agent, in the source's project.
    const db = await getDb();
    const { tasks, projects, threadMessages } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [task] = await db.select().from(tasks).where(eq(tasks.id, request.task.id));
    assert.equal(task.assignedAgentId, agent.id);
    const [project] = await db.select().from(projects).where(eq(projects.id, task.projectId));
    assert.equal(project.goal, "Requests from Acme Portal");

    // The agent's runtime receives it, addressed to it, queued like a person's message.
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const synced = await (await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&agentId=${agent.id}`, { headers: auth(rawToken) }))).json();
    const msg = synced.messages.find((m: { metadataJson: Record<string, unknown> }) => m.metadataJson.agentRequest);
    assert.ok(msg, "the request is synced to the agent");
    assert.equal(msg.senderType, "system");
    assert.equal(msg.deliveryState, "queued");
    assert.equal(msg.addressedToYou, true);
    assert.match(msg.text, /Request from Acme Portal\*\* \(via API, on behalf of ana@client\.example · ref ORD-77\)/);
    assert.ok(msg.text.includes(`emperor://task/${task.id}`));

    // A double click returns the same request.
    const again = await route.POST(makeRequest("http://localhost/api/mcp/requests", { method: "POST", headers: auth(raw, { "Idempotency-Key": "click-1" }), body }));
    assert.equal(again.status, 200);
    assert.equal((await again.json()).request.id, request.id);
    assert.equal((await db.select().from(threadMessages).where(eq(threadMessages.companyId, companyId))).length, 1);

    // A requests token does nothing else.
    const tasksRoute = await import("@/app/api/mcp/tasks/route");
    const denied = await tasksRoute.GET(makeRequest("http://localhost/api/mcp/tasks", { headers: auth(raw) }));
    assert.equal(denied.status, 403);
    const { verifyMcpAuthorizationHeader } = await import("@/lib/mcp");
    assert.equal((await verifyMcpAuthorizationHeader(`Bearer ${raw}`)).status, 403, "nor the MCP server or websocket");

    // And only sees its own requests.
    const other = await seedRequestsToken(companyId, "Other Portal");
    const byId = await import("@/app/api/mcp/requests/[id]/route");
    const params = { params: Promise.resolve({ id: request.id }) };
    assert.equal((await byId.GET(makeRequest(`http://localhost/api/mcp/requests/${request.id}`, { headers: auth(other.raw) }), params)).status, 404);
    assert.equal((await byId.GET(makeRequest(`http://localhost/api/mcp/requests/${request.id}`, { headers: auth(raw) }), params)).status, 200);
});

maybe("a request's status follows the agent's work, and its reply is the result", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Viktor", provider: "hermes" });
    const { createAgentRequest, getAgentRequest } = await import("@/lib/agent-requests");
    const { request } = await createAgentRequest({ companyId, tokenId: null, source: "Acme Portal", agent: agent.id, prompt: "Summarize ticket 12" });
    const db = await getDb();
    const { agentRequests } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(agentRequests).where(eq(agentRequests.id, request.id));

    // The runtime starts on it (system work is tracked like a person's message).
    const status = await import("@/app/api/mcp/chat/status/route");
    const r = await status.POST(makeRequest("http://localhost/api/mcp/chat/status", { method: "POST", headers: auth(rawToken), body: { threadId: row.threadId, agentId: agent.id, executionState: "acting", messageId: row.messageId } }));
    assert.equal(r.status, 200);
    assert.equal((await getAgentRequest(companyId, request.id))!.status, "in_progress");

    // It replies to that message.
    const send = await import("@/app/api/mcp/messages/send/route");
    const sent = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: auth(rawToken), body: { text: "Ticket 12: the printer is fixed.", thread_id: row.threadId, agentId: agent.id, replyToMessageId: row.messageId } }));
    assert.equal(sent.status, 200);
    const view = (await getAgentRequest(companyId, request.id))!;
    assert.equal(view.result.reply, "Ticket 12: the printer is fixed.");

    // Closing the task completes the request.
    const { tasks } = await getSchema();
    await db.update(tasks).set({ state: "done", outputJson: { summary: "Fixed" } }).where(eq(tasks.id, request.task!.id));
    const done = (await getAgentRequest(companyId, request.id))!;
    assert.equal(done.status, "done");
    assert.deepEqual(done.result.output, { summary: "Fixed" });
});

maybe("status changes are posted to the platform's callback, signed", async () => {
    await resetDb();
    const received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
    const server = createServer((req, res) => {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
            received.push({ headers: req.headers, body });
            res.writeHead(200).end("ok");
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    try {
        const { companyId } = await seedCompanyWithToken();
        const agent = await seedAgent(companyId, { name: "Viktor", provider: "hermes" });
        const { raw, tokenHash, tokenId } = await seedRequestsToken(companyId, "Acme Portal", `http://127.0.0.1:${port}/hook`);
        const { createAgentRequest, deliverRequestCallbacks, signCallback } = await import("@/lib/agent-requests");
        const { request } = await createAgentRequest({ companyId, tokenId, source: "Acme Portal", agent: agent.id, prompt: "Do it" });

        assert.equal(await deliverRequestCallbacks(), 1);
        assert.equal(await deliverRequestCallbacks(), 0, "nothing new, nothing sent");
        assert.equal(received.length, 1);
        const first = received[0];
        const payload = JSON.parse(first.body);
        assert.equal(payload.event, "agent_request.updated");
        assert.equal(payload.request.id, request.id);
        assert.equal(payload.request.status, "queued");
        // The platform verifies with sha256(its own token).
        assert.equal(createHash("sha256").update(raw).digest("hex"), tokenHash);
        assert.equal(first.headers["x-emperor-signature"], signCallback(tokenHash, String(first.headers["x-emperor-timestamp"]), first.body));

        const db = await getDb();
        const { tasks } = await getSchema();
        const { eq } = await import("drizzle-orm");
        await db.update(tasks).set({ state: "done" }).where(eq(tasks.id, request.task!.id));
        assert.equal(await deliverRequestCallbacks(), 1);
        assert.equal(JSON.parse(received[1].body).request.status, "done");
        assert.equal(await deliverRequestCallbacks(), 0, "a finished request is not polled again");
    } finally {
        server.close();
    }
});

maybe("work the system hands an agent is queued and trackable (daily review, approval decisions)", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const agent = await seedAgent(companyId, { name: "Worker", provider: "hermes" });
    const db = await getDb();
    const { projects, tasks, threadMessages } = await getSchema();
    const [project] = await db.insert(projects).values({ companyId, goal: "Launch", status: "active" }).returning();
    await db.insert(tasks).values({ companyId, projectId: project.id, taskType: "work", state: "in_progress", assignedAgentId: agent.id, inputJson: { title: "Write the report" } });
    const { reviewCompany } = await import("@/lib/agent-routines");
    assert.equal(await reviewCompany(companyId), 1);
    const [review] = await db.select().from(threadMessages);
    assert.equal(review.deliveryState, "queued", "older Hermes bridges skip resolved messages");

    const status = await import("@/app/api/mcp/chat/status/route");
    await status.POST(makeRequest("http://localhost/api/mcp/chat/status", { method: "POST", headers: auth(rawToken), body: { threadId: review.threadId, agentId: agent.id, executionState: "resolved", messageId: review.id } }));
    const { eq } = await import("drizzle-orm");
    const [after] = await db.select().from(threadMessages).where(eq(threadMessages.id, review.id));
    assert.equal(after.deliveryState, "resolved");
});
