import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/public-auth-typography.browser.ts', workers: 1, retries: 0,
  timeout: 60_000, globalTimeout: 300_000, reporter: 'line',
  projects: [{ name: 'fine' }, { name: 'coarse', use: { hasTouch: true } }],
  outputDir: fileURLToPath(new URL('../../../../.tmp/public-auth-typography-results', import.meta.url)),
  use: {
    ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }),
    baseURL: 'http://127.0.0.1:4211', viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm exec vite build --config tests/navigation/public-auth-typography-vite.config.ts && pnpm exec vite preview --config tests/navigation/public-auth-typography-vite.config.ts',
    cwd: root, url: 'http://127.0.0.1:4211', reuseExistingServer: false, timeout: 90_000,
  },
});
