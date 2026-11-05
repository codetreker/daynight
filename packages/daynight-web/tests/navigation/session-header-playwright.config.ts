import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
const executable = process.env.DAYNIGHT_BROWSER_EXECUTABLE;
export default defineConfig({
  testDir: '.', testMatch: '**/session-header.browser.ts', workers: 1, retries: 0, timeout: 45_000,
  outputDir: fileURLToPath(new URL('../../../../.tmp/session-header/results', import.meta.url)),
  reporter: [['line'], ['json', { outputFile: fileURLToPath(new URL('../../../../.tmp/session-header/results.json', import.meta.url)) }]],
  use: { channel: 'chromium', baseURL: 'http://127.0.0.1:4298', viewport: { width: 1360, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure',
    ...(executable === undefined ? {} : { launchOptions: { executablePath: executable } }), },
  webServer: { command: 'pnpm exec vite build --outDir ../../.tmp/session-header/app --emptyOutDir && pnpm exec vite preview --outDir ../../.tmp/session-header/app --port 4298 --strictPort', cwd: root, url: 'http://127.0.0.1:4298/projects', reuseExistingServer: false, timeout: 120_000 },
});
