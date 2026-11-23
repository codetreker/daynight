import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/management-heading.browser.ts', workers: 1, retries: 0,
  timeout: 60_000, globalTimeout: 360_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/management-heading-results', import.meta.url)),
  use: {
    baseURL: 'http://127.0.0.1:14389', viewport: { width: 320, height: 900 }, locale: 'en-US', hasTouch: true,
    screenshot: 'only-on-failure', trace: 'retain-on-failure',
    ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }),
  },
  webServer: {
    command: 'pnpm exec vite build --config tests/navigation/management-heading-vite.config.ts && pnpm exec vite preview --config tests/navigation/management-heading-vite.config.ts',
    cwd: root, url: 'http://127.0.0.1:14389/account', reuseExistingServer: false, timeout: 120_000,
  },
});
