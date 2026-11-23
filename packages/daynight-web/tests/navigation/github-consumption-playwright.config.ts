import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/github-consumption.browser.ts', workers: 1, retries: 0, timeout: 30_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/github-consumption-results', import.meta.url)), reporter: 'line',
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:4199', viewport: { width: 1280, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/github-consumption-vite.config.ts && pnpm exec vite preview --config tests/navigation/github-consumption-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4199/tests/navigation/github-consumption.html', reuseExistingServer: false, timeout: 90_000 },
});
