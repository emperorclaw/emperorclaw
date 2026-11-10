/**
 * Conversations over the MCP server (/mcp, lib/mcp-server): an operator
 * connection (Claude, Codex) sends a message to an agent, waits for the reply
 * with wait_for_reply and reads the thread with read_thread. A person's
 * private chat with an agent stays unreadable from an operator connection.
 * The full tool list per connection kind is pinned so drift is caught.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";
import { seedTwoTenantsOfWork } from "./_access-helper";

const maybe = dbAvailable ? test : test.skip;

/** An in-process MCP client as `agentId` (null = operator connection). */
async function mcp(companyId: string, agentId: string | null) {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
    const { buildMcpServer } = await import("@/lib/mcp-server");
    const server = await buildMcpServer(companyId, agentId, null);
    const client = new Client({ name: "conversations-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return {
        async tools() { return (await client.listTools()).tools.map((t) => t.name).sort(); },
        instructions() { return client.getInstructions() ?? ""; },
        async call(name: string, args: Record<string, unknown>) {
            const result = await client.callTool({ name, arguments: args });
            const text = (result.content as { text: string }[])[0]?.text ?? "";
            return { isError: Boolean(result.isError), text, json: () => JSON.parse(text) };
        },
    };
}

async function seed() {
    await resetDb();
    const db = await getDb();
    const { companyMembers } = await getSchema();
    const { companyId, userId: owner } = await seedCompanyWithToken();
    await db.insert(companyMembers).values({ companyId, userId: owner, role: "owner" });
    const scout = await seedAgent(companyId, { name: "Scout" });
    const builder = await seedAgent(companyId, { name: "Builder" });
    return { companyId, owner, scout, builder };
}

async function agentReply(companyId: string, threadId: string, agentId: string, text: string, metadataJson: Record<string, unknown> = {}) {
    const { appendThreadMessage } = await import("@/lib/control-plane");
    return appendThreadMessage({ companyId, threadId, senderType: "agent", senderId: agentId, text, metadataJson });
}

const SHARED_TOOLS = [
    "add_group_members", "add_task_note", "archive_group", "archive_view", "check_action", "claim_task",
    "create_agent", "create_group", "create_knowledge_note", "create_project", "create_task", "create_view",
    "get_agent", "get_agent_health", "get_emperor_manual", "get_group", "get_knowledge_context", "get_knowledge_note", "get_organization",
    "get_project", "get_task", "get_task_overview", "get_view", "list_agents", "list_groups", "list_knowledge",
    "list_automations", "list_knowledge_folders", "list_objectives", "list_projects", "list_storage_files", "list_tasks", "list_threads",
    "list_views", "read_thread", "remove_group_member", "request_approval", "run_automation", "search_knowledge", "send_message",
    "update_agent", "update_group", "update_knowledge_note", "update_objective", "update_panel", "update_project",
    "update_task", "update_view", "wait_for_reply",
    // Approval routing: a boss agent's asks to decide.
    "decide_approval", "list_pending_approvals",
];

maybe("tool lists: operator connections add the request tools; both get read_thread and wait_for_reply", async () => {
    const { companyId, scout } = await seed();
    const operator = await (await mcp(companyId, null)).tools();
    const agent = await (await mcp(companyId, scout.id)).tools();
    assert.deepEqual(agent, [...SHARED_TOOLS].sort());
    assert.deepEqual(operator, [...SHARED_TOOLS, "get_agent_request", "send_agent_request"].sort());
});

maybe("instructions: operator connections get the talk-to-an-agent guide, agent connections do not", async () => {
    const { companyId, scout } = await seed();
    const operator = (await mcp(companyId, null)).instructions();
    const agent = (await mcp(companyId, scout.id)).instructions();
    assert.match(operator, /wait_for_reply/);
    assert.match(operator, /Talking to agents \(operator connections\)/);
    assert.equal(agent.includes("Talking to agents (operator connections)"), false);
    for (const text of [operator, agent]) assert.equal(text.includes("You are an agent on"), false);
});

maybe("send_message → read_thread: the operator reads the agent's answer, oldest first, with sender names", async () => {
    const { companyId, scout } = await seed();
    const operator = await mcp(companyId, null);
    const sent = await operator.call("send_message", { text: "What is the status of the launch?", targetAgentId: "Scout" });
    assert.equal(sent.isError, false, sent.text);
    const { threadId, messageId, hint } = sent.json();
    assert.ok(threadId && messageId);
    assert.match(hint, /wait_for_reply/);
    await agentReply(companyId, threadId, scout.id, "On track, shipping Friday.");

    const byThread = await operator.call("read_thread", { threadId });
    assert.equal(byThread.isError, false, byThread.text);
    const page = byThread.json();
    assert.deepEqual(page.messages.map((m: { text: string }) => m.text), ["What is the status of the launch?", "On track, shipping Friday."]);
    assert.equal(page.messages[0].senderName, "Operator (MCP)");
    assert.equal(page.messages[1].senderName, "Scout");
    assert.equal(page.messages[1].senderType, "agent");
    assert.equal(page.messages[1].senderId, scout.id);
    assert.equal(page.hasMore, false);

    const byAgent = (await operator.call("read_thread", { agentId: scout.id })).json();
    assert.equal(byAgent.thread.id, threadId, "agentId finds the agent's direct thread");

    const limited = (await operator.call("read_thread", { threadId, limit: 1 })).json();
    assert.deepEqual(limited.messages.map((m: { text: string }) => m.text), ["On track, shipping Friday."]);
    assert.equal(limited.hasMore, true);
    const older = (await operator.call("read_thread", { threadId, before: limited.messages[0].createdAt })).json();
    assert.deepEqual(older.messages.map((m: { text: string }) => m.text), ["What is the status of the launch?"]);

    const listed = (await operator.call("list_threads", { type: "direct" })).json();
    const entry = listed.threads.find((t: { id: string }) => t.id === threadId);
    assert.equal(entry.lastMessage.text, "On track, shipping Friday.");
    assert.equal(entry.lastMessage.senderName, "Scout");
});

maybe("a person's private chat with an agent is unreadable from an operator connection, readable by its agent", async () => {
    const { companyId, owner, scout, builder } = await seed();
    const { ensureDirectThread, appendThreadMessage } = await import("@/lib/control-plane");
    const privateThread = await ensureDirectThread(companyId, scout.id, owner);
    assert.equal(privateThread.isPrivate, true);
    await appendThreadMessage({ companyId, threadId: privateThread.id, senderType: "human", senderId: owner, targetAgentId: scout.id, text: "private question" });

    const operator = await mcp(companyId, null);
    for (const [name, args] of [
        ["read_thread", { threadId: privateThread.id }],
        ["wait_for_reply", { threadId: privateThread.id, timeoutSeconds: 1 }],
    ] as const) {
        const refused = await operator.call(name, args);
        assert.equal(refused.isError, true, `${name} must refuse`);
        assert.equal(refused.text, "Thread not found");
    }
    const listed = (await operator.call("list_threads", {})).json();
    assert.equal(listed.threads.some((t: { id: string }) => t.id === privateThread.id), false);

    const other = await (await mcp(companyId, builder.id)).call("read_thread", { threadId: privateThread.id });
    assert.equal(other.isError, true, "another agent cannot read it either");

    const own = await (await mcp(companyId, scout.id)).call("read_thread", { threadId: privateThread.id });
    assert.equal(own.isError, false, own.text);
    assert.deepEqual(own.json().messages.map((m: { text: string }) => m.text), ["private question"]);
});

maybe("wait_for_reply returns the agent's answer when it arrives, never the caller's own message", async () => {
    const { companyId, scout } = await seed();
    const operator = await mcp(companyId, null);
    const { threadId, messageId } = (await operator.call("send_message", { text: "Ping?", targetAgentId: scout.id })).json();
    const timer = setTimeout(() => { void agentReply(companyId, threadId, scout.id, "Pong."); }, 1200);
    const started = Date.now();
    const waited = await operator.call("wait_for_reply", { threadId, afterMessageId: messageId, timeoutSeconds: 10 });
    clearTimeout(timer);
    assert.equal(waited.isError, false, waited.text);
    const body = waited.json();
    assert.equal(body.timedOut, false);
    assert.deepEqual(body.messages.map((m: { text: string }) => m.text), ["Pong."]);
    assert.ok(Date.now() - started < 9500, "returns before its 10 s timeout, once the reply lands");

    // The cursor moves on: nothing new after the reply, and the caller's
    // follow-up never counts as a reply.
    await operator.call("send_message", { text: "Thanks", threadId });
    const quiet = Date.now();
    const none = (await operator.call("wait_for_reply", { threadId, afterMessageId: body.nextAfterMessageId, timeoutSeconds: 1 })).json();
    assert.equal(none.timedOut, true);
    assert.deepEqual(none.messages, []);
    assert.match(none.hint, /again/);
    assert.ok(Date.now() - quiet < 8000, "a 1 s wait times out quickly");

    // With no cursor it waits after the caller's own latest message, so an
    // answer that landed before the call is not missed.
    await agentReply(companyId, threadId, scout.id, "You're welcome.", { ack: true });
    const noCursor = (await operator.call("wait_for_reply", { threadId, timeoutSeconds: 1 })).json();
    assert.deepEqual(noCursor.messages.map((m: { text: string; ack?: boolean }) => [m.text, m.ack]), [["You're welcome.", true]]);
    assert.match(noCursor.hint, /acknowledgement/);
});

maybe("agent connections wait for the other side of their own conversation", async () => {
    const { companyId, scout, builder } = await seed();
    const scoutMcp = await mcp(companyId, scout.id);
    const sent = await scoutMcp.call("send_message", { text: "Can you review PR 12?", targetAgentId: builder.id, private: true });
    assert.equal(sent.isError, false, sent.text);
    const { threadId, messageId } = sent.json();
    const timer = setTimeout(() => { void agentReply(companyId, threadId, builder.id, "Reviewed, one comment."); }, 500);
    const waited = (await scoutMcp.call("wait_for_reply", { threadId, afterMessageId: messageId, timeoutSeconds: 10 })).json();
    clearTimeout(timer);
    assert.deepEqual(waited.messages.map((m: { senderName: string }) => m.senderName), ["Builder"]);
    const byAgent = (await scoutMcp.call("read_thread", { agentId: "Builder" })).json();
    assert.equal(byAgent.thread.id, threadId, "agentId finds the pair thread for an agent connection");
});

maybe("get_agent_request filters by status and limit, like GET /api/mcp/requests", async () => {
    const { companyId } = await seed();
    const operator = await mcp(companyId, null);
    for (const ref of ["case-1", "case-2"]) {
        const created = await operator.call("send_agent_request", { agent: "Scout", prompt: `Handle ${ref}`, source: "Acme Portal", externalRef: ref });
        assert.equal(created.isError, false, created.text);
    }
    const all = (await operator.call("get_agent_request", {})).json();
    assert.equal(all.requests.length, 2);
    const status = all.requests[0].status;
    assert.equal((await operator.call("get_agent_request", { status })).json().requests.length, 2);
    const other = status === "done" ? "failed" : "done";
    assert.equal((await operator.call("get_agent_request", { status: other })).json().requests.length, 0);
    assert.equal((await operator.call("get_agent_request", { limit: 1 })).json().requests.length, 1);
    assert.equal((await operator.call("get_agent_request", { externalRef: "case-2" })).json().requests.length, 1);
    const bad = await operator.call("get_agent_request", { status: "finished" });
    assert.equal(bad.isError, true, "an unknown status is refused by the schema");
});

/** Insert a message row directly, to control createdAt (ties) and metadata. */
async function rawMessage(companyId: string, threadId: string, values: { text: string; createdAt: Date; senderType?: string; senderId?: string | null; metadataJson?: Record<string, unknown>; deliveryState?: string }) {
    const db = await getDb();
    const { threadMessages } = await getSchema();
    const [row] = await db.insert(threadMessages).values({
        companyId, threadId, senderType: values.senderType ?? "agent", senderId: values.senderId ?? null,
        text: values.text, createdAt: values.createdAt, metadataJson: values.metadataJson ?? {}, deliveryState: values.deliveryState ?? "resolved",
    }).returning();
    return row;
}

/** The keyset order the server pages in: createdAt, then id. */
function keysetOrder<T extends { createdAt: Date; id: string }>(rows: T[]): T[] {
    return [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

const texts = (page: { messages: { text: string }[] }) => page.messages.map((m) => m.text);

maybe("tied timestamps: read_thread pages both ways and wait_for_reply batches without skipping or repeating", async () => {
    const { companyId, scout } = await seed();
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, scout.id, null);
    const tie = new Date("2026-10-01T10:00:00.123Z");
    const rows = [];
    for (let i = 0; i < 5; i++) rows.push(await rawMessage(companyId, thread.id, { text: `tied ${i}`, createdAt: tie, senderId: scout.id }));
    const sorted = keysetOrder(rows);
    const ordered = sorted.map((r) => r.text);
    const operator = await mcp(companyId, null);

    const backward: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 5; guard++) {
        const page = (await operator.call("read_thread", { threadId: thread.id, limit: 2, ...(cursor ? { beforeMessageId: cursor } : {}) })).json();
        backward.unshift(...texts(page));
        if (!page.hasMore) break;
        cursor = page.oldestMessageId;
    }
    assert.deepEqual(backward, ordered, "backward paging covers every tied message once");

    const forward: string[] = [sorted[0].text];
    let after = sorted[0].id;
    for (let guard = 0; guard < 5; guard++) {
        const page = (await operator.call("read_thread", { threadId: thread.id, limit: 2, afterMessageId: after })).json();
        assert.equal(page.hasMoreDirection, "newer");
        forward.push(...texts(page));
        if (!page.hasMore) break;
        after = page.newestMessageId;
    }
    assert.deepEqual(forward, ordered, "forward paging covers every tied message once");

    // wait_for_reply after the first tied message returns the other four, not none.
    const waited = (await operator.call("wait_for_reply", { threadId: thread.id, afterMessageId: sorted[0].id, timeoutSeconds: 1 })).json();
    assert.deepEqual(texts(waited), ordered.slice(1));
    const done = (await operator.call("wait_for_reply", { threadId: thread.id, afterMessageId: waited.nextAfterMessageId, timeoutSeconds: 1 })).json();
    assert.equal(done.timedOut, true);
});

maybe("read_thread with since returns the oldest messages after it, and pages forward", async () => {
    const { companyId, scout } = await seed();
    const { ensureDirectThread } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, scout.id, null);
    const base = Date.parse("2026-10-01T10:00:00.000Z");
    await rawMessage(companyId, thread.id, { text: "before", createdAt: new Date(base - 60_000), senderId: scout.id });
    for (let i = 1; i <= 5; i++) await rawMessage(companyId, thread.id, { text: `m${i}`, createdAt: new Date(base + i * 1000), senderId: scout.id });
    const operator = await mcp(companyId, null);
    const first = (await operator.call("read_thread", { threadId: thread.id, since: new Date(base).toISOString(), limit: 2 })).json();
    assert.deepEqual(texts(first), ["m1", "m2"]);
    assert.equal(first.hasMore, true);
    const next = (await operator.call("read_thread", { threadId: thread.id, afterMessageId: first.newestMessageId, limit: 2 })).json();
    assert.deepEqual(texts(next), ["m3", "m4"]);
    const last = (await operator.call("read_thread", { threadId: thread.id, afterMessageId: next.newestMessageId, limit: 2 })).json();
    assert.deepEqual(texts(last), ["m5"]);
    assert.equal(last.hasMore, false);
    // No cursor: the newest page, oldest first.
    const newest = (await operator.call("read_thread", { threadId: thread.id, limit: 2 })).json();
    assert.deepEqual(texts(newest), ["m4", "m5"]);
    assert.equal(newest.hasMoreDirection, "older");
});

maybe("control messages (cancelled, runtimeControl, runtimeGoalRequest) are hidden from read_thread, wait_for_reply and previews", async () => {
    const { companyId, scout } = await seed();
    const operator = await mcp(companyId, null);
    const { threadId, messageId } = (await operator.call("send_message", { text: "Hello", targetAgentId: scout.id })).json();
    const now = Date.now();
    await rawMessage(companyId, threadId, { text: "visible answer", createdAt: new Date(now + 1000), senderId: scout.id });
    await rawMessage(companyId, threadId, { text: "control", createdAt: new Date(now + 2000), senderType: "system", metadataJson: { runtimeControl: { action: "stop" } } });
    await rawMessage(companyId, threadId, { text: "goal", createdAt: new Date(now + 3000), senderType: "system", metadataJson: { runtimeGoalRequest: { id: "g" } } });
    await rawMessage(companyId, threadId, { text: "cancelled", createdAt: new Date(now + 4000), senderType: "human", deliveryState: "cancelled" });

    assert.deepEqual(texts((await operator.call("read_thread", { threadId })).json()), ["Hello", "visible answer"]);
    const waited = (await operator.call("wait_for_reply", { threadId, afterMessageId: messageId, timeoutSeconds: 1 })).json();
    assert.deepEqual(texts(waited), ["visible answer"]);
    const after = (await operator.call("wait_for_reply", { threadId, afterMessageId: waited.nextAfterMessageId, timeoutSeconds: 1 })).json();
    assert.equal(after.timedOut, true, "control rows never end a wait");
    const listed = (await operator.call("list_threads", {})).json();
    assert.equal(listed.threads.find((t: { id: string }) => t.id === threadId).lastMessage.text, "visible answer");
});

maybe("two-agent pair threads: refused to operator connections on MCP and REST, readable by their agents", async () => {
    await resetDb();
    const { companyId, rawToken } = await seedCompanyWithToken();
    const scout = await seedAgent(companyId, { name: "Scout" });
    const builder = await seedAgent(companyId, { name: "Builder" });
    const outsider = await seedAgent(companyId, { name: "Outsider" });
    const { ensureAgentPairThread } = await import("@/lib/groups");
    const pair = await ensureAgentPairThread(companyId, scout.id, builder.id);
    await agentReply(companyId, pair.id, scout.id, "pair secret");

    const operator = await mcp(companyId, null);
    for (const [name, args] of [["read_thread", { threadId: pair.id }], ["wait_for_reply", { threadId: pair.id, timeoutSeconds: 1 }]] as const) {
        const refused = await operator.call(name, args);
        assert.equal(refused.isError, true, `${name} must refuse an operator`);
        assert.equal(refused.text, "Thread not found");
    }
    assert.equal((await operator.call("list_threads", {})).json().threads.some((t: { id: string }) => t.id === pair.id), false);
    assert.equal((await (await mcp(companyId, outsider.id)).call("read_thread", { threadId: pair.id })).isError, true);
    const member = await (await mcp(companyId, builder.id)).call("read_thread", { threadId: pair.id });
    assert.equal(member.isError, false, member.text);

    const route = await import("@/app/api/mcp/threads/[id]/messages/route");
    const get = (query: string) => route.GET(
        makeRequest(`http://localhost/api/mcp/threads/${pair.id}/messages${query}`, { headers: { authorization: `Bearer ${rawToken}` } }),
        { params: Promise.resolve({ id: pair.id }) },
    );
    assert.equal((await get("")).status, 404, "a company-wide token naming no agent cannot read a pair thread");
    assert.equal((await get(`?agentId=${outsider.id}`)).status, 404, "nor as an agent outside the pair");
    assert.equal((await get(`?agentId=${scout.id}`)).status, 200, "a bridge acting as one of the two agents still can");
});

maybe("scope and membership: a restricted agent sees no out-of-scope thread or preview, a non-member gets 403 on a group", async () => {
    await resetDb();
    const { companyId, userId } = await seedCompanyWithToken();
    const work = await seedTwoTenantsOfWork(companyId);
    const scoped = await seedAgent(companyId, { name: "Scoped", scopeJson: { mode: "restricted", customerIds: [work.customerIn.id], projectIds: [] } });
    const member = await seedAgent(companyId, { name: "Member" });
    const db = await getDb();
    const { messageThreads } = await getSchema();
    const [outThread] = await db.insert(messageThreads).values({ companyId, type: "project", projectId: work.projectOut.id, title: "Out thread" }).returning();
    const [inThread] = await db.insert(messageThreads).values({ companyId, type: "project", projectId: work.projectIn.id, title: "In thread" }).returning();
    await rawMessage(companyId, outThread.id, { text: "OUT-SECRET", createdAt: new Date(), senderType: "human" });
    await rawMessage(companyId, inThread.id, { text: "in hello", createdAt: new Date(), senderType: "human" });
    const { createGroup } = await import("@/lib/groups");
    const group = await createGroup(companyId, { type: "human", id: userId }, { title: "Core", agentIds: [member.id] });
    await agentReply(companyId, group.id, member.id, "GROUP-SECRET");

    const agent = await mcp(companyId, scoped.id);
    const listed = await agent.call("list_threads", {});
    assert.equal(listed.isError, false, listed.text);
    assert.equal(listed.text.includes("OUT-SECRET"), false, "no out-of-scope preview");
    assert.equal(listed.text.includes("GROUP-SECRET"), false, "no preview of a group it is not in");
    const ids = listed.json().threads.map((t: { id: string }) => t.id);
    assert.ok(ids.includes(inThread.id));
    assert.equal(ids.includes(outThread.id), false);
    assert.equal(ids.includes(group.id), false);

    assert.equal((await agent.call("read_thread", { threadId: outThread.id })).text, "Thread not found");
    const notMember = await agent.call("read_thread", { threadId: group.id });
    assert.equal(notMember.isError, true);
    assert.equal(notMember.text, "Access denied: this agent is not a member of that group");
    const memberRead = await (await mcp(companyId, member.id)).call("read_thread", { threadId: group.id });
    assert.equal(memberRead.isError, false, memberRead.text);
});

maybe("cursors from another thread and a since in the future are refused", async () => {
    const { companyId, scout, builder } = await seed();
    const operator = await mcp(companyId, null);
    const a = (await operator.call("send_message", { text: "to scout", targetAgentId: scout.id })).json();
    const b = (await operator.call("send_message", { text: "to builder", targetAgentId: builder.id })).json();
    for (const [name, args] of [
        ["wait_for_reply", { threadId: a.threadId, afterMessageId: b.messageId, timeoutSeconds: 1 }],
        ["read_thread", { threadId: a.threadId, afterMessageId: b.messageId }],
        ["read_thread", { threadId: a.threadId, beforeMessageId: b.messageId }],
    ] as const) {
        const refused = await operator.call(name, args);
        assert.equal(refused.isError, true, `${name} ${JSON.stringify(args)}`);
        assert.match(refused.text, /is not a message of that thread/);
    }
    const future = await operator.call("wait_for_reply", { threadId: a.threadId, since: new Date(Date.now() + 3_600_000).toISOString(), timeoutSeconds: 1 });
    assert.equal(future.isError, true);
    assert.match(future.text, /since is in the future/);
});

maybe("wait_for_reply caps concurrent waits per connection", async () => {
    const { companyId, scout } = await seed();
    const operator = await mcp(companyId, null);
    const { threadId, messageId } = (await operator.call("send_message", { text: "Anyone?", targetAgentId: scout.id })).json();
    const { WAIT_MAX_CONCURRENT_PER_TOKEN } = await import("@/lib/mcp-server/tools/conversations");
    const open = Array.from({ length: WAIT_MAX_CONCURRENT_PER_TOKEN }, () => operator.call("wait_for_reply", { threadId, afterMessageId: messageId, timeoutSeconds: 5 }));
    // Let the open waits reach the server and take their slots.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const extra = await operator.call("wait_for_reply", { threadId, afterMessageId: messageId, timeoutSeconds: 1 });
    assert.equal(extra.isError, true);
    assert.match(extra.text, /Too many waits/);
    for (const result of await Promise.all(open)) assert.equal(result.json().timedOut, true);
    const again = await operator.call("wait_for_reply", { threadId, afterMessageId: messageId, timeoutSeconds: 1 });
    assert.equal(again.isError, false, "slots are released once the waits return");
});
