import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/setup-guide.browser.ts', workers: 1, retries: 0, timeout: 60_000, globalTimeout: 180_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/setup-guide-results', import.meta.url)),
  use: { ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), viewport: { width: 1440, height: 900 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build && pnpm exec vite preview --host 127.0.0.1 --port 4210 --strictPort', cwd: root, url: 'http://127.0.0.1:4210/setup', reuseExistingServer: false, timeout: 90_000 },
});
