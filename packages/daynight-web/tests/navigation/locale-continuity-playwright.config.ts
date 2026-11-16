import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: ['**/locale-continuity.browser.ts', '**/account-avatar.browser.ts'], workers: 1, retries: 0, timeout: 60_000, globalTimeout: 180_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/locale-continuity-results', import.meta.url)),
  use: { channel: 'chromium', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), baseURL: 'http://127.0.0.1:4208', viewport: { width: 1440, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/locale-continuity-vite.config.ts && pnpm exec vite preview --config tests/navigation/locale-continuity-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4208/projects', reuseExistingServer: false, timeout: 90_000 },
});
