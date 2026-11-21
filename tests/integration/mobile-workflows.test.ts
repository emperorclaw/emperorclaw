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
