const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

// Exercise the real wake entry point without a database or message transport.
function loadWake() {
  let effects = 0;
  const source = readFileSync(resolve(__dirname, '../src/lib/task-wake.ts'), 'utf8');
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText, {
    exports,
    console: { warn() {} },
    require(name) {
      if (name === '@/lib/agent-scope') return {
        getAgentScope: async () => { effects++; throw new Error('wake attempted'); },
      };
      if (name === '@/lib/task-state') return { SLA_TRACKED_TASK_STATES: [] };
      return {};
    },
  });
  return { wake: exports.wakeAgentOnTaskAssignment, effects: () => effects };
}

for (const reason of ['assigned', 'reassigned']) {
  test(`self-${reason} produces no wake side effects`, async () => {
    const loaded = loadWake();
    await loaded.wake({ companyId: 'company', task: { assignedAgentId: 'self' }, actorAgentId: 'self', reason });
    assert.equal(loaded.effects(), 0);
  });
}
test('another agent or a human assignment reaches the wake path', async () => {
  for (const actorAgentId of ['other', null]) {
    const loaded = loadWake();
    await loaded.wake({ companyId: 'company', task: { assignedAgentId: 'self' }, actorAgentId, assignedByLabel: 'Teammate', reason: 'assigned' });
    assert.equal(loaded.effects(), 1);
  }
});

test('REST assignment preserves the authenticated actor separately from the target', () => {
  const route = readFileSync(resolve(__dirname, '../src/app/api/mcp/tasks/[id]/assign/route.ts'), 'utf8');
  const service = readFileSync(resolve(__dirname, '../src/lib/openclaw/tasks.ts'), 'utf8');
  assert.match(route, /actorAgentId: auth\.companyToken!\.agentId \?\? null/);
  const assign = service.slice(service.indexOf('export async function assignTaskToAgent'), service.indexOf('export async function updateTaskForCompany'));
  assert.match(assign, /actorAgentId: input\.actorAgentId/);
});
test('task creation uses token identity before a caller-supplied agent identity', () => {
  const route = readFileSync(resolve(__dirname, '../src/app/api/mcp/tasks/route.ts'), 'utf8');
  assert.match(route, /actorIdentity = auth\.companyToken!\.agentId \|\| agentId/);
});
