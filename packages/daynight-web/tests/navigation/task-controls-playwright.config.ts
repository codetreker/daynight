import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/task-controls.browser.ts', workers: 1, retries: 0,
  timeout: 30_000, globalTimeout: 180_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/task-controls-results', import.meta.url)),
  use: { baseURL: 'http://127.0.0.1:4203', viewport: { width: 1280, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/task-controls-vite.config.ts && pnpm exec vite preview --config tests/navigation/task-controls-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4203/projects', reuseExistingServer: false, timeout: 90_000 },
});
