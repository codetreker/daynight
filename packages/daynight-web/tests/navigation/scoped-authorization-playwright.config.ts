import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';
const root = fileURLToPath(new URL('../..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '**/scoped-authorization.browser.ts', workers: 1, retries: 0, timeout: 45_000, globalTimeout: 300_000, reporter: 'line',
  outputDir: fileURLToPath(new URL('../../../../.tmp/scoped-authorization-results', import.meta.url)),
  use: { ...(process.env.DAYNIGHT_BROWSER_EXECUTABLE === undefined ? {} : { launchOptions: { executablePath: process.env.DAYNIGHT_BROWSER_EXECUTABLE } }), baseURL: 'http://127.0.0.1:4258', viewport: { width: 320, height: 800 }, screenshot: 'only-on-failure' },
  webServer: { command: 'pnpm exec vite build --config tests/navigation/scoped-authorization-vite.config.ts && pnpm exec vite preview --config tests/navigation/scoped-authorization-vite.config.ts', cwd: root, url: 'http://127.0.0.1:4258/tests/navigation/scoped-authorization.html', reuseExistingServer: false, timeout: 90_000 },
});
