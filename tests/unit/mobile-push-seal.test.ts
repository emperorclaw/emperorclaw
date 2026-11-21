import test from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';

test('push content is sealed per device with AES-256-GCM (nonce ‖ ciphertext ‖ tag)', async () => {
    const { sealForDevice } = await import('@/lib/mobile-push');
    const key = randomBytes(32);
    const sealed = sealForDevice(key.toString('base64url'), { title: 'Builder', body: 'Deploy verified', category: 'reply', agentId: 'a1', threadId: 't1' });
    assert.ok(sealed && /^[A-Za-z0-9_-]+$/.test(sealed));
    const raw = Buffer.from(sealed!, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const plain = JSON.parse(Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]).toString('utf8'));
    assert.deepEqual(plain, { t: 'Builder', b: 'Deploy verified', c: 'reply', a: 'a1', th: 't1' });
    assert.equal(sealForDevice('short', { title: 'x', body: null, category: 'attention' }), null);
    assert.notEqual(sealForDevice(key.toString('base64url'), { title: 'x', body: null, category: 'attention' }), sealForDevice(key.toString('base64url'), { title: 'x', body: null, category: 'attention' }));
});
