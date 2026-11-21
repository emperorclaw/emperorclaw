import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
    testDir: './tests', fullyParallel: false, workers: 1, timeout: 30_000,
    reporter: 'list', outputDir: '/tmp/emperor-chat-playwright',
    use: { ...devices['iPhone 13'], browserName: 'webkit', trace: 'retain-on-failure' },
    webServer: { command: 'python3 -m http.server 3188 --bind 127.0.0.1 --directory apps/apple/iPhone/ChatWeb', cwd: '../../..', url: 'http://127.0.0.1:3188', reuseExistingServer: true },
});
