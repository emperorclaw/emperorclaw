const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'emperor-install-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'docker.log');
  const script = (name, body) => fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${body}`, { mode: 0o755 });
  script('docker', `
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync(process.env.TEST_DOCKER_LOG, args.join(' ')+'\\n');
if(args[0]==='info') process.exit(process.env.TEST_DOCKER_OFFLINE==='1'?1:0);
if(args[0]==='run') { console.log('123');process.exit(0); }
if(args.includes('wget')) process.exit(process.env.TEST_READY_FAILURE==='1'?1:0);
if(args.includes('node')) process.exit(process.env.TEST_SOCKET_FAILURE==='1'?1:0);
process.exit(0);
`);
  script('curl', `
const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);
const url=args.find(a=>a.startsWith('https://'));const out=args[args.indexOf('-o')+1];
if(!args.includes('-o') && process.env.TEST_PUBLIC_FAILURE==='1') process.exit(1);
if(args.includes('-o')) { const relative=url.split('/main/')[1];fs.copyFileSync(path.join(process.env.TEST_BUNDLE_ROOT,relative),out); }
process.exit(0);
`);
  const installDir = path.join(dir, 'server');
  const run = (extra = [], env = {}) => spawnSync('/bin/bash', ['-s', '--', '--dir', installDir, '--no-browser', ...extra], {
    input: source, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TEST_DOCKER_LOG: log, TEST_BUNDLE_ROOT: root, EMPEROR_INSTALL_READY_ATTEMPTS: '1', EMPEROR_INSTALL_PUBLIC_ATTEMPTS: '1', ...env },
    cwd: dir,
  });
  return { run, installDir, log };
}

test('piped installer creates secrets and verifies health and app socket access without Git', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const env = fs.readFileSync(path.join(f.installDir, '.env'), 'utf8');
  for (const key of ['NEXTAUTH_SECRET', 'EMPEROR_CLAW_MASTER_KEY', 'POSTGRES_PASSWORD']) assert.match(env, new RegExp(`^${key}=[a-f0-9]{64}$`, 'm'));
  assert.match(env, /^DOCKER_GID=123$/m);
  const log = fs.readFileSync(f.log, 'utf8');
  assert.match(log, /compose exec -T app wget/); assert.match(log, /compose exec -T app node/);
  assert.match(result.stdout, /Ready!/);
  assert.equal(fs.statSync(path.join(f.installDir, '.env')).mode & 0o777, 0o600);
});

test('rerun preserves encryption secrets and database password', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  const before = fs.readFileSync(path.join(f.installDir, '.env'), 'utf8');
  assert.equal(f.run().status, 0);
  assert.equal(fs.readFileSync(path.join(f.installDir, '.env'), 'utf8'), before);
});

test('legacy env does not rotate its default database password', t => {
  const f = fixture(t); fs.mkdirSync(f.installDir);
  fs.writeFileSync(path.join(f.installDir, '.env'), 'NEXTAUTH_SECRET=existing-secret\nEMPEROR_CLAW_MASTER_KEY=existing-key\n');
  assert.equal(f.run().status, 0);
  const env = fs.readFileSync(path.join(f.installDir, '.env'), 'utf8');
  assert.match(env, /^POSTGRES_PASSWORD=emperor$/m); assert.match(env, /^EMPEROR_CLAW_MASTER_KEY=existing-key$/m);
});

test('domain setup enables HTTPS and retains existing profiles', t => {
  const f = fixture(t); assert.equal(f.run().status, 0);
  fs.appendFileSync(path.join(f.installDir, '.env'), 'COMPOSE_PROFILES=drive\n');
  const result = f.run(['--domain', 'claw.example.com']); assert.equal(result.status, 0, result.stderr);
  const env = fs.readFileSync(path.join(f.installDir, '.env'), 'utf8');
  assert.match(env, /^APP_URL=https:\/\/claw.example.com$/m);
  assert.match(env, /^COMPOSE_PROFILES=drive,https$/m);
});

test('Docker offline and readiness failure do not report ready', t => {
  const f = fixture(t); const offline = f.run([], { TEST_DOCKER_OFFLINE: '1' });
  assert.notEqual(offline.status, 0); assert.doesNotMatch(offline.stdout, /Ready!/);
  const failed = f.run([], { TEST_READY_FAILURE: '1' });
  assert.notEqual(failed.status, 0); assert.match(failed.stderr, /logs --tail=100/); assert.doesNotMatch(failed.stdout, /Ready!/);
});

test('app socket denial prevents false success', t => {
  const f = fixture(t); const result = f.run([], { TEST_SOCKET_FAILURE: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /cannot access Docker/); assert.doesNotMatch(result.stdout, /Ready!/);
});

test('invalid domain is rejected before modifying installation', t => {
  const f = fixture(t); const result = f.run(['--domain', 'https://bad.example/path']);
  assert.notEqual(result.status, 0); assert.equal(fs.existsSync(f.installDir), false);
});

test('public installers match server entry points', () => {
  for (const file of ['install.sh', 'install.ps1']) assert.equal(fs.readFileSync(path.join(root, 'public', file), 'utf8'), fs.readFileSync(path.join(root, file), 'utf8'));
});


test('unreachable public domain does not claim the installation is ready', t => {
  const f = fixture(t); const result = f.run(['--domain', 'claw.example.com'], { TEST_PUBLIC_FAILURE: '1' });
  assert.notEqual(result.status, 0); assert.match(result.stdout, /Check DNS/); assert.doesNotMatch(result.stdout, /Ready!/);
});
