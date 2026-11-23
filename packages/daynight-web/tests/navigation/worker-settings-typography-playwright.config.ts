import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/worker-settings-typography.browser.ts', workers: 1, retries: 0,
  timeout: 45_000, globalTimeout: 360_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/typography-h/browser-results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/typography-h/browser-report.json', import.meta.url)) }]],
  use: {
    baseURL: 'http://127.0.0.1:4238', screenshot: 'only-on-failure',
    launchOptions: { ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE }) },
  },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js build --config tests/navigation/product-shell-vite.config.ts --outDir ../../.tmp/typography-h/browser-host && node node_modules/vite/bin/vite.js preview --config tests/navigation/product-shell-vite.config.ts --outDir ../../.tmp/typography-h/browser-host --port 4238 --strictPort',
    cwd: root, url: 'http://127.0.0.1:4238', reuseExistingServer: false, timeout: 120_000,
  },
});
