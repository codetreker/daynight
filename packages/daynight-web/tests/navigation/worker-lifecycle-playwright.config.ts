import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/worker-lifecycle.browser.ts', workers: 1, retries: 0,
  timeout: 45_000, globalTimeout: 360_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/worker-lifecycle/browser/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/worker-lifecycle/browser/report.json', import.meta.url)) }]],
  use: { channel: 'chromium', launchOptions: { ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE }) },
    baseURL: 'http://127.0.0.1:4248', screenshot: 'only-on-failure', trace: 'retain-on-failure', video: 'retain-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js build --config tests/navigation/product-shell-vite.config.ts --outDir ../../.tmp/worker-lifecycle/browser/host && node node_modules/vite/bin/vite.js preview --config tests/navigation/product-shell-vite.config.ts --outDir ../../.tmp/worker-lifecycle/browser/host --port 4248 --strictPort',
    cwd: root, url: 'http://127.0.0.1:4248', reuseExistingServer: false, timeout: 120_000 },
});
