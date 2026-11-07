import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/project-withdrawal.browser.ts', workers: 1, retries: 0, timeout: 60_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/project-withdrawal/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/project-withdrawal/report.json', import.meta.url)) }]],
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:4288', viewport: { width: 1280, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/project-withdrawal-vite.config.ts && pnpm exec vite preview --config tests/navigation/project-withdrawal-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4288/projects', reuseExistingServer: false, timeout: 120_000 },
});
