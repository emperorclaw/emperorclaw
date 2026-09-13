const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('integrations/codex/emperor-codex-bridge.js', 'utf8');
const guards = source.slice(source.indexOf('async function checkBudget()'), source.indexOf('async function syncMessages()'));
function runtime(api) {
    return vm.createContext({ api, AGENT_ID: 'agent', log() {} });
}

test('Codex denies paused, malformed and failed budget checks', async () => {
    for (const response of [{}, {agent: {budgetStatus: 'paused', executionAllowed: false}}, {agent: {executionAllowed: true, budgetStatus: 'paused'}}]) {
        const ctx = runtime(async () => response);
        assert.equal(await vm.runInContext(guards + '; checkBudget()', ctx), false);
    }
    const ctx = runtime(async () => { throw Error('503'); });
    assert.equal(await vm.runInContext(guards + '; checkBudget()', ctx), false);
});

test('Codex flushes pending usage before allowing another turn', async () => {
    let offline = true;
    const calls = [];
    const ctx = runtime(async (method) => {
        calls.push(method);
        if (offline) throw Error('offline');
        return {agent: {executionAllowed: true, budgetStatus: 'active'}};
    });
    vm.runInContext(guards, ctx);
    await assert.rejects(vm.runInContext('reportUsage(100, 50)', ctx));
    assert.equal(await vm.runInContext('checkBudget()', ctx), false);
    offline = false;
    assert.equal(await vm.runInContext('checkBudget()', ctx), true);
    assert.deepEqual(calls, ['POST', 'POST', 'POST', 'GET']);
});

test('Codex polling never invokes the CLI or consumes a budget-blocked message', async () => {
    let spawns = 0;
    const stop = new Error('end test poll');
    const ctx = vm.createContext({
        require(name) {
            if (name === 'child_process') return { spawn() { spawns++; throw Error('must not run'); } };
            if (name === './bridge-logic') return require('../../integrations/codex/bridge-logic');
            return require(name);
        },
        process: {env: {EMPEROR_CLAW_API_TOKEN: 'test', EMPEROR_CLAW_AGENT_ID: 'agent'}},
        console: {log() {}},
        setTimeout() { throw stop; },
        async fetch(url) {
            const payload = url.includes('/messages/sync') ? {messages: [{id: 'message', text: 'hello', senderType: 'human', targetAgentId: 'agent', threadType: 'direct'}]}
                : url.endsWith('/agents/agent') ? {agent: {budgetStatus: 'paused', executionAllowed: false}} : {};
            return {ok: true, text: async () => JSON.stringify(payload)};
        },
    });
    const program = source.slice(0, source.lastIndexOf('main().catch('));
    vm.runInContext(program, ctx);
    await assert.rejects(vm.runInContext('main()', ctx), error => error === stop);
    assert.equal(spawns, 0);
    assert.equal(vm.runInContext('seen.has("message")', ctx), false);
});
