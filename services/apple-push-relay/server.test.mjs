import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createRelay, authenticated, validEnvelope } from './server.mjs';

const secret = 'test-only-secret-with-more-than-32-characters';
const installationId = randomUUID();
const envelope = () => ({ installationId, timestamp: Date.now(), deviceToken: 'ab'.repeat(32), deviceKind: 'iphone', environment: 'sandbox' });
function request(handle, path, input, key = secret) { const raw = JSON.stringify(input); return handle(path, raw, createHmac('sha256', key).update(raw).digest('hex')); }

test('signature, replay window and strict token/installation validation', () => {
  const input = envelope(), raw = JSON.stringify(input);
  assert.equal(authenticated(raw, createHmac('sha256', secret).update(raw).digest('hex'), secret), true);
  assert.equal(authenticated(raw, '00'.repeat(32), secret), false);
  assert.equal(validEnvelope({ ...input, timestamp: Date.now() - 400000 }), false);
  assert.equal(validEnvelope({ ...input, deviceToken: '../escape' }), false);
  assert.equal(validEnvelope({ ...input, environment: 'arbitrary-host' }), false);
});
test('only receipt of an APNs challenge enables generic, deduplicated alerts', async () => {
  const sent = [], handle = createRelay({ secrets: { [installationId]: secret }, send: async (input, payload) => sent.push(payload) });
  const input = envelope();
  const event = { ...input, eventId: randomUUID(), companyId: randomUUID(), resourceId: randomUUID(), kind: 'approval' };
  assert.equal((await request(handle, '/v1/push', event))[0], 403);
  assert.equal((await request(handle, '/v1/enroll', input))[0], 200);
  assert.equal((await request(handle, '/v1/confirm', { ...input, challenge: 'wrong' }))[0], 403);
  assert.equal((await request(handle, '/v1/confirm', { ...input, challenge: sent[0].emperor.challenge }))[0], 200);
  assert.equal((await request(handle, '/v1/push', event))[0], 200);
  assert.equal((await request(handle, '/v1/push', event))[1].duplicate, true);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].emperor.company, event.companyId);
  assert.equal(JSON.stringify(sent[1]).includes('deviceToken'), false);
  assert.equal((await request(handle, '/v1/push', { ...event, deviceKind: 'watch' }))[0], 403);
});
test('another installation cannot use a verified token binding or confirm a challenge', async () => {
  const other = randomUUID(), sent = [];
  const handle = createRelay({ secrets: { [installationId]: secret, [other]: secret }, send: async (_, payload) => sent.push(payload) });
  const input = envelope();
  await request(handle, '/v1/enroll', input);
  assert.equal((await request(handle, '/v1/confirm', { ...input, installationId: other, challenge: sent[0].emperor.challenge }))[0], 403);
  assert.equal((await request(handle, '/v1/enroll', input, 'wrong'))[0], 401);
});
test('expired challenge is rejected', async () => {
  let now = Date.now(); const sent = [];
  const handle = createRelay({ secrets: { [installationId]: secret }, clock: () => now, send: async (_, payload) => sent.push(payload) });
  const input = envelope(); await request(handle, '/v1/enroll', input); now += 11 * 60000;
  assert.equal((await request(handle, '/v1/confirm', { ...input, timestamp: now, challenge: sent[0].emperor.challenge }))[0], 403);
});
