import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/worker-configuration-navigation.browser.ts', workers: 1, retries: 0,
  timeout: 30_000, globalTimeout: 360_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/worker-navigation/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/worker-navigation/browser.json', import.meta.url)) }]],
  use: { channel: 'chromium', launchOptions: { ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE }) }, baseURL: 'http://127.0.0.1:4207', locale: 'zh-CN', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build && pnpm exec vite preview --port 4207 --strictPort', cwd: root, url: 'http://127.0.0.1:4207', reuseExistingServer: false, timeout: 90_000 },
});
