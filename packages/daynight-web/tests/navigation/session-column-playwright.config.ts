import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
export default defineConfig({
  testDir: '.', testMatch: '**/session-column.browser.ts', workers: 1, retries: 0, timeout: 45_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/session-column/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/session-column/results.json', import.meta.url)) }]],
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:4303', viewport: { width: 1360, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure',
    // Headless Chromium otherwise suppresses classic scrollbar layout entirely.
    launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'], ...(executable === undefined ? {} : { executablePath: executable }) }, },
  webServer: { command: 'pnpm exec vite build --outDir ../../.tmp/session-column/app --emptyOutDir && pnpm exec vite preview --outDir ../../.tmp/session-column/app --port 4303 --strictPort', cwd: root, url: 'http://127.0.0.1:4303/projects', reuseExistingServer: false, timeout: 120_000 },
});
