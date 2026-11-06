import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/task-view-continuity.browser.ts', workers: 1, retries: 0, timeout: 60_000, globalTimeout: 180_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/task-view-continuity-results', import.meta.url)),
  use: { channel: 'chromium', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), baseURL: 'http://127.0.0.1:4212', viewport: { width: 1100, height: 700 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/task-view-continuity-vite.config.ts && pnpm exec vite preview --config tests/navigation/task-view-continuity-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4212/projects', reuseExistingServer: false, timeout: 90_000 },
});
