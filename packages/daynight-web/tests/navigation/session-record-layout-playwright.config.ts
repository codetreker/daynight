import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
export default defineConfig({
  testDir: '.', testMatch: '**/session-record-layout.browser.ts', workers: 1, retries: 0, timeout: 45_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/session-selector/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/session-selector/results.json', import.meta.url)) }]],
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:4297', viewport: { width: 1360, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure',
    ...(executable === undefined ? {} : { launchOptions: { executablePath: executable } }), },
  webServer: { command: 'pnpm exec vite build --outDir ../../.tmp/session-selector/app --emptyOutDir && pnpm exec vite preview --outDir ../../.tmp/session-selector/app --port 4297 --strictPort', cwd: root, url: 'http://127.0.0.1:4297/projects', reuseExistingServer: false, timeout: 120_000 },
});
