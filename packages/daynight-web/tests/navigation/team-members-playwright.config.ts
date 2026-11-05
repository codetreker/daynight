import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/team-members.browser.ts', workers: 1, retries: 0, timeout: 30_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/team-members-results', import.meta.url)), reporter: 'line',
  use: { baseURL: 'http://127.0.0.1:4194', viewport: { width: 1280, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/team-preference-vite.config.ts && pnpm exec vite preview --config tests/navigation/team-preference-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4194/projects', reuseExistingServer: false, timeout: 90_000 },
});
