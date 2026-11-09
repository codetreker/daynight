import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/task-reading.browser.ts', workers: 1, retries: 0,
  timeout: 45_000, globalTimeout: 240_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/task-reading-results', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:4204', viewport: { width: 1280, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/task-reading-vite.config.ts && pnpm exec vite preview --config tests/navigation/task-reading-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4204/projects', reuseExistingServer: false, timeout: 90_000 },
});
