import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { dbAvailable, getDb, getSchema, makeRequest, resetDb, seedAgent, seedCompanyWithToken } from "./_helper";

/**
 * Private direct-chat mode with a COMPANY-WIDE MCP token (company_tokens.agent_id
 * NULL), exactly how production bridges authenticate: they name their agent
 * with `agentId` on each call. Such a token acts as the agent it names, so the
 * bridge for X receives and answers people's private chats with X, and never
 * another agent's. Naming no agent keeps every private thread hidden. A token
 * bound to an agent keeps acting only as that agent.
 */
const maybe = dbAvailable ? test : test.skip;

async function token(companyId: string, agentId: string | null): Promise<string> {
    const db = await getDb();
    const { companyTokens } = await getSchema();
    const raw = `ec_test_${randomUUID().replace(/-/g, "")}`;
    await db.insert(companyTokens).values({
        companyId, agentId, tokenHash: createHash("sha256").update(raw).digest("hex"), name: `t-${randomUUID()}`, scope: "mcp_full",
    });
    return raw;
}

const auth = (raw: string) => ({ authorization: `Bearer ${raw}` });

/** Private-mode company: person P, agents X and Y, P's private thread with X holding one message, plus a team message. */
async function seed() {
    await resetDb();
    const db = await getDb();
    const { companies, companyMembers } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { companyId, userId: personP } = await seedCompanyWithToken();
    await db.insert(companyMembers).values({ companyId, userId: personP, role: "owner" });
    await db.update(companies).set({ directChatMode: "private" }).where(eq(companies.id, companyId));
    const agentX = await seedAgent(companyId, { name: "Xavier", provider: "hermes" });
    const agentY = await seedAgent(companyId, { name: "Yolanda", provider: "hermes" });
    const { ensureDirectThread, ensureTeamThread, appendThreadMessage } = await import("@/lib/control-plane");
    const thread = await ensureDirectThread(companyId, agentX.id, personP);
    assert.equal(thread.isPrivate, true, "private mode gives P a private thread with X");
    const message = await appendThreadMessage({ companyId, threadId: thread.id, senderType: "human", senderId: personP, targetAgentId: agentX.id, text: "private question for X" });
    // A team message, so a sync that may not see the private one still returns at once (no 25 s long poll).
    const team = await ensureTeamThread(companyId);
    await appendThreadMessage({ companyId, threadId: team.id, senderType: "human", senderId: personP, text: "team hello" });
    return {
        companyId, personP, agentX, agentY, thread, message,
        companyToken: await token(companyId, null),
        tokenX: await token(companyId, agentX.id),
        tokenY: await token(companyId, agentY.id),
    };
}

async function syncIds(raw: string, query: string): Promise<{ status: number; ids: string[] }> {
    const sync = await import("@/app/api/mcp/messages/sync/route");
    const since = new Date(Date.now() - 60_000).toISOString();
    const res = await sync.GET(makeRequest(`http://localhost/api/mcp/messages/sync?mode=all&since=${encodeURIComponent(since)}${query}`, { headers: auth(raw) }));
    if (res.status !== 200) return { status: res.status, ids: [] };
    return { status: 200, ids: ((await res.json()) as { messages: { id: string }[] }).messages.map((m) => m.id) };
}

maybe("company token: sync as X delivers P's private message to X, never to Y or to an unnamed sync", async () => {
    const s = await seed();
    const asX = await syncIds(s.companyToken, `&agentId=${s.agentX.id}`);
    assert.equal(asX.status, 200);
    assert.ok(asX.ids.includes(s.message.id), "the bridge syncing as X receives P's private message");

    const byName = await syncIds(s.companyToken, `&agentId=${encodeURIComponent(s.agentX.name)}`);
    assert.ok(byName.ids.includes(s.message.id), "naming X by name works too");

    const asY = await syncIds(s.companyToken, `&agentId=${s.agentY.id}`);
    assert.equal(asY.status, 200);
    assert.ok(asY.ids.length > 0, "Y's sync returns (the team message)");
    assert.ok(!asY.ids.includes(s.message.id), "syncing as another agent never gets it");

    const unnamed = await syncIds(s.companyToken, "");
    assert.equal(unnamed.status, 200);
    assert.ok(unnamed.ids.length > 0, "the unnamed sync returns (the team message)");
    assert.ok(!unnamed.ids.includes(s.message.id), "a company token naming no agent never gets it");

});

maybe("company token: the bridge reply flow for X lands in P's private thread; as Y it is refused", async () => {
    const s = await seed();
    const db = await getDb();
    const { threadMessages, threadParticipants } = await getSchema();
    const { and, eq } = await import("drizzle-orm");
    const send = await import("@/app/api/mcp/messages/send/route");
    const status = await import("@/app/api/mcp/chat/status/route");
    const threadMessagesRoute = await import("@/app/api/mcp/threads/[id]/messages/route");
    const params = { params: Promise.resolve({ id: s.thread.id }) };
    const threadUrl = `http://localhost/api/mcp/threads/${s.thread.id}/messages`;

    // Bridge: typing + mark read (chat/status) as X.
    assert.equal((await status.POST(makeRequest("http://localhost/api/mcp/chat/status", {
        method: "POST", headers: auth(s.companyToken), body: { threadId: s.thread.id, agentId: s.agentX.id, typing: true, markRead: true },
    }))).status, 200);
    assert.equal((await status.POST(makeRequest("http://localhost/api/mcp/chat/status", {
        method: "POST", headers: auth(s.companyToken), body: { threadId: s.thread.id, agentId: s.agentY.id, typing: true },
    }))).status, 404, "Y's status into X's private thread");
    const yJoined = await db.select().from(threadParticipants).where(and(eq(threadParticipants.threadId, s.thread.id), eq(threadParticipants.participantId, s.agentY.id)));
    assert.equal(yJoined.length, 0, "Y never becomes a participant");

    // Bridge: continuity seed (GET thread messages) as X.
    assert.equal((await threadMessagesRoute.GET(makeRequest(`${threadUrl}?agentId=${s.agentX.id}`, { headers: auth(s.companyToken) }), params)).status, 200);
    assert.equal((await threadMessagesRoute.GET(makeRequest(`${threadUrl}?agentId=${s.agentY.id}`, { headers: auth(s.companyToken) }), params)).status, 404);
    assert.equal((await threadMessagesRoute.GET(makeRequest(threadUrl, { headers: auth(s.companyToken) }), params)).status, 404, "no agent named");

    // Bridge outbox body: thread_id + agentId + replyToMessageId.
    const reply = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: { ...auth(s.companyToken), "idempotency-key": `reply-${randomUUID()}` },
        body: { thread_id: s.thread.id, agentId: s.agentX.id, text: "answer from X", targetAgentId: null, replyToMessageId: s.message.id },
    }));
    assert.equal(reply.status, 200, await reply.clone().text());
    const replyId = ((await reply.json()) as { message_id: string }).message_id;
    const [stored] = await db.select().from(threadMessages).where(eq(threadMessages.id, replyId));
    assert.equal(stored.threadId, s.thread.id, "the reply lands in P's private thread");
    assert.equal(stored.senderType, "agent");
    assert.equal(stored.senderId, s.agentX.id);

    for (const body of [
        { thread_id: s.thread.id, agentId: s.agentY.id, text: "Y intrudes" },
        { agentId: s.agentY.id, text: "Y intrudes via reply", replyToMessageId: s.message.id },
        { thread_id: s.thread.id, text: "nobody named" },
        { thread_id: s.thread.id, agentId: s.agentX.id, from_user_id: s.agentY.id, text: "X named, Y as sender" },
    ]) {
        const res = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: auth(s.companyToken), body }));
        assert.equal(res.status, 404, `refused: ${JSON.stringify(body)}`);
    }

    // The thread-scoped post route follows the same rule.
    assert.equal((await threadMessagesRoute.POST(makeRequest(threadUrl, { method: "POST", headers: auth(s.companyToken), body: { text: "X via thread route", senderId: s.agentX.id } }), params)).status, 201);
    assert.equal((await threadMessagesRoute.POST(makeRequest(threadUrl, { method: "POST", headers: auth(s.companyToken), body: { text: "Y via thread route", senderId: s.agentY.id } }), params)).status, 404);
    assert.equal((await threadMessagesRoute.POST(makeRequest(threadUrl, { method: "POST", headers: auth(s.companyToken), body: { text: "no sender" } }), params)).status, 404);

    const intruders = await db.select().from(threadMessages).where(and(eq(threadMessages.threadId, s.thread.id), eq(threadMessages.senderId, s.agentY.id)));
    assert.equal(intruders.length, 0, "nothing from Y was stored in X's private thread");

    // Listing threads as X shows it; as Y or unnamed it does not.
    const listRoute = await import("@/app/api/mcp/threads/route");
    const list = async (query: string) => {
        const res = await listRoute.GET(makeRequest(`http://localhost/api/mcp/threads?type=direct${query}`, { headers: auth(s.companyToken) }));
        return ((await res.json()) as { threads: { id: string }[] }).threads.map((t) => t.id);
    };
    assert.ok((await list(`&agentId=${s.agentX.id}`)).includes(s.thread.id));
    assert.ok(!(await list(`&agentId=${s.agentY.id}`)).includes(s.thread.id));
    assert.ok(!(await list("")).includes(s.thread.id));
});

maybe("company token: run start, run events and run finish for X's private-thread run; Y is refused", async () => {
    const s = await seed();
    const runs = await import("@/app/api/mcp/agents/runs/route");
    const runEvents = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const runRoute = await import("@/app/api/mcp/agents/runs/[id]/route");
    const event = (seq: number, kind = "turn.started") => ({ id: randomUUID(), seq, kind, ts: new Date().toISOString() });
    const postEvents = (runId: string, body: unknown, query = "") => runEvents.POST(makeRequest(`http://localhost/api/mcp/agents/runs/${runId}/events${query}`, {
        method: "POST", headers: auth(s.companyToken), body,
    }), { params: Promise.resolve({ id: runId }) });

    // POST /agents/runs (ledger start).
    const startedRun = randomUUID();
    const started = await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST", headers: auth(s.companyToken), body: { id: startedRun, agentId: s.agentX.id, triggerKind: "message", triggerMessageId: s.message.id, threadId: s.thread.id },
    }));
    assert.equal(started.status, 200, await started.clone().text());
    assert.equal(((await started.json()) as { run: { threadId: string; agentId: string } }).run.threadId, s.thread.id);
    const yStart = await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST", headers: auth(s.companyToken), body: { id: randomUUID(), agentId: s.agentY.id, triggerMessageId: s.message.id, threadId: s.thread.id },
    }));
    assert.equal(yStart.status, 404, "Y cannot start a run in X's private thread");

    // Run events: first batch carries the `run` header (agentId inside it).
    const runId = randomUUID();
    const header = { id: runId, agentId: s.agentX.id, runtimeId: "rt-x", runtimeKind: "hermes", triggerKind: "message", triggerMessageId: s.message.id, threadId: s.thread.id };
    const first = await postEvents(runId, { run: header, events: [event(1)] }, `?agentId=${s.agentX.id}`);
    assert.equal(first.status, 200, await first.clone().text());
    // Later batches: no header, the bridge names its agent with ?agentId=.
    assert.equal((await postEvents(runId, { events: [event(2, "notice")] }, `?agentId=${s.agentX.id}`)).status, 200);
    assert.equal((await postEvents(runId, { events: [event(3, "notice")] }, `?agentId=${s.agentY.id}`)).status, 403, "Y cannot write X's run");
    // An old bridge names no agent on follow-up batches: it acts as the run's own agent.
    assert.equal((await postEvents(runId, { events: [event(4, "notice")] })).status, 200, "no agent named: acts as the run's owner X");

    const yRun = randomUUID();
    const yHeader = await postEvents(yRun, { run: { ...header, id: yRun, agentId: s.agentY.id }, events: [event(1)] });
    assert.equal(yHeader.status, 404, "Y's run header pointing at X's private thread");

    // Finish (PATCH) naming the reply X posted in the private thread.
    const send = await import("@/app/api/mcp/messages/send/route");
    const reply = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: auth(s.companyToken), body: { thread_id: s.thread.id, agentId: s.agentX.id, text: "done", replyToMessageId: s.message.id },
    }));
    const replyMessageId = ((await reply.json()) as { message_id: string }).message_id;
    const finish = (id: string, query: string) => runRoute.PATCH(makeRequest(`http://localhost/api/mcp/agents/runs/${id}${query}`, {
        method: "PATCH", headers: auth(s.companyToken), body: { status: "succeeded", replyMessageId },
    }), { params: Promise.resolve({ id }) });
    assert.equal((await finish(runId, `?agentId=${s.agentY.id}`)).status, 403, "naming another agent than the run's owner");
    const finished = await finish(runId, `?agentId=${s.agentX.id}`);
    assert.equal(finished.status, 200, await finished.clone().text());
    assert.equal(((await finished.json()) as { run: { replyMessageId: string } }).run.replyMessageId, replyMessageId);
});

maybe("bound tokens keep acting only as their own agent in private mode", async () => {
    const s = await seed();
    // X's own token still syncs X's private message; naming another agent is refused.
    assert.ok((await syncIds(s.tokenX, "")).ids.includes(s.message.id));
    assert.equal((await syncIds(s.tokenX, `&agentId=${s.agentY.id}`)).status, 403);
    // Y's token never gets it, even when it names X.
    assert.ok(!(await syncIds(s.tokenY, "")).ids.includes(s.message.id));
    assert.equal((await syncIds(s.tokenY, `&agentId=${s.agentX.id}`)).status, 403);

    const send = await import("@/app/api/mcp/messages/send/route");
    const ySend = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: auth(s.tokenY), body: { thread_id: s.thread.id, text: "Y intrudes" } }));
    assert.equal(ySend.status, 404);
    const yAsX = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: auth(s.tokenY), body: { thread_id: s.thread.id, agentId: s.agentX.id, text: "Y as X" } }));
    assert.equal(yAsX.status, 403, "a bound token may not name another agent");
    const xSend = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", { method: "POST", headers: auth(s.tokenX), body: { thread_id: s.thread.id, text: "X answers", replyToMessageId: s.message.id } }));
    assert.equal(xSend.status, 200);

    const threadMessagesRoute = await import("@/app/api/mcp/threads/[id]/messages/route");
    const params = { params: Promise.resolve({ id: s.thread.id }) };
    const url = `http://localhost/api/mcp/threads/${s.thread.id}/messages`;
    assert.equal((await threadMessagesRoute.GET(makeRequest(`${url}?agentId=${s.agentX.id}`, { headers: auth(s.tokenY) }), params)).status, 404, "Y's token naming X still reads nothing");
    assert.equal((await threadMessagesRoute.POST(makeRequest(url, { method: "POST", headers: auth(s.tokenY), body: { text: "hi", senderId: s.agentX.id } }), params)).status, 404);

    const runs = await import("@/app/api/mcp/agents/runs/route");
    const yRun = await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST", headers: auth(s.tokenY), body: { id: randomUUID(), agentId: s.agentY.id, threadId: s.thread.id },
    }));
    assert.equal(yRun.status, 404);
    const xRunId = randomUUID();
    assert.equal((await runs.POST(makeRequest("http://localhost/api/mcp/agents/runs", {
        method: "POST", headers: auth(s.tokenX), body: { id: xRunId, agentId: s.agentX.id, threadId: s.thread.id },
    }))).status, 200);
    const runEvents = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const xEvents = await runEvents.POST(makeRequest(`http://localhost/api/mcp/agents/runs/${xRunId}/events`, {
        method: "POST", headers: auth(s.tokenX), body: { events: [{ id: randomUUID(), seq: 1, kind: "turn.started", ts: new Date().toISOString() }] },
    }), { params: Promise.resolve({ id: xRunId }) });
    assert.equal(xEvents.status, 200, "X's own token writes its run without naming anything");
    const yEvents = await runEvents.POST(makeRequest(`http://localhost/api/mcp/agents/runs/${xRunId}/events`, {
        method: "POST", headers: auth(s.tokenY), body: { events: [{ id: randomUUID(), seq: 2, kind: "notice", ts: new Date().toISOString() }] },
    }), { params: Promise.resolve({ id: xRunId }) });
    assert.equal(yEvents.status, 403);
});

maybe("old bridge (no agent on follow-ups): a company token acts as the run's own agent, and only within that run", async () => {
    const s = await seed();
    const db = await getDb();
    const { agentRuns } = await getSchema();
    const { eq } = await import("drizzle-orm");
    const { ensureDirectThread, ensureTeamThread, appendThreadMessage } = await import("@/lib/control-plane");
    // P's private thread with Y, with a message.
    const threadY = await ensureDirectThread(s.companyId, s.agentY.id, s.personP);
    const messageY = await appendThreadMessage({ companyId: s.companyId, threadId: threadY.id, senderType: "human", senderId: s.personP, targetAgentId: s.agentY.id, text: "private question for Y" });
    const team = await ensureTeamThread(s.companyId);

    const runEvents = await import("@/app/api/mcp/agents/runs/[id]/events/route");
    const runRoute = await import("@/app/api/mcp/agents/runs/[id]/route");
    const send = await import("@/app/api/mcp/messages/send/route");
    const event = (seq: number, kind = "notice") => ({ id: randomUUID(), seq, kind, ts: new Date().toISOString() });
    const postEvents = (runId: string, body: unknown, query = "") => runEvents.POST(makeRequest(`http://localhost/api/mcp/agents/runs/${runId}/events${query}`, {
        method: "POST", headers: auth(s.companyToken), body,
    }), { params: Promise.resolve({ id: runId }) });
    const finish = (runId: string, replyMessageId: string, query = "") => runRoute.PATCH(makeRequest(`http://localhost/api/mcp/agents/runs/${runId}${query}`, {
        method: "PATCH", headers: auth(s.companyToken), body: { status: "succeeded", replyMessageId },
    }), { params: Promise.resolve({ id: runId }) });

    // Exactly what an old bridge does: header batch (agent inside), then batches with nothing named.
    const runId = randomUUID();
    const header = { id: runId, agentId: s.agentX.id, runtimeId: "rt-x", runtimeKind: "hermes", triggerKind: "message", triggerMessageId: s.message.id, threadId: s.thread.id };
    assert.equal((await postEvents(runId, { run: header, events: [event(1, "turn.started")] })).status, 200);
    assert.equal((await postEvents(runId, { events: [event(2)] })).status, 200);

    // A header re-sent on the existing run cannot move it to Y's private thread: events stay on X's run/thread.
    assert.equal((await postEvents(runId, { run: { ...header, threadId: threadY.id, triggerMessageId: messageY.id }, events: [event(3)] })).status, 200);
    const [row] = await db.select().from(agentRuns).where(eq(agentRuns.id, runId));
    assert.equal(row.threadId, s.thread.id, "the run stays on X's thread");
    assert.equal(row.agentId, s.agentX.id);

    // A NEW run as X pointing at Y's private thread is refused (start check), directly or via its trigger.
    const pivot = randomUUID();
    assert.equal((await postEvents(pivot, { run: { ...header, id: pivot, threadId: threadY.id, triggerMessageId: null }, events: [event(1)] })).status, 404);
    const viaTrigger = randomUUID();
    assert.equal((await postEvents(viaTrigger, { run: { ...header, id: viaTrigger, threadId: null, triggerMessageId: messageY.id }, events: [event(1)] })).status, 404);

    // Finish with no agent named: X's run may name X's private reply, never Y's private message.
    const reply = await send.POST(makeRequest("http://localhost/api/mcp/messages/send", {
        method: "POST", headers: auth(s.companyToken), body: { thread_id: s.thread.id, agentId: s.agentX.id, text: "done", replyToMessageId: s.message.id },
    }));
    const replyId = ((await reply.json()) as { message_id: string }).message_id;
    assert.equal((await finish(runId, messageY.id)).status, 404, "X's run cannot claim a message in Y's private thread");
    assert.equal((await finish(runId, replyId, `?agentId=${s.agentY.id}`)).status, 403, "naming another agent than the owner");
    const finished = await finish(runId, replyId);
    assert.equal(finished.status, 200, await finished.clone().text());
    assert.equal(((await finished.json()) as { run: { replyMessageId: string } }).run.replyMessageId, replyId);

    // X's run in the team thread still cannot reach Y's private thread.
    const teamRun = randomUUID();
    assert.equal((await postEvents(teamRun, { run: { ...header, id: teamRun, threadId: team.id, triggerMessageId: null }, events: [event(1, "turn.started")] })).status, 200);
    assert.equal((await postEvents(teamRun, { events: [event(2)] })).status, 200);
    assert.equal((await finish(teamRun, messageY.id)).status, 404);

    // A run with no owner (unknown id: the finish would recover it ownerless) acts as nobody.
    assert.equal((await finish(randomUUID(), s.message.id)).status, 404);
});

maybe("sync: a company token naming an agent that is not in the company gets 404, not a crash", async () => {
    const s = await seed();
    assert.equal((await syncIds(s.companyToken, `&agentId=${randomUUID()}`)).status, 404, "unknown uuid");
    assert.equal((await syncIds(s.companyToken, "&agentId=NoSuchAgent")).status, 404, "unknown name");
    // Another company's agent is unknown here too.
    const other = await seedCompanyWithToken();
    const foreign = await seedAgent(other.companyId, { name: "Foreigner", provider: "hermes" });
    assert.equal((await syncIds(s.companyToken, `&agentId=${foreign.id}`)).status, 404, "another company's agent");
    // A bound token naming an unknown agent stays 403 (mismatch), as before.
    assert.equal((await syncIds(s.tokenX, `&agentId=${randomUUID()}`)).status, 403);
});
