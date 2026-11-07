import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/project-deletion-layout.browser.ts', workers: 1, retries: 0, timeout: 30_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/project-deletion-layout/results', import.meta.url)), reporter: 'line',
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:4397', viewport: { width: 320, height: 720 }, locale: 'en-US' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/project-deletion-layout-vite.config.ts && pnpm exec vite preview --config tests/navigation/project-deletion-layout-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4397/projects', reuseExistingServer: false, timeout: 90_000 },
});
