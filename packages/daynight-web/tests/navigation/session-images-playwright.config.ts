import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url)), executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
export default defineConfig({
  testDir: '.', testMatch: ['**/session-images.browser.ts', '**/session-images-records.browser.ts', '**/session-images-bots.browser.ts'], workers: 1, retries: 0, timeout: 45_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/session-images/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/session-images/results.json', import.meta.url)) }]],
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:14292', viewport: { width: 1360, height: 900 }, locale: 'en-US', reducedMotion: 'reduce', screenshot: 'only-on-failure', ...(executable === undefined ? {} : { launchOptions: { executablePath: executable } }) },
  webServer: { command: `"${process.execPath}" node_modules/vite/bin/vite.js build --outDir ../../.tmp/session-images/app --emptyOutDir && "${process.execPath}" node_modules/vite/bin/vite.js preview --outDir ../../.tmp/session-images/app --host 127.0.0.1 --port 14292 --strictPort`, cwd: root, url: 'http://127.0.0.1:14292/projects', reuseExistingServer: false, timeout: 120_000 },
});
