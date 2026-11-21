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

test('fleet uses web characters, real work and native agent navigation; stale and reduced motion stop animation', async ({ page }) => {
    const agents = [{ id: uuid, name: 'Builder', role: 'Engineering', state: 'working', activity: 'Checking the iPhone layout' }];
    await update(page, payload({ mode: 'fleet', agents, fresh: true }));
    await expect(page.getByRole('heading', { name: 'Builder' })).toBeVisible();
    await expect(page.locator('.desk-figure svg, .desk-figure path').first()).toBeAttached();
    await expect(page.locator('.desk-figure')).toHaveCSS('animation-name', 'desk-breathe');
    await page.getByRole('button', { name: /Builder, Working/ }).click();
    expect(await page.evaluate(() => (window as unknown as { nativeMessages: unknown[] }).nativeMessages)).toContainEqual({ type: 'agent', agentId: uuid });
    await update(page, payload({ mode: 'fleet', agents, fresh: false }));
    await expect(page.locator('.desk-figure')).toHaveCSS('animation-name', 'none');
    await expect(page.getByText('Last known status')).toBeVisible();
    await update(page, payload({ mode: 'fleet', agents, fresh: true, reducedMotion: true }));
    await expect(page.locator('.desk-figure')).toHaveCSS('animation-name', 'none');
    await page.setViewportSize({ width: 390, height: 620 });
    await update(page, payload({ mode: 'fleet', agents: Array.from({ length: 8 }, (_, i) => ({ ...agents[0], id: String(i), name: `Agent ${i}`, role: 'Long role description that belongs only in agent details' })), fresh: true }));
    await expect(page.getByText('Long role description', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Agent 7,/ })).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: '/tmp/emperor-fleet-compact.png' });
});

test('rich documents report their full height and render Markdown tables', async ({ page }) => {
    await update(page, payload({ mode: 'document', embedded: true, text: '# Project brief\n\n| Item | Result |\n| --- | --- |\n| Native | Ready |\n\n```ts\nconst ready = true;\n```' }));
    await expect(page.getByRole('heading', { name: 'Project brief' })).toBeVisible();
    await expect(page.locator('table')).toContainText('Ready');
    await expect.poll(() => page.evaluate(() => (window as unknown as { nativeMessages: { type: string; height?: number }[] }).nativeMessages.some(m => m.type === 'height' && (m.height ?? 0) > 100))).toBe(true);
});

test('all seven View panels adapt between narrow and wide layouts in both appearances; metadata remains private', async ({ page }) => {
    const chart = { series: [{ name: 'Agents', points: [{ x: 'Mon', y: 2 }, { x: 'Tue', y: 5 }] }] };
    const panels = [
        { type: 'metric', data: { value: 8, unit: 'agents' } },
        { type: 'line', data: chart }, { type: 'bar', data: chart },
        { type: 'table', data: { columns: [{ key: 'name', label: 'Name' }], rows: [{ name: 'Builder' }] } },
        { type: 'list', data: { items: [{ title: 'Review native build', value: 'Ready' }] } },
        { type: 'markdown', data: { text: '**Release** is ready' } },
        { type: 'progress', data: { value: 3, max: 5 } },
    ].map((p, i) => ({ ...p, id: `panel-${i}`, title: `Panel ${p.type}`, w: 6, h: 2, updatedAt: new Date().toISOString(), updatedBy: null }));
    const view = { title: 'Team pulse', access: 'full', panels, createdAt: new Date().toISOString() };
    for (const width of [320, 430, 850]) {
        await page.setViewportSize({ width, height: 900 });
        for (const dark of [true, false]) {
            await update(page, payload({ mode: 'view', view, dark }));
            await expect(page.getByRole('heading', { name: 'Team pulse' })).toBeVisible();
            for (const panel of panels) await expect(page.getByText(panel.title, { exact: true })).toHaveCount(1);
            await expect(page.locator('.surface-scroll')).toHaveJSProperty('scrollWidth', width);
        }
    }
    await page.screenshot({ path: '/tmp/emperor-views-wide.png', fullPage: true });
    await update(page, payload({ mode: 'view', view: { ...view, access: 'metadata' } }));
    await expect(page.getByRole('heading', { name: 'This view is private' })).toBeVisible();
    await expect(page.getByText('Panel metric', { exact: true })).toHaveCount(0);
});

test('View focus expands the real panel, supports dismissal and clears private data when access changes', async ({ page }) => {
    const panel = { id: 'delivery', title: 'Delivery momentum', type: 'table', w: 12, h: 3, data: { columns: [{ key: 'name', label: 'Project' }], rows: [{ name: 'Aurora' }] }, updatedAt: new Date().toISOString(), updatedBy: null };
    const view = { title: 'Operations, in focus.', access: 'full', scopeLabel: 'Company', maintainer: { name: 'Atlas' }, panels: [panel], createdAt: new Date().toISOString() };
    await update(page, payload({ mode: 'view', view, dark: false }));
    await page.getByRole('button', { name: 'Expand Delivery momentum' }).click();
    await expect(page.getByRole('dialog', { name: 'Delivery momentum expanded' })).toBeVisible();
    await expect(page.getByRole('dialog').locator('table')).toContainText('Aurora');
    await expect(page.getByRole('button', { name: 'Close expanded panel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Expand Delivery momentum' })).toBeFocused();
    await page.getByRole('button', { name: 'Expand Delivery momentum' }).click();
    await page.getByRole('button', { name: 'Close expanded panel' }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Expand Delivery momentum' }).click();
    await update(page, payload({ mode: 'view', view: { ...view, access: 'metadata' } }));
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('Aurora')).toHaveCount(0);
});
test('signals the first painted transcript once and explains an empty conversation without hiding activity', async ({ page }) => {
    const painted = () => page.evaluate(() => (window as unknown as { nativeMessages: { type: string }[] }).nativeMessages.filter(message => message.type === 'painted').length);
    await update(page, payload({ loaded: false }));
    await expect(page.getByText('Loading conversation…')).toBeVisible(); expect(await painted()).toBe(0);
    await update(page, payload());
    await expect(page.getByText('Start a conversation with Builder')).toBeVisible();
    await expect.poll(painted).toBe(1);
    await update(page, payload({ participants: [{ participantType: 'agent', participantId: uuid, typingUntil: new Date(Date.now() + 60_000).toISOString(), currentActivity: 'Reading project files' }] }));
    await expect(page.locator('.chat-empty')).toHaveCount(0);
    await update(page, payload({ messages: [message('1', 'Hello')] }));
    await expect(page.locator('.chat-empty')).toHaveCount(0); expect(await painted()).toBe(1);
});
test('shows motion, not status words, while a reply is on its way', async ({ page }) => {
    const preview = { responseId: uuid, runId: uuid, agentId: uuid, agentName: 'Builder', segmentIndex: 0, revision: 1, text: '', state: 'streaming', updatedAt: '2026-11-21T12:10:00Z', finalMessageId: null, runStatus: 'running' };
    await update(page, payload({ previews: [preview] }));
    await expect(page.locator('.typing-dots')).toBeVisible();
    await expect(page.locator('.sr-only', { hasText: 'Responding…' })).toHaveCount(1); // VoiceOver only
    await expect(page.locator('.preview-note')).toHaveCount(0);
    await update(page, payload({ previews: [{ ...preview, revision: 2, text: 'Hello there' }] }));
    await expect(page.locator('.typing-dots')).toHaveCount(0);
    await expect(page.locator('.stream-caret')).toBeVisible();
    await update(page, payload({ previews: [{ ...preview, revision: 3, text: 'Hello there', state: 'interrupted' }] }));
    await expect(page.locator('.stream-caret')).toHaveCount(0);
    await expect(page.getByText('Response interrupted')).toBeVisible();
    const run = { runId: uuid, agentId: uuid, status: 'running', startedAt: new Date().toISOString(), current: { kind: 'reasoning', summary: 'Reading project files', sinceMs: 1000 }, steps: [] };
    await update(page, payload({ liveRuns: [run] }));
    await expect(page.locator('.activity .thinking-glyph')).toBeVisible();
    await expect(page.locator('.activity .shimmer')).toHaveText('Reading project files');
});
test('one live indicator, always after the newest reply', async ({ page }) => {
    const empty = { responseId: uuid, runId: uuid, agentId: uuid, agentName: 'Builder', segmentIndex: 1, revision: 1, text: '', state: 'streaming', updatedAt: '2026-11-21T12:05:00Z', finalMessageId: null, runStatus: 'running' };
    const messages = [message('10', 'Older'), message('20', 'Newest reply')];
    await update(page, payload({ messages, previews: [empty] }));
    const order = () => page.locator('.chat-message').evaluateAll(rows => rows.map(row => row.querySelector('.typing-dots') ? 'dots' : row.textContent?.includes('Newest') ? 'newest' : 'other'));
    await expect.poll(order).toEqual(['other', 'newest', 'dots']);
    const run = { runId: uuid, agentId: uuid, status: 'running', startedAt: new Date().toISOString(), current: { kind: 'reasoning', summary: 'Still working', sinceMs: 1000 }, steps: [] };
    await update(page, payload({ messages, previews: [empty], liveRuns: [run] }));
    await expect(page.locator('.typing-dots')).toHaveCount(0);
    await expect(page.locator('.thinking-glyph')).toHaveCount(1);
});
test('history appears still; new rows rise in; finished work collapses instead of vanishing', async ({ page }) => {
    const history = [message('10', 'Older'), message('20', 'Newer')];
    await update(page, payload({ messages: history }));
    await expect(page.locator('.chat-message.row-enter')).toHaveCount(0);
    await update(page, payload({ messages: [...history, message('30', 'Arrived later')] }));
    await expect(page.locator('.chat-message.row-enter')).toHaveCount(1);
    const run = { runId: uuid, agentId: uuid, status: 'running', startedAt: new Date().toISOString(), current: { kind: 'reasoning', summary: 'Thinking it through', sinceMs: 1000 }, steps: [] };
    await update(page, payload({ messages: history, liveRuns: [run] }));
    await expect(page.locator('.live-area.is-open .activity')).toHaveCount(1);
    await update(page, payload({ messages: history, liveRuns: [{ ...run, status: 'completed' }] }));
    await expect(page.locator('.live-area.is-closing')).toHaveText(/Thinking it through/);
    await expect(page.locator('.live-area')).toHaveCount(0);
});
