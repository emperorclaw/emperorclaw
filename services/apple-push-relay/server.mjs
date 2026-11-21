import { createServer } from 'node:http';
import { connect } from 'node:http2';
import { createHash, createHmac, createPrivateKey, randomBytes, sign, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export function authenticated(body, signature, secret) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature) || !secret) return false;
  return timingSafeEqual(Buffer.from(signature, 'hex'), createHmac('sha256', secret).update(body).digest());
}
export function validEnvelope(input, now = Date.now()) {
  return input && uuid(input.installationId) && Number.isFinite(input.timestamp) && Math.abs(now - input.timestamp) <= 300000
    && typeof input.deviceToken === 'string' && /^[a-f0-9]{64,200}$/i.test(input.deviceToken)
    && ['sandbox', 'production'].includes(input.environment) && ['iphone', 'watch'].includes(input.deviceKind);
}
export function createRelay({ secrets, send, stateFile, clock = Date.now }) {
  const pending = new Map(), verified = new Set(), delivered = new Map();
  let persist = Promise.resolve();
  const binding = input => `${input.installationId}:${input.environment}:${input.deviceKind}:${tokenHash(input.deviceToken)}`;
  const load = stateFile ? readFile(stateFile, 'utf8').then(text => { for (const key of JSON.parse(text)) verified.add(key); }).catch(error => { if (error.code !== 'ENOENT') throw error; }) : Promise.resolve();
  async function save() {
    if (!stateFile) return;
    // Serialize writes and atomically replace the file; store token hashes only.
    persist = persist.catch(() => {}).then(async () => { await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 }); await writeFile(`${stateFile}.tmp`, JSON.stringify([...verified]), { mode: 0o600 }); await rename(`${stateFile}.tmp`, stateFile); });
    await persist;
  }
  return async function handle(path, raw, signature) {
    await load;
    let input; try { input = JSON.parse(raw); } catch { return [400, { error: 'Invalid JSON' }]; }
    if (!validEnvelope(input, clock()) || !authenticated(raw, signature, secrets[input.installationId])) return [401, { error: 'Unauthorized' }];
    const key = binding(input), now = clock();
    for (const [id, value] of pending) if (value.expires < now) pending.delete(id);
    for (const [id, expiry] of delivered) if (expiry < now) delivered.delete(id);
    if (path === '/v1/enroll') {
      if (pending.size > 10000) return [429, { error: 'Try later' }];
      const previous = pending.get(key);
      if (previous && previous.expires > now + 9 * 60000) return [429, { error: 'Enrollment already pending' }];
      const challenge = randomBytes(32).toString('base64url');
      pending.set(key, { hash: tokenHash(challenge), expires: now + 10 * 60000 });
      await send(input, { aps: { alert: { title: 'EmperorClaw notifications', body: 'Tap to confirm notifications for your connected server.' }, sound: 'default' }, emperor: { installation: input.installationId, challenge } });
      return [200, { confirmationRequired: true }];
    }
    if (path === '/v1/confirm') {
      const candidate = pending.get(key);
      if (!candidate || typeof input.challenge !== 'string' || tokenHash(input.challenge) !== candidate.hash) return [403, { error: 'Invalid confirmation' }];
      verified.add(key); pending.delete(key); await save();
      return [200, { confirmed: true }];
    }
    if (path !== '/v1/push') return [404, { error: 'Not found' }];
    if (!verified.has(key)) return [403, { error: 'Device must confirm enrollment' }];
    if (!uuid(input.eventId) || !uuid(input.companyId) || !uuid(input.resourceId) || !['approval', 'task', 'inbox'].includes(input.kind)) return [400, { error: 'Invalid notification' }];
    const eventKey = `${key}:${input.eventId}`;
    if (delivered.has(eventKey)) return [200, { duplicate: true }];
    // At-most-once attempt: ambiguous APNs outcomes aren't blindly resent.
    if (delivered.size > 50000) return [429, { error: 'Try later' }];
    delivered.set(eventKey, now + 86400000);
    await send(input, { aps: { alert: { title: 'EmperorClaw', body: 'Your team needs your attention. Open to review.' }, sound: 'default', 'content-available': 1 }, emperor: { installation: input.installationId, company: input.companyId, kind: input.kind, id: input.resourceId } });
    return [200, { accepted: true }];
  };
}

export async function apnsSender(env) {
  const key = createPrivateKey(await readFile(env.APNS_KEY_PATH));
  if (!env.APNS_TEAM_ID || !env.APNS_KEY_ID || !env.APNS_TOPIC) throw new Error('Configure APNS_TEAM_ID, APNS_KEY_ID and APNS_TOPIC');
  let cached, issued = 0;
  return async (input, payload) => {
    if (!cached || Date.now() - issued > 50 * 60000) {
      const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: env.APNS_KEY_ID })).toString('base64url');
      const claims = Buffer.from(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })).toString('base64url');
      const unsigned = `${header}.${claims}`;
      cached = `${unsigned}.${sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`; issued = Date.now();
    }
    const session = connect(input.environment === 'sandbox' ? 'https://api.sandbox.push.apple.com' : 'https://api.push.apple.com');
    try {
      await new Promise((resolve, reject) => {
        session.once('error', reject);
        const req = session.request({ ':method': 'POST', ':path': `/3/device/${input.deviceToken}`, authorization: `bearer ${cached}`, 'apns-topic': input.deviceKind === 'watch' ? `${env.APNS_TOPIC}.watchkitapp` : env.APNS_TOPIC, 'apns-push-type': 'alert', 'apns-priority': '10', 'apns-expiration': String(Math.floor(Date.now()/1000) + 3600), ...(input.eventId ? { 'apns-collapse-id': input.eventId } : {}) });
        let status; req.on('response', headers => { status = headers[':status']; }); req.on('data', () => {});
        req.setTimeout(10000, () => req.destroy(new Error('APNs timeout'))); req.once('error', reject);
        req.once('end', () => status === 200 ? resolve() : reject(new Error(`APNs returned ${status}`)));
        req.end(JSON.stringify(payload));
      });
    } finally { session.close(); }
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secrets = JSON.parse(process.env.PUSH_INSTALLATIONS_JSON || '{}');
  if (!Object.keys(secrets).length || Object.values(secrets).some(secret => typeof secret !== 'string' || secret.length < 32)) throw new Error('Configure per-installation secrets of at least 32 characters');
  const handle = createRelay({ secrets, send: await apnsSender(process.env), stateFile: process.env.PUSH_STATE_FILE || './data/devices.json' });
  createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      let data = Buffer.alloc(0);
      for await (const chunk of req) { data = Buffer.concat([data, chunk]); if (data.length > 8192) { res.writeHead(413); return res.end(); } }
      const [status, result] = await handle(req.url, data.toString('utf8'), req.headers['x-emperor-signature']);
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(result));
    } catch { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Push delivery unavailable' })); }
  }).listen(Number(process.env.PORT || 8087), '127.0.0.1', () => console.log('Apple push relay listening on loopback'));
}
