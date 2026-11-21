import { test, expect, type Page } from '@playwright/test';
const uuid = '11111111-1111-4111-8111-111111111111';
const message = (id: string, text: string, senderType = 'agent') => ({ id, text, senderType, createdAt: `2026-11-21T12:${id.padStart(2, '0')}:00Z` });
function payload(extra = {}) { return { messages: [], previews: [], participants: [], agentNames: {}, liveRuns: [], replyRuns: {}, loaded: true, hasMore: false, streaming: true, title: 'Builder', locale: 'en', mayWrite: true, forceBottom: 0, dark: true, loadingOlder: false, ...extra }; }
async function update(page: Page, data: ReturnType<typeof payload>) { await page.evaluate(data => window.emperor.update(data), data); }
async function atBottom(page: Page) { await expect.poll(() => page.locator('#transcript').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(3); }
test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
        (window as unknown as { nativeMessages: unknown[] }).nativeMessages = [];
        window.webkit = { messageHandlers: { chat: { postMessage(message) { (window as unknown as { nativeMessages: unknown[] }).nativeMessages.push(message); } } } };
    });
    await page.goto('http://127.0.0.1:3188');
    await page.waitForFunction(() => !!window.emperor);
});
test('opens long history at the latest reply even when older pages exist; follows growth', async ({ page }) => {
    const messages = Array.from({ length: 45 }, (_, i) => message(String(i), `Message ${i}\n\n` + 'Long reply. '.repeat(20)));
    await update(page, payload({ messages, hasMore: true }));
    await expect(page.locator('.chat-message').last()).toContainText('Message 44');
    await atBottom(page);
    await update(page, payload({ messages: [...messages, message('46', '# Latest\n\n' + 'new '.repeat(200))], hasMore: true }));
    await expect(page.getByRole('heading', { name: 'Latest' })).toBeVisible(); await atBottom(page);
});
test('reading up survives incoming replies and prepended history; explicit latest resumes following', async ({ page }) => {
    const messages = Array.from({ length: 35 }, (_, i) => message(String(i + 10), `Message ${i + 10}\n\n` + 'Long reply. '.repeat(30)));
    await update(page, payload({ messages, hasMore: true })); await atBottom(page);
    await page.locator('#transcript').evaluate(node => { node.scrollTop = 900; node.dispatchEvent(new Event('scroll')); });
    const before = await page.locator('[data-message-id="15"]').evaluate(node => node.getBoundingClientRect().top);
    await update(page, payload({ messages: [message('9', 'Older '.repeat(200)), ...messages, message('46', 'New reply')], hasMore: true }));
    await expect.poll(async () => Math.abs(await page.locator('[data-message-id="15"]').evaluate(node => node.getBoundingClientRect().top) - before)).toBeLessThan(2);
    await expect(page.getByRole('button', { name: 'Latest message' })).toBeVisible();
    await page.getByRole('button', { name: 'Latest message' }).click(); await atBottom(page);
});
test('partial Markdown updates in place and reconciles with one rich final reply', async ({ page }) => {
    const preview = { responseId: uuid, runId: uuid, agentId: uuid, agentName: 'Builder', segmentIndex: 0, revision: 1, text: '**Partial**\n\n```html\n<button>Preview must be inert</button>\n```', state: 'streaming', updatedAt: '2026-11-21T12:10:00Z', finalMessageId: null, runStatus: 'running' };
    await update(page, payload({ previews: [preview] }));
    await expect(page.locator('strong')).toHaveText('Partial'); await expect(page.locator('iframe')).toHaveCount(0);
    await update(page, payload({ previews: [{ ...preview, revision: 2, text: '**Partial updated**', state: 'sealed' }] }));
    await expect(page.locator('strong')).toHaveText('Partial updated');
    await update(page, payload({ messages: [message('10', '# Saved reply\n\n| Name | Result |\n| --- | --- |\n| Check | Passed |')], previews: [{ ...preview, finalMessageId: '10', state: 'completed' }] }));
    await expect(page.locator('.chat-message')).toHaveCount(1); await expect(page.locator('table')).toContainText('Passed');
    await expect(page.locator(`[data-message-id="${uuid}"]`)).toHaveCount(1); await atBottom(page);
});
test('renders real web rich components and sends choices through the native bridge', async ({ page }) => {
    const text = '# Rich reply\n\n> [!NOTE]\n> Useful note\n\n```stats\n[{"label":"Agents","value":"8"}]\n```\n\n```tabs\n=== Summary\nHello tab\n=== Details\nOther tab\n```\n\n```choices\n{"options":[{"label":"Continue","prompt":"Continue please"}]}\n```\n\n```html\n<button data-emperor-send="Widget action">Widget button</button>\n```';
    await update(page, payload({ messages: [message('1', text)] }));
    await expect(page.getByText('Useful note')).toHaveCount(1);
    await expect(page.getByText('Agents', { exact: true })).toHaveCount(1);
    await expect(page.getByRole('tab')).toHaveCount(2);
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(page.locator('iframe')).not.toHaveAttribute('sandbox', /allow-same-origin/);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { nativeMessages: { type: string; prompt?: string }[] }).nativeMessages.filter(message => message.type === 'sendPrompt').map(message => message.prompt))).toEqual(['Continue please']);
    await page.frameLocator('iframe').getByRole('button', { name: 'Widget button' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { nativeMessages: { type: string; prompt?: string }[] }).nativeMessages.filter(message => message.type === 'sendPrompt').map(message => message.prompt))).toEqual(['Continue please', 'Widget action']);
});
test('shows actual run steps and reasoning and falls back to participant activity', async ({ page }) => {
    const run = { runId: uuid, agentId: uuid, status: 'running', startedAt: new Date().toISOString(), current: { kind: 'tool.start', summary: 'Running terminal · npm test', sinceMs: 1000 }, steps: [{ seq: 1, ts: new Date().toISOString(), kind: 'reasoning', summary: 'Checking the result' }, { seq: 2, ts: new Date().toISOString(), kind: 'tool', toolName: 'terminal', status: 'running', summary: 'npm test' }] };
    await update(page, payload({ liveRuns: [run] }));
    await expect(page.getByRole('status')).toContainText('Running terminal');
    await expect(page.getByText(/Checking the result/)).toHaveCount(1);
    await update(page, payload({ participants: [{ participantType: 'agent', participantId: uuid, typingUntil: new Date(Date.now() + 60_000).toISOString(), currentActivity: 'Reading project files' }] }));
    await expect(page.getByRole('status')).toContainText('Reading project files');
    await update(page, payload()); await expect(page.locator('.activity')).toHaveCount(0);
});
test('lazily reads reasoning and entity cards through scoped native capabilities', async ({ page }) => {
    const row = { ...message(uuid, `[Agent](emperor://agent/${uuid})`), metadataJson: { hasReasoning: true } };
    await update(page, payload({ messages: [row] }));
    await expect.poll(() => page.evaluate(() => (window as unknown as { nativeMessages: { type: string; url?: string }[] }).nativeMessages.filter(message => message.type === 'resource').length)).toBe(1);
    await page.evaluate(uuid => {
        const requests = (window as unknown as { nativeMessages: { id: string; type: string; url?: string }[] }).nativeMessages;
        const entity = requests.find(message => message.type === 'resource')!;
        window.emperor.resolve(entity.id, { entities: { [`agent:${uuid}`]: { kind: 'agent', id: uuid, title: 'Live agent name', status: 'working', role: 'Engineer', href: `/agents/${uuid}` } } });
    }, uuid);
    await expect(page.getByText('Live agent name')).toBeVisible();
    await page.getByRole('button', { name: 'Show reasoning' }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { nativeMessages: { type: string; url?: string }[] }).nativeMessages.filter(message => message.url?.includes('/chat/reasoning')).length)).toBe(1);
    await page.evaluate(() => {
        const request = (window as unknown as { nativeMessages: { id: string; url?: string }[] }).nativeMessages.find(message => message.url?.includes('/chat/reasoning'))!;
        window.emperor.resolve(request.id, { reasoning: 'Persisted reasoning from the authorized message' });
    });
    await expect(page.getByText('Persisted reasoning from the authorized message')).toBeVisible();
    await expect(page.evaluate(async () => { try { await fetch('/api/settings/tokens'); return false; } catch { return true; } })).resolves.toBe(true);
});
