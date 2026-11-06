import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/claim-reading.browser.ts', workers: 1, retries: 0, timeout: 60_000, globalTimeout: 360_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/claim-reading-results', import.meta.url)),
  use: { channel: 'chromium', ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), baseURL: 'http://127.0.0.1:4205', viewport: { width: 1440, height: 1000 }, locale: 'en-US', screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/claim-reading-vite.config.ts && pnpm exec vite preview --config tests/navigation/claim-reading-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4205/projects', reuseExistingServer: false, timeout: 90_000 },
});
