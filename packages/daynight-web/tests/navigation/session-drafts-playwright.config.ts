import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url)), executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
export default defineConfig({
  testDir: '.', testMatch: '**/session-drafts.browser.ts', workers: 1, retries: 0, timeout: 45_000, globalTimeout: 360_000,
  grepInvert: /@capacity/,
  outputDir: fileURLToPath(new URL('../../.tmp/session-drafts-browser/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../.tmp/session-drafts-browser/results.json', import.meta.url)) }]],
  use: { channel: process.env.DAYNIGHT_BROWSER_CHANNEL ?? 'chromium', baseURL: 'http://127.0.0.1:14293', viewport: { width: 1100, height: 800 }, reducedMotion: 'reduce', screenshot: 'only-on-failure', ...(executable === undefined ? {} : { launchOptions: { executablePath: executable } }) },
  webServer: { command: `"${process.execPath}" node_modules/vite/bin/vite.js build --config tests/navigation/session-drafts-vite.config.ts && "${process.execPath}" node_modules/vite/bin/vite.js preview --config tests/navigation/session-drafts-vite.config.ts`, cwd: root, url: 'http://127.0.0.1:14293/tests/navigation/session-drafts-fixture.html', reuseExistingServer: false, timeout: 90_000 },
});
