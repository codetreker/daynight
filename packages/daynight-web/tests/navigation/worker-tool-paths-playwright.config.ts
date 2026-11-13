import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/worker-tool-paths.browser.ts', workers: 1, retries: 0,
  timeout: 30_000, globalTimeout: 360_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/worker-tool-paths/browser/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/worker-tool-paths/browser/report.json', import.meta.url)) }]],
  use: { channel: 'chromium', launchOptions: { ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE }) }, baseURL: 'http://127.0.0.1:4217', locale: 'zh-CN', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 4217 --strictPort', cwd: root, url: 'http://127.0.0.1:4217', reuseExistingServer: false, timeout: 90_000 },
});
