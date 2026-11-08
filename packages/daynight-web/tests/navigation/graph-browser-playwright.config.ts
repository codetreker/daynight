import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/graph-browser.browser.ts', workers: 1, retries: 0, timeout: 45_000,
  outputDir: fileURLToPath(new URL('../../.tmp/graph-browser-results', import.meta.url)), reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:4204', viewport: { width: 1600, height: 1100 }, screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/graph-browser-vite.config.ts && pnpm exec vite preview --config tests/navigation/graph-browser-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4204/tests/navigation/graph-browser.html', reuseExistingServer: false, timeout: 90_000 },
});
