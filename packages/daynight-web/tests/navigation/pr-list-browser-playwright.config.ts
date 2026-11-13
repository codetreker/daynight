import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/pr-list.browser.ts', workers: 1, retries: 0, timeout: 60_000, globalTimeout: 360_000,
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/pr-list-browser/report.json', import.meta.url)) }]],
  outputDir: fileURLToPath(new URL('../../../../.tmp/pr-list-browser/results', import.meta.url)),
  use: { channel: process.env.DAYNIGHT_BROWSER_CHANNEL ?? 'chromium',
    ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }),
    baseURL: 'http://127.0.0.1:14303', viewport: { width: 1440, height: 900 }, locale: 'en-US', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  webServer: { command: 'node node_modules/vite/bin/vite.js build --config tests/navigation/pr-list-browser-vite.config.ts && node node_modules/vite/bin/vite.js preview --config tests/navigation/pr-list-browser-vite.config.ts', cwd: root,
    url: 'http://127.0.0.1:14303/projects', reuseExistingServer: false, timeout: 120_000 },
});
