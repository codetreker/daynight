import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: ['**/assistant-tasks.browser.ts', '**/bots-viewport.browser.ts', '**/assistant-modern.browser.ts', '**/bot-create.browser.ts', '**/bot-persistent-history.browser.ts', '**/bot-cache-combination.browser.ts'], workers: 1, retries: 0, timeout: 45_000,
  outputDir: fileURLToPath(new URL('../../.tmp/acceptance/bots-viewport', import.meta.url)), reporter: 'line',
  use: { ...(process.env.DAYNIGHT_BROWSER_CHANNEL ? { channel: process.env.DAYNIGHT_BROWSER_CHANNEL } : {}), baseURL: 'http://127.0.0.1:4198', locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite --config tests/navigation/bots-viewport-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4198/bots', reuseExistingServer: false, timeout: 90_000 },
});
