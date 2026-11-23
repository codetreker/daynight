import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/goal-acceptance.browser.ts', workers: 1, retries: 0,
  timeout: 45_000, globalTimeout: 300_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/goal-acceptance-results', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:4244', locale: 'en-US', screenshot: 'only-on-failure',
    launchOptions: { ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE }) } },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/goal-acceptance-vite.config.ts && pnpm exec vite preview --config tests/navigation/goal-acceptance-vite.config.ts',
    cwd: root, url: 'http://127.0.0.1:4244/projects', reuseExistingServer: false, timeout: 90_000 },
});
