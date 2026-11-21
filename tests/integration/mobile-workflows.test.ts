import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { dbAvailable, resetDb, seedCompanyWithToken, makeRequest, seedAgent } from './_helper';
import { seedHuman, actAs } from './_access-helper';
const maybe = dbAvailable ? test : test.skip;
async function connection(role: 'owner' | 'viewer' = 'owner') {
    const { companyId } = await seedCompanyWithToken();
    const human = await seedHuman(companyId, role);
    const auth = await import('@/lib/mobile-auth');
    const verifier = 'v'.repeat(43);
    const code = await auth.issueMobileCode(human.sessionId, human.userId, createHash('sha256').update(verifier).digest('base64url'), 'Test phone');
    const tokens = await auth.exchangeMobileCode(code, verifier);
    return { companyId, human, token: tokens.accessToken };
}
async function call(c: Awaited<ReturnType<typeof connection>>, path: string, method = 'GET', body?: unknown, key = randomUUID()) {
    const { mobileWork } = await import('@/lib/mobile-work');
    return mobileWork(makeRequest(`https://example.com/api/mobile/v1/companies/${c.companyId}/work/${path}`, { method, body, headers: { authorization: `Bearer ${c.token}`, 'Idempotency-Key': key } }), c.companyId, path.split('/'));
}
maybe('mobile tasks are scoped and task creation is not duplicated on retry', async () => {
    await resetDb(); const c = await connection(); const other = await connection();
    const key = randomUUID(), body = { title: 'Mobile task', useDefaultProject: true };
    assert.equal((await call(c, 'tasks', 'POST', body, key)).status, 201);
    const replay = await call(c, 'tasks', 'POST', body, key);
    assert.equal((await replay.json()).replayed, true);
    assert.equal((await call(c, 'tasks', 'POST', { ...body, title: 'Changed' }, key)).status, 409);
    const [mine, theirs] = await Promise.all([call(c, 'tasks'), call(other, 'tasks')]);
    assert.equal((await mine.json()).tasks.length, 1); assert.equal((await theirs.json()).tasks.length, 0);
    const { mobileRequestContext } = await import('@/lib/mobile-context'); assert.equal(mobileRequestContext.getStore(), undefined);
});
maybe('delegated user identity supports private chat and remains isolated from browser sessions', async () => {
    await resetDb(); actAs(null); const c = await connection(); const agent = await seedAgent(c.companyId);
    const key = randomUUID(); const message = { targetAgentId: agent.id, text: 'Hello from mobile', clientMessageId: key };
    const sent = await call(c, 'chat', 'POST', message, key); assert.equal(sent.status, 200, JSON.stringify(await sent.clone().json()));
    const { mobileWork } = await import('@/lib/mobile-work');
    const response = await mobileWork(makeRequest(`https://example.com/chat?targetAgentId=${agent.id}`, { headers: { authorization: `Bearer ${c.token}` } }), c.companyId, ['chat']);
    assert.equal(response.status, 200);
    const chat = await response.json(); assert.ok(chat.messages.some((m: {text: string}) => m.text === message.text));
    const { getUserId } = await import('@/lib/auth'); assert.equal(await getUserId(), null);
});
maybe('viewer cannot send messages or change agents, unsupported admin surfaces stay inaccessible', async () => {
    await resetDb(); const c = await connection('viewer'); const agent = await seedAgent(c.companyId);
    assert.equal((await call(c, 'chat', 'POST', { targetAgentId: agent.id, text: 'No' })).status, 403);
    assert.equal((await call(c, `agents/${agent.id}/pause`, 'PATCH', { paused: true })).status, 403);
    assert.equal((await call(c, 'settings/tokens', 'POST', {})).status, 404);
});
maybe('approval details use current decision permissions and first decision wins', async () => {
    await resetDb(); const c = await connection();
    const created = await call(c, 'tasks', 'POST', { title: 'Review result', useDefaultProject: true, humanApprovalRequired: true });
    const task = (await created.json()).task;
    const { createApprovalRequest } = await import('@/lib/approvals');
    const approval = await createApprovalRequest({ companyId: c.companyId, projectId: task.projectId, taskIds: [task.id], rationale: 'Review this result', confidence: 80, actionType: 'task_done' });
    const detail = await call(c, `approvals/${approval.id}`);
    assert.equal(detail.status, 200); const value = await detail.json(); assert.equal(value.mobileDecision.mayDecide, true); assert.equal(value.mobileDecision.watchEligible, true);
    const rejected = await call(c, `approvals/${approval.id}`, 'PATCH', { status: 'rejected' });
    assert.equal(rejected.status, 200, JSON.stringify(await rejected.clone().json()));
    assert.equal((await call(c, `approvals/${approval.id}`, 'PATCH', { status: 'approved' })).status, 409);
});
maybe('mobile rich chat reads preserve company isolation and private reasoning access', async () => {
    await resetDb(); actAs(null);
    const c = await connection(), other = await connection();
    const agent = await seedAgent(c.companyId), outsider = await seedAgent(other.companyId);
    const { db } = await import('@/db');
    const { messageThreads, threadMessages, threadMessageReasoning, agentRuns } = await import('@/db/schema');
    const [thread] = await db.insert(messageThreads).values({ companyId: c.companyId, type: 'direct', directAgentId: agent.id, ownerUserId: c.human.userId, isPrivate: true }).returning();
    const [message] = await db.insert(threadMessages).values({ companyId: c.companyId, threadId: thread.id, senderType: 'agent', senderId: agent.id, text: 'Visible reply' }).returning();
    await db.insert(threadMessageReasoning).values({ companyId: c.companyId, messageId: message.id, reasoning: 'Authorized reasoning' });
    const [run] = await db.insert(agentRuns).values({ id: randomUUID(), companyId: c.companyId, agentId: agent.id, threadId: thread.id, status: 'succeeded', replyMessageId: message.id }).returning();
    const { mobileWork } = await import('@/lib/mobile-work');
    const read = (identity: typeof c, path: string[], query = '') => mobileWork(makeRequest(`https://example.com/native?${query}`, { headers: { authorization: `Bearer ${identity.token}` } }), identity.companyId, path);
    const reasoning = await read(c, ['chat', 'reasoning'], `messageId=${message.id}`);
    assert.equal(reasoning.status, 200); assert.equal((await reasoning.json()).reasoning, 'Authorized reasoning');
    assert.equal((await (await read(other, ['chat', 'reasoning'], `messageId=${message.id}`)).json()).reasoning, null);
    const refs = `refs=agent:${agent.id},agent:${outsider.id}`;
    const entities = await read(c, ['entities'], refs);
    assert.equal(entities.status, 200);
    const summaries = (await entities.json()).entities;
    assert.equal(summaries[`agent:${agent.id}`].title, agent.name);
    assert.equal(summaries[`agent:${outsider.id}`], null);
    assert.equal((await read(c, ['runs', run.id, 'events'])).status, 200);
    assert.equal((await read(other, ['runs', run.id, 'events'])).status, 404);
    // Even an administrator of the same company does not gain the owner's DM.
    const peer = await seedHuman(c.companyId, 'admin');
    const auth = await import('@/lib/mobile-auth');
    const verifier = 'p'.repeat(43);
    const code = await auth.issueMobileCode(peer.sessionId, peer.userId, createHash('sha256').update(verifier).digest('base64url'), 'Peer phone');
    const tokens = await auth.exchangeMobileCode(code, verifier);
    const peerIdentity = { ...c, human: peer, token: tokens.accessToken };
    assert.equal((await (await read(peerIdentity, ['chat', 'reasoning'], `messageId=${message.id}`)).json()).reasoning, null);
    const redacted = await read(peerIdentity, ['runs', run.id, 'events']);
    assert.equal(redacted.status, 200); assert.equal((await redacted.json()).redacted, true);
});

maybe('mobile Views reads reuse web access rules and cannot create or mutate views', async () => {
    await resetDb(); actAs(null);
    const c = await connection(), other = await connection();
    const { mcpClientFor } = await import('./_access-helper');
    const builder = await seedAgent(c.companyId);
    const client = await mcpClientFor(c.companyId, builder.id);
    const created = await client.tool('create_view', { title: 'Mobile report', panels: [{ id: 'count', type: 'metric', title: 'Agents', data: { value: 8 } }] });
    assert.equal(created.isError, false, created.text);
    const { view } = JSON.parse(created.text);
    const list = await call(c, 'views'); assert.equal(list.status, 200);
    assert.ok((await list.json()).views.some((item: { id: string }) => item.id === view.id));
    const detail = await call(c, `views/${view.id}`); assert.equal(detail.status, 200);
    assert.equal((await detail.json()).view.panels[0].data.value, 8);
    assert.equal((await call(other, `views/${view.id}`)).status, 404);
    assert.equal((await call(c, 'views', 'POST', {})).status, 404);
    assert.equal((await call(c, `views/${view.id}`, 'PATCH', {})).status, 404);
});
